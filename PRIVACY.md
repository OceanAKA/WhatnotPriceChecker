# Privacy Policy: Card Price Checker for Whatnot

_Last updated: October 1, 2026_

This extension helps you look up the market price of a Pokémon card shown on
a Whatnot live stream. It has no accounts, no analytics, and no ads.

## What the extension accesses

- **A screenshot of the stream video, only when you press Scan** (or when you
  turn on auto-scan, every 30 seconds while the Whatnot tab is visible). The
  screenshot is cropped to the video player.
- **Text on the Whatnot page** near the listing title, used only as a hint for
  identifying the card.

## Where that data goes

Depending on the card-recognition mode you choose in Settings:

- **On-device AI (Automatic mode, when your computer supports it):** the
  screenshot is analyzed by Chrome's built-in model on your computer and never
  leaves it.
- **Card-ID service (Automatic mode otherwise):** the screenshot, the page
  hint, and a random install ID are sent to the extension's card-ID service
  (a Cloudflare Worker), which forwards the screenshot and hint to Google's
  Gemini API to identify the card. The install ID is used only for rate
  limiting. The service does not store screenshots, hints, or IDs.
- **Your own Gemini or Claude key:** the screenshot and hint are sent directly
  from your browser to Google (Gemini API) or Anthropic (Claude API) under your
  own account and those providers' terms.

To find prices, the identified card's name, number, and set are looked up on
the Pokémon TCG API (pokemontcg.io) and TCGCSV (TCGplayer price data, through
the card-ID service). For graded cards, the card's TCGplayer product ID is sent
to PokemonPriceTracker for graded sale prices.

Google's free Gemini API tier may use requests to improve Google's products.
See Google's Gemini API terms for details.

## What is stored

API keys you enter, your settings, and the random install ID are stored only in
your browser's extension storage (`chrome.storage.local`). Uninstalling the
extension deletes them.

## What we don't do

We don't sell or share your data, don't track your browsing, and don't access
any site other than Whatnot (for the panel and screenshots) and the services
listed above.

## Contact

Questions: open an issue at https://github.com/OceanAKA/WhatnotPriceChecker.
