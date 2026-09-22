// One-Off Ski Works: small backend that keeps the OpenAI key off the browser.
// Run: cp .env.example .env  ->  fill in key  ->  npm install  ->  npm start
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// tiny .env loader (no dependency)
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const KEY = process.env.OPENAI_API_KEY;
const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.IMAGE_MODEL || "gpt-image-2";
const SIZE = process.env.IMAGE_SIZE || "2544x848";
const QUALITY = process.env.IMAGE_QUALITY || "medium";
const PER_VISITOR = Number(process.env.PER_VISITOR_DAILY_LIMIT || 5);
const GLOBAL = Number(process.env.GLOBAL_DAILY_LIMIT || 150);

const DESIGNS = path.join(__dirname, "designs");
const ORDERS = path.join(__dirname, "orders");
for (const d of [DESIGNS, ORDERS]) fs.mkdirSync(d, { recursive: true });

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "4mb" })); // room for one downsized inspiration photo
app.use(express.static(path.join(__dirname, "public")));
app.use("/designs", express.static(DESIGNS, { maxAge: "1y", immutable: true }));

/* ---------- spend guards (in memory; move to a database when you deploy) ---------- */
let day = new Date().toDateString(), total = 0;
const perIp = new Map();
function allow(ip) {
  const today = new Date().toDateString();
  if (today !== day) { day = today; total = 0; perIp.clear(); }
  const used = perIp.get(ip) || 0;
  if (total >= GLOBAL) return "The design studio is at capacity for today. Try again tomorrow.";
  if (used >= PER_VISITOR) return `You have used all ${PER_VISITOR} drawings for today.`;
  perIp.set(ip, used + 1); total++;
  return null;
}
const left = (ip) => Math.max(0, PER_VISITOR - (perIp.get(ip) || 0));

/* ---------- prompt ---------- */
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
function buildPrompt({ brief, styles, colors, pair, surface, hasReference }) {
  const style = (Array.isArray(styles) ? styles : []).map((s) => clean(s, 30)).filter(Boolean).slice(0, 4).join(", ");
  const palette = Array.isArray(colors) && colors.length
    ? `Palette built around ${colors.map((c) => clean(c, 9)).slice(0, 3).join(", ")}, with tints and shades of them.`
    : "Choose a palette of 3 to 5 colors that suits the subject.";
  const cleanBrief = clean(brief, 600);
  return [
    `Ultra-wide panoramic ${style || "bold graphic"} illustration for a ski topsheet.`,
    cleanBrief
      ? `Subject: ${cleanBrief}.`
      : hasReference
      ? "Subject: exactly what is in the attached photo — do not add scenery, landscape, or any other subject beyond what the photo shows."
      : "Subject: something a skier would love.",
    pair === "spread"
      ? "This one image covers a coordinated PAIR of skis. Only the middle 60% of the image height is used, split into two equal horizontal bands: the upper band prints on ski one, the lower band on ski two. The skis must clearly belong together (shared palette and style) but do not have to match: the scene can flow across both bands, or each band can carry a different half of the idea. Keep each ski's focal subject fully inside its own band, and follow the subject description if it says what goes on each ski. The top and bottom 20% are simple background that gets cropped off."
      : "",
    surface === "base"
      ? "This is the BASE (underside) of the ski, not the topsheet: it is printed in few flat colors on white or black material, so use bold simple shapes, strong contrast, no fine detail and no photographic shading."
      : "",
    "The image fills the entire frame edge to edge — no borders, frames, margins, mockups, ski outlines, drop shadows, or text of any kind.",
    "The image is much wider than it is tall. Keep a clear margin around all four edges: nothing important in the outer ~15% on any side. Everything that matters — subjects, focal points, detail — stays comfortably inside that margin. The background (color, gradient, or texture) runs all the way to every edge and looks natural if a strip is trimmed off.",
    "Within the safe interior, detail can go anywhere along the length.",
    palette,
  ].join(" ");
}

