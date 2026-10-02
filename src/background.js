// Service worker: screenshots the tab, crops to the stream video, asks
// Claude to identify the card, then looks up its market price.
// Built with esbuild into extension/background.js (npm run build).

import { identifyCard, describeApiError, MODEL } from "./claude.js";
import { searchCards, parseTitle, setPriceApiKey } from "./prices.js";

const MAX_EDGE = 1568;

async function getApiKey() {
  const { anthropicApiKey } = await chrome.storage.local.get("anthropicApiKey");
  return (anthropicApiKey || "").trim();
}

async function loadPriceApiKey() {
  const { pokemontcgApiKey } = await chrome.storage.local.get("pokemontcgApiKey");
  setPriceApiKey(pokemontcgApiKey);
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  });
}

// rect is in CSS pixels; the screenshot is in device pixels.
async function captureFrame(windowId, rect, dpr) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const full = await createImageBitmap(await (await fetch(dataUrl)).blob());

  let sx = 0, sy = 0, sw = full.width, sh = full.height;
  if (rect && rect.width > 40 && rect.height > 40) {
    sx = Math.max(0, Math.round(rect.left * dpr));
    sy = Math.max(0, Math.round(rect.top * dpr));
    sw = Math.min(full.width - sx, Math.round(rect.width * dpr));
    sh = Math.min(full.height - sy, Math.round(rect.height * dpr));
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(outW, outH);
  canvas.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, outW, outH);
  full.close();

  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return blobToBase64(jpeg);
}

async function handle(msg, sender) {
  await loadPriceApiKey();
  switch (msg.type) {
    case "captureFrame": {
      const image = await captureFrame(sender.tab.windowId, msg.rect, msg.dpr || 1);
      return { ok: true, image };
    }
    case "identifyAndPrice": {
      const apiKey = await getApiKey();
      if (!apiKey) return { ok: false, needsKey: true, error: "Add your Anthropic API key in ⚙ settings first." };
      let card;
      try {
        card = await identifyCard(apiKey, msg.image, msg.hint || "");
      } catch (err) {
        return { ok: false, error: describeApiError(err) };
      }
      if (!card.card_visible || !card.name) return { ok: true, card, cards: [] };
      try {
        const result = await searchCards({
          name: card.name,
          number: card.number,
          setTotal: card.set_total,
          setName: card.set_name,
        });
        return { ok: true, card, cards: result.cards };
      } catch (err) {
        return { ok: true, card, cards: [], priceError: String(err.message || err) };
      }
    }
    case "searchText": {
      const parsed = parseTitle(msg.text);
      if (!parsed.name) return { ok: false, error: "Couldn't find a card name in that text." };
      const result = await searchCards(parsed);
      return { ok: true, parsed, cards: result.cards };
    }
    case "getSettings": {
      const key = await getApiKey();
      return { ok: true, hasKey: !!key, model: MODEL };
    }
    case "saveApiKey": {
      await chrome.storage.local.set({ anthropicApiKey: (msg.key || "").trim() });
      return { ok: true };
    }
    case "savePriceApiKey": {
      await chrome.storage.local.set({ pokemontcgApiKey: (msg.key || "").trim() });
      return { ok: true };
    }
  }
  return { ok: false, error: "Unknown request" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true;
});
