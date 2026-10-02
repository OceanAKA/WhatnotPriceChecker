# Card Price Checker for Whatnot

A Chrome extension that reads the Pokémon card a seller is holding up on a
Whatnot live stream and shows its market price, so you can tell in seconds
whether the current bid is a deal.

**[Add to Chrome from the Chrome Web Store](https://chromewebstore.google.com/detail/ipnheelahlheggemeckmlbckkbfpjboh)** · or
[download the latest release](https://github.com/OceanAKA/WhatnotPriceChecker/releases/latest)

## What it does

- Adds a floating **Card Prices** panel to Whatnot stream pages.
- One click captures the live video frame and uses an AI vision model to
  identify the exact card: name, collector number, set, language, and whether
  it is in a grading slab.
- **No API key needed:** it runs Chrome's built-in on-device AI when the
  computer supports it and falls back to a hosted card-ID service otherwise.
  Power users can plug in their own Gemini or Claude key instead.
- Shows current TCGplayer market/low/high prices for each printing, for
  English **and Japanese** cards, with a direct TCGplayer link.
- For slabbed cards, shows the price for that exact grade (for example
  CGC 10 or PSA 9) from recent eBay sales: the average, how many sold, and the
  last sale with its date.
- Shows a thumbnail of exactly what the AI saw and how confident it was, and
  warns when the price may not apply (graded slabs, non-English cards).
- **Auto-scan** watches the video and scans whenever a new card is held up
  to the camera, plus a plain text search that works without any AI.

## Tech stack

- **JavaScript (ES modules)**, no framework
- **Chrome Extension Manifest V3**: background service worker, content script,
  `chrome.tabs.captureVisibleTab`, `chrome.storage.local`, `OffscreenCanvas`
- **Chrome built-in AI** (Prompt API / Gemini Nano) for free on-device image
  recognition, with a JSON-schema response constraint
- **Cloudflare Workers** for the hosted card-ID service, with per-install and
  per-IP rate limiting
- **Google Gemini API** via plain `fetch` (REST), with a JSON response schema
- **Anthropic Claude API** via the official `@anthropic-ai/sdk`, using
  structured JSON-schema output
- **TCGCSV** (daily TCGplayer price files) for current English and Japanese
  prices, relayed and cached by the Worker
- **Pokémon TCG API** (pokemontcg.io) as a card-identity fallback
- **PokemonPriceTracker API** for graded (PSA / CGC / BGS) prices
- **esbuild** to bundle the service worker; small Node.js test scripts

## How it works

Whatnot listing titles are usually generic ("$1 Starting Card On Screen")
because sellers run hundreds of cards through one listing, so the extension
ignores the title and reads the card from the video itself.

1. **Find the stream.** The content script (injected on whatnot.com) finds the
   largest visible `<video>` element.
2. **Capture the frame.** It draws the current video frame onto a canvas at
   the stream's own resolution, which is often several times sharper than the
   on-screen player; the small collector number is what decides the exact
   printing. If the browser won't expose the video's pixels, it falls back to
   a tab screenshot cropped to the player.

   With **auto-scan** on, a small grayscale copy of the video is sampled four
   times a second and compared with a running average of recent samples, so
   the sparkle and flashing of holo and full-art cards average out while a new
   card shifts the average. A scan fires when the averaged picture differs from
   the one at the last scan and has stopped moving for about a second. The AI
   reports whether it is looking at a card's front, its back, or nothing; backs
   and empty frames are ignored so the last real card stays on screen, and the
   same card shown again isn't re-priced.
3. **Identify the card.** Every model gets the same system prompt and a JSON
   schema that forces a fixed answer shape (`card_visible`, `name`, `number`,
   `set_total`, `set_name`, `language`, `graded`, `grade_label`, `confidence`,
   `number_legible`). The model must say whether it actually read the
   collector number; if not, the number is ignored and every printing of that
   card in the set is listed instead of a confidently wrong one.
   In the default **Automatic** mode:
   - **On-device first:** if Chrome's built-in model is available, the frame
     is analyzed locally. It's free and the image never leaves the computer.
   - **Hosted fallback:** if the computer can't run it, or the small model
     reports low confidence, the frame goes to the card-ID service
     (`server/worker.js`), a Cloudflare Worker that calls Gemini with the
     project's key behind per-install and per-IP rate limits.
   - **Gemini model choice:** the Gemini code lists the models the key can
     access, picks the newest stable Flash model, and if one model's free
     quota is used up (HTTP 429) it puts that model on a 10-minute cooldown
     and tries the next.

   Users can instead pick **their own Gemini key** (same Gemini code, called
   from the browser) or **their own Claude key** (one Messages API call
   through the Anthropic SDK with structured output and low reasoning
   effort).
4. **Look up the price.** The model also reads the printed set code ("MEW",
   "SV2a"), which is exactly TCGplayer's set abbreviation. With a set and a
   collector number, the card is matched straight in TCGCSV's daily TCGplayer
   data (the Japanese catalog for Japanese cards), usually in under half a
   second. Otherwise the Pokémon TCG API identifies the card with
   progressively looser queries, results are ranked with an exact
   collector-number match first, and TCGCSV supplies the current price
   (pokemontcg.io no longer has prices for new sets). Sets are matched across
   the two sources by release date and name. If the card's name isn't in the
   set the model read (small Japanese set codes are often misread), every set
   from the last two years is searched by name and ranked by number. Results
   list the exact printing first, then the card's other printings. Lookups are
   cached for six hours.
   For a slabbed card, the grade on the label ("CGC 10") is looked up by
   TCGplayer product ID for recent eBay sale prices.
5. **Show the result.** The panel displays the frame thumbnail, the
   identification and confidence, and the prices. With auto-scan on, it only
   re-renders when the card actually changes.

The content script and the service worker talk through Chrome message passing.
All API calls happen in the service worker, which is why it is bundled with
esbuild: an MV3 service worker cannot import npm packages directly.

## Quick start

Requires Google Chrome. The easiest way is to install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/ipnheelahlheggemeckmlbckkbfpjboh). To load it from source instead (Node.js is only
needed if you change the code; `background.js` is already built and committed):

1. Download `whatnot-price-checker-*.zip` from the
   [latest release](https://github.com/OceanAKA/WhatnotPriceChecker/releases/latest)
   and unzip it (or clone this repo).
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click
   **Load unpacked**, and select the unzipped folder (or the repo folder),
   the one containing `manifest.json`.
3. Open a Whatnot stream. The **Card Prices** panel appears in the bottom
   right.
4. The Settings page opens on install (or click the gear ⚙ in the panel).
   **Automatic** mode needs no key. If it shows "Not downloaded yet" next to
   On-device AI, click **Download on-device AI** once.
   - To use your own key instead, pick **My own Gemini key** (free at
     https://aistudio.google.com) or **My own Claude key** (paid, from
     https://console.anthropic.com).

   Keys are saved only in the extension's local storage (`chrome.storage.local`)
   in your browser and are sent only to the provider you selected.
5. Press **Scan card on stream** while the seller shows a card.

To run the hosted card-ID service yourself (for computers without on-device
AI), see [server/README.md](server/README.md).

To rebuild after editing `dev/src/` and run the tests:

```
cd dev
npm install
npm run build        # bundles src/ into ../background.js
npm test             # offline checks: Claude, Gemini, on-device routing, card-ID service
npm run test:prices  # live check against the Pokémon TCG API
npm run package      # zip for the Chrome Web Store -> dev/dist/
```

Then delete `dev/node_modules` and click the reload icon on the extension in
`chrome://extensions`. (Chrome refuses to load a folder containing file names
that start with `_`, and a few npm packages include them.)

**Costs and disclaimer.** AI usage is billed to (or counted against the free
quota of) your own API key. This is an independent personal project and is not
affiliated with or endorsed by Whatnot, The Pokémon Company, Nintendo,
TCGPlayer, or Cardmarket. Prices are informational only.

## How I built it

Built with Claude Code (Anthropic's AI coding agent): I designed the feature,
directed the implementation, and tested it on live Whatnot streams.

## Technical details

### Using the panel

- **Scan card on stream**: press it while the seller is showing a card.
- **auto-scan**: scans every 30 seconds while the tab is visible and only
  refreshes the prices when the card changes.
- **Search box**: type or paste a card (`charizard ex 199/165`) to price it
  without AI.
- Drag the panel by its header; `–` collapses it.

### Cost

- **Automatic mode: free for users.** On-device AI costs nothing. The hosted
  service uses the project's Gemini key, so its free quota is shared by
  everyone; when it runs out, users are told to try later or add their own
  key.
- **Own Gemini key: free.** The free tier has per-minute and per-day request limits
  (see yours at https://aistudio.google.com/rate-limit). Scanning by hand
  stays well inside them; long auto-scan sessions (120 scans an hour) may hit
  the daily limit, and the panel tells you when that happens. Google may use
  free-tier requests to improve its products.
- **Claude** (`claude-opus-5-5`): roughly **$0.01** per scan, about
  **$1.20 per hour** with auto-scan. Most accurate at reading blurry or angled
  cards.
- Price lookups and typed searches are always free.

### Caveats

- **On-device AI needs Google Chrome.** Brave, Edge, and other Chromium
  browsers can run the extension but don't include Chrome's built-in model,
  so they use the card-ID service or your own key instead.
- Prices are for **raw (ungraded)** cards. If the AI sees a slab it warns you;
  graded cards sell well above raw market.
- The price database covers **English** cards. For Japanese cards, the English
  printing's price is shown, with a warning.
- The free price API is sometimes flaky (502 errors). The extension retries
  automatically; a free key from https://dev.pokemontcg.io (in settings) makes
  it steadier.
- Reading the number depends on the stream: a blurry or far-away card may
  only get a name-level match (medium/low confidence). Scan again when the
  seller holds it closer.

### Project layout

```
manifest.json       the repo root is the unpacked extension Chrome loads
background.js       esbuild output of dev/src/ (do not edit by hand)
content.js          the on-page panel
content.css
options.html        settings page (+ options.js, options.css)
PRIVACY.md          privacy policy (needed for the Chrome Web Store)
server/
  worker.js         Cloudflare Worker: hosted card-ID service
  wrangler.toml     Worker config + rate limits
dev/
  src/background.js service worker source: capture, crop, routing, settings
  src/prompt.js     shared system prompt + JSON schema for every AI model
  src/claude.js     Claude call via @anthropic-ai/sdk
  src/gemini.js     Gemini REST call, model picking, quota fallback
  src/ondevice.js   Chrome built-in AI (Prompt API) call
  src/service.js    client for the hosted card-ID service
  src/config.js     URL of the deployed card-ID service
  src/prices.js     Pokémon TCG API search, ranking, title parsing
  test/             Node scripts; AI and service tests stub their APIs, prices hits the live API
  scripts/package.mjs  builds the Chrome Web Store zip
  package.json      build, test, and package scripts
```

## License

MIT, see [LICENSE](LICENSE).
