# Card-ID service

A Cloudflare Worker that identifies the card in a stream frame using your
Gemini API key, so people who install the extension don't need a key of
their own. The extension only calls it when Chrome's on-device AI isn't
available (or isn't sure about a frame).

| Endpoint | Purpose |
| --- | --- |
| `POST /identify` `{image, hint, installId}` → `{card}` | Reads the card with Gemini (your `GEMINI_API_KEY`) |
| `POST /graded` `{tcgPlayerId, grade, installId}` → `{graded}` | PSA / CGC / BGS price from PokemonPriceTracker (your `PPT_API_KEY`), cached 24 h per card |
| `GET /tcgcsv/<category>/...` | Cached relay of TCGCSV's TCGplayer price files. TCGCSV is meant for server-side use, so the public extension goes through here: the Worker identifies itself and Cloudflare caches each file for 12 h |

## Protection

- **Rate limits:** 6 scans per minute per install and 20 per minute per IP
  address, plus 60 price-file requests per minute per IP (Cloudflare's
  rate-limit binding, set in `wrangler.toml`).
- **Origin check:** set `ALLOWED_ORIGINS` to your extension's origin so other
  websites can't call the service from a browser.
- **Input checks:** image size and format, install ID format, hint length.
- **Spending cap:** the real ceiling is your Gemini quota. On the free tier,
  Google simply returns "quota exceeded" and the extension tells users to try
  later or add their own key. If you move to a paid Gemini tier, set a budget
  alert in Google Cloud Billing.

## Deploy (about 5 minutes, free)

You need a free Cloudflare account and a Gemini API key from
https://aistudio.google.com.

```
cd server
npx wrangler login                     # opens the browser to sign in to Cloudflare
npx wrangler secret put GEMINI_API_KEY  # paste your Gemini key when asked
npx wrangler secret put PPT_API_KEY     # optional: PokemonPriceTracker key for graded prices
npx wrangler deploy
```

`deploy` prints the service URL, like
`https://whatnot-card-id.<your-subdomain>.workers.dev`. Then:

1. Put that URL in `dev/src/config.js` as `SERVICE_URL`.
2. Rebuild the extension: `cd dev && npm install && npm run build`, then
   delete `dev/node_modules`.
3. Reload the extension in `chrome://extensions`. Settings should now say
   **Card-ID service: Available**.
4. Optional but recommended: copy the extension's ID from
   `chrome://extensions` and set
   `ALLOWED_ORIGINS = "chrome-extension://<that id>"` in `wrangler.toml`, then
   `npx wrangler deploy` again. The Chrome Web Store assigns a different ID
   from your unpacked copy, so add both, separated by a comma.

Check it's up: open `https://whatnot-card-id.<your-subdomain>.workers.dev/health`.
Logs: `npx wrangler tail`.
