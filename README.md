# Whatnot Pokemon Card Price Checker

A Chrome extension that looks at the Whatnot stream with AI, works out which
Pokemon card the seller is holding up, and shows its market price, so you can
tell whether the current bid is a deal.

Whatnot listing titles are usually generic ("$1 Starting Card On Screen"), so
the extension doesn't rely on them. It reads the card from the video itself.

## How it works

1. **📷 Scan** screenshots the tab and crops it to the stream video.
2. The frame goes to Claude (`claude-opus-5-5`, vision), which reads the card
   name, collector number (e.g. 199/165), set, language, and whether it's in a
   grading slab.
3. The card is looked up on the free [Pokemon TCG API](https://pokemontcg.io)
   for daily **TCGPlayer** market / low / high prices per printing, plus the
   **Cardmarket** trend price.

The panel shows a thumbnail of exactly what the AI saw, what it identified,
and how confident it is, so you can sanity-check it.

## Install

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select the **`extension`** folder inside this
   folder (not the top-level folder). If you loaded the old version, remove it
   first.
4. Open a Whatnot stream. The **💰 Card Prices** panel appears bottom-right.
5. Paste your Anthropic API key into the ⚙ settings box and hit Save.
   Get one at https://console.anthropic.com → API Keys. It's stored only in
   your browser's extension storage.

## Use

- **📷 Scan card on stream**: press it while the seller is showing a card.
- **auto-scan**: scans every 30 seconds while the tab is visible and only
  refreshes the prices when the card changes.
- **Search box**: type or paste a card (`charizard ex 199/165`) to price it
  without AI.
- Drag the panel by its header; `–` collapses it.

## Cost

Each scan is one Claude API call with one image, roughly **$0.01**.
Auto-scan at 30-second intervals is about **$1.20 per hour** of watching.

## Caveats

- Prices are for **raw (ungraded)** cards. If the AI sees a slab it warns you;
  graded cards sell well above raw market.
- The price database covers **English** cards. For Japanese cards, the English
  printing's price is shown, with a warning.
- The free price API is sometimes flaky (502 errors). The extension retries
  automatically; a free key from https://dev.pokemontcg.io (⚙ settings) makes
  it steadier.
- Reading the number depends on the stream: a blurry or far-away card may
  only get a name-level match (medium/low confidence). Scan again when the
  seller holds it closer.

## Development

The background worker bundles the Anthropic SDK, so after editing `src/`:

```
npm install
npm run build        # writes extension/background.js
node test/prices.test.js   # live price-matching check
node test/claude.test.js   # request-shape check (no API spend)
```

Then click the reload icon on the extension in `chrome://extensions`.
