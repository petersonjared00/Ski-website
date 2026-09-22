# One-Off Ski Works: starter site

Ski customizer with AI topsheet art from OpenAI's image API. The browser talks only to
this server; the server holds the API key, checks prompts, caps spend, and saves designs.

## Run it

1. Install Node 18 or newer.
2. Get an OpenAI API key at platform.openai.com (API billing is separate from a ChatGPT
   subscription). OpenAI may ask you to verify your organization before image models work.
3. In this folder:

       cp .env.example .env      # then paste your key into .env
       npm install
       npm start

4. Open http://localhost:3000

## What's here

- `server.js`: `/api/generate`, `/api/refine`, `/api/orders`, plus daily limits.
- `public/index.html`: the customizer. Shop patterns work with no API calls.
- `designs/`: every generated PNG plus the prompt that made it (created on first run).
- `orders/`: each build request as a JSON file (created on first run).
- `tools/ski_strip.py`: crop, stitch and lay out the 16 x 80 in print sheet.

## How the art fits a ski

The API's widest image is 3:1 and a ski is about 10:1, so the prompt keeps the subject
in the middle band and the site crops top and bottom. At the default 2544x848 that
leaves a strip about 2544x254 px: fine for preview, too small for print.
For a paid order, regenerate or upscale before printing:
`python tools/ski_strip.py crop designs/<id>.png strip.png`, upscale about 6x,
then `python tools/ski_strip.py sheet strip.png sheet.tif --mirror --cmyk`.

## Settings worth knowing (.env)

- `IMAGE_QUALITY`: low is under a cent per image, high can be around 20 cents. Start at medium.
- `PER_VISITOR_DAILY_LIMIT` and `GLOBAL_DAILY_LIMIT`: your protection against a surprise bill.
  Also set a hard monthly budget in the OpenAI dashboard.
- `IMAGE_MODEL`: swap in a newer image model name without touching code.

## Before taking real orders

- Move limits, designs and orders into a database and file storage (Supabase works).
- Add Stripe Checkout in `/api/orders` for the deposit.
- Email yourself each order and approve art by hand: no logos, characters or brands you can't print.
- Replace the placeholder name, prices, cores and lead time in `public/index.html`.
