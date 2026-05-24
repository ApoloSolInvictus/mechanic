# Infiniti Pits

Static Infiniti Pits web app with a Vercel serverless backend at `/api/chat`.

## Deploy on Vercel

1. Import this GitHub repository into Vercel.
2. In Project Settings > Environment Variables, add:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (default: `gpt-5.4-mini`)
   - `OPENAI_MAX_OUTPUT_TOKENS` (default: `1400`)
   - `ALLOWED_ORIGINS` (example: `https://pits.infiniti-ia.com`)
   - `IMAGE_SEARCH_ENABLED` (default: `true`)
   - `IMAGE_SEARCH_PROVIDER` (default: `auto`)
   - `IMAGE_SEARCH_COUNT` (default: `3`)
3. Deploy the project.
4. Point `pits.infiniti-ia.com` to the Vercel project domain.

The frontend calls `/api/chat`, so the HTML and backend should be served from the same Vercel deployment. If the static site stays on a different host, define `window.INFINITI_PITS_API_URL` before the app scripts load and point it to the Vercel API URL.

## Image Search

The chat backend can return visual references with each technical answer. In `auto` mode it tries Google Programmable Search first when `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID` exist, then falls back to Openverse and Wikimedia Commons.

Optional Google image search variables:

- `GOOGLE_SEARCH_API_KEY`
- `GOOGLE_SEARCH_ENGINE_ID`
- `GOOGLE_IMAGE_RIGHTS` (example: `cc_publicdomain,cc_attribute,cc_sharealike`)