/* ---------- OpenAI calls ---------- */
async function openai(pathname, init) {
  const r = await fetch(BASE + pathname, { ...init, headers: { Authorization: `Bearer ${KEY}`, ...(init.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body?.error?.message || `OpenAI error ${r.status}`);
    err.status = r.status; err.code = body?.error?.code;
    throw err;
  }
  return body;
}
async function flagged(text) {
  try {
    const out = await openai("/moderations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
    });
    return Boolean(out.results?.[0]?.flagged);
  } catch { return false; } // moderation outage should not take the site down; OpenAI also screens image prompts
}
function saveImage(b64, meta) {
  const id = crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(path.join(DESIGNS, `${id}.png`), Buffer.from(b64, "base64"));
  fs.writeFileSync(path.join(DESIGNS, `${id}.json`), JSON.stringify({ id, created: new Date().toISOString(), ...meta }, null, 2));
  return id;
}
function fail(res, e) {
  console.error(e.message);
  if (e.code === "moderation_blocked" || e.code === "content_policy_violation")
    return res.status(400).json({ error: "We can't draw that one. Try describing it differently." });
  if (e.status === 429) return res.status(503).json({ error: "The design studio is busy. Try again in a minute." });
  res.status(502).json({ error: "The drawing didn't come through. Try again." });
}

/* ---------- routes ---------- */
app.post("/api/generate", async (req, res) => {
  if (!KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." });
  const brief = clean(req.body.brief, 600);
  if (await flagged(brief)) return res.status(400).json({ error: "We can't draw that one. Try describing it differently." });
  const block = allow(req.ip);
  if (block) return res.status(429).json({ error: block });
  try {
    const ref = typeof req.body.reference === "string" && req.body.reference.startsWith("data:image/jpeg;base64,")
      ? Buffer.from(req.body.reference.slice(23), "base64") : null;
    if (ref && ref.length > 3e6) return res.status(400).json({ error: "That photo is too large. Try a smaller one." });
    let prompt = buildPrompt({ ...req.body, hasReference: Boolean(ref) }), out;
    if (ref) {
      // Inspiration photo: the edits endpoint takes it as a reference image.
      prompt += req.body.brief && req.body.brief.trim()
        ? " The attached photo is inspiration only: borrow its mood, palette and subject and make an original illustration. Do not copy the photo, and do not reproduce any logos, text, characters or artwork that appear in it."
        : " Base the illustration closely on the attached photo's actual subject and composition — do not invent additional scenery, landscape, or subjects that are not in the photo. Do not copy the photo exactly and do not reproduce any logos, text, characters or artwork that appear in it.";
      const form = new FormData();
      form.append("model", MODEL);
      form.append("image", new Blob([ref], { type: "image/jpeg" }), "inspiration.jpg");
      form.append("prompt", prompt);
      form.append("size", SIZE);
      form.append("quality", QUALITY);
      out = await openai("/images/edits", { method: "POST", body: form });
    } else {
      out = await openai("/images/generations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt, size: SIZE, quality: QUALITY, n: 1 }),
      });
    }
    const id = saveImage(out.data[0].b64_json, { brief, prompt, styles: req.body.styles, colors: req.body.colors, hasInspirationPhoto: Boolean(ref) });
    if (ref) fs.writeFileSync(path.join(DESIGNS, `${id}-inspiration.jpg`), ref); // kept so you can check it at order review
    res.json({ id, url: `/designs/${id}.png`, remaining: left(req.ip) });
  } catch (e) { fail(res, e); }
});

app.post("/api/refine", async (req, res) => {
  if (!KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." });
  const id = clean(req.body.id, 16), change = clean(req.body.change, 240);
  const file = path.join(DESIGNS, `${id}.png`);
  if (!/^[a-f0-9]{16}$/.test(id) || !fs.existsSync(file)) return res.status(404).json({ error: "That design was not found." });
  if (!change) return res.status(400).json({ error: "Say what to change." });
  if (await flagged(change)) return res.status(400).json({ error: "We can't make that change. Try describing it differently." });
  const block = allow(req.ip);
  if (block) return res.status(429).json({ error: block });
  try {
    const form = new FormData();
    form.append("model", MODEL);
    form.append("image", new Blob([fs.readFileSync(file)], { type: "image/png" }), "design.png");
    form.append("prompt", `${change}. Keep the same composition, style, palette and ultra-wide layout. No text, letters or logos.`);
    form.append("size", SIZE);
    form.append("quality", QUALITY);
    const out = await openai("/images/edits", { method: "POST", body: form });
    const newId = saveImage(out.data[0].b64_json, { parent: id, change });
    res.json({ id: newId, url: `/designs/${newId}.png`, remaining: left(req.ip) });
  } catch (e) { fail(res, e); }
});

app.post("/api/orders", (req, res) => {
  const email = clean(req.body.email, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email so we can reach you." });
  const id = "ORD-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const order = { id, created: new Date().toISOString(), status: "needs review", email, build: req.body.build || {}, designIds: (Array.isArray(req.body.designIds) ? req.body.designIds : []).slice(0, 2).map((d) => clean(d, 60)) };
  fs.writeFileSync(path.join(ORDERS, `${id}.json`), JSON.stringify(order, null, 2));
  console.log(`New build request ${id} from ${email}`);
  // Next: create a Stripe Checkout session for the deposit here, and email yourself the order for review.
  res.json({ id });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Ski site running at http://localhost:${port}  (model ${MODEL}, ${SIZE}, ${QUALITY})`));
