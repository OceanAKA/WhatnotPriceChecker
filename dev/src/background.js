// Service worker: screenshots the tab, crops to the stream video, asks an AI
// to identify the card, then looks up its market price.
// Built with esbuild into ../background.js (cd dev && npm run build).
//
// AI modes:
//   auto   - Chrome's on-device model when this computer supports it, otherwise
//            the hosted card-ID service. The user needs no key. (default)
//   gemini - the user's own Gemini API key
//   claude - the user's own Anthropic API key

import { identifyCard, describeApiError } from "./claude.js";
import { identifyCardGemini } from "./gemini.js";
import { identifyCardOnDevice, onDeviceStatus, warmUpOnDevice } from "./ondevice.js";
import { identifyCardViaService, serviceConfigured, gradedViaService } from "./service.js";
import { parseGrade, fetchGradedCard, pickGradedPrice, ebaySoldUrl } from "./graded.js";
import { searchCards, parseTitle, setPriceApiKey } from "./prices.js";
import { setTcgcsvBase, normalizeNumber } from "./tcgcsv.js";
import { SERVICE_URL } from "./config.js";

const MAX_EDGE = 1568;

if (serviceConfigured()) setTcgcsvBase(`${SERVICE_URL.replace(/\/$/, "")}/tcgcsv`);
const MODES = ["auto", "gemini", "claude"];

async function getSettings() {
  const s = await chrome.storage.local.get(["mode", "provider", "geminiApiKey", "anthropicApiKey"]);
  // v2 stored the chosen key provider as "provider"; keep honoring it until the user saves a mode.
  const mode = s.mode || s.provider;
  return {
    mode: MODES.includes(mode) ? mode : "auto",
    geminiKey: (s.geminiApiKey || "").trim(),
    claudeKey: (s.anthropicApiKey || "").trim(),
  };
}

async function getInstallId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

class NeedsSetupError extends Error {}

const ON_DEVICE_PROBLEM = {
  unsupported:
    "This browser doesn't include Chrome's built-in AI (Brave, Edge, and other Chromium browsers leave it out). Use Google Chrome, or add a free Gemini key in Settings.",
  downloadable: "Chrome's on-device AI needs a one-time download. Start it in Settings.",
  downloading: "Chrome is still downloading its on-device AI. Try again in a few minutes.",
  unavailable:
    "This computer doesn't meet Chrome's requirements for on-device AI. Add a free Gemini key in Settings instead.",
};

async function identifyAuto(image, hint) {
  let onDeviceError = null;
  const status = await onDeviceStatus();
  if (status === "available") {
    try {
      const card = await identifyCardOnDevice(image, hint);
      // The small on-device model is the cheap first try; let the bigger cloud model take unsure frames.
      if (!(card.card_visible && card.confidence === "low") || !serviceConfigured()) return card;
    } catch (e) {
      onDeviceError = e;
    }
  }
  if (serviceConfigured()) return identifyCardViaService(image, hint, await getInstallId());
  if (onDeviceError) throw onDeviceError;
  throw new NeedsSetupError(ON_DEVICE_PROBLEM[status] || ON_DEVICE_PROBLEM.unavailable);
}

async function identify(image, hint) {
  const { mode, geminiKey, claudeKey } = await getSettings();
  if (mode === "gemini") {
    if (!geminiKey) throw new NeedsSetupError("Add your Gemini API key in Settings first.");
    return identifyCardGemini(geminiKey, image, hint);
  }
  if (mode === "claude") {
    if (!claudeKey) throw new NeedsSetupError("Add your Anthropic API key in Settings first.");
    try {
      return await identifyCard(claudeKey, image, hint);
    } catch (err) {
      throw new Error(describeApiError(err));
    }
  }
  return identifyAuto(image, hint);
}

// Graded price for the slab the AI read, attached to the best-matching card.
/**
 * Graded price for the slab the AI read, attached to the best-matching card.
 * With lookup=false (every scan) only a cached price is returned, so scans cost
 * no API credits; the panel offers a "tap for price" button instead.
 */
async function gradedFor(card, top, { lookup = false } = {}) {
  const grade = parseGrade(card.grade_label);
  if (!grade || !top) return null;
  const out = { label: grade.label, ebayUrl: ebaySoldUrl(top.name, top.number, grade.label), price: null, count: null };
  if (!top.productId) return out;
  // A graded price for the wrong printing is worse than none: only look it up
  // when the top result is the exact number read off the slab.
  const read = card.number_legible !== false ? normalizeNumber(card.number) : "";
  if (!read || normalizeNumber(top.number) !== read) {
    out.reason = read ? "exact printing not found; check the list below" : "couldn't read the number";
    return out;
  }
  const { pptApiKey } = await chrome.storage.local.get("pptApiKey");
  const key = (pptApiKey || "").trim();
  const cached = await gradedCacheGet(top.productId, grade.key);
  if (cached) return Object.assign(out, cached);
  if (!key && !serviceConfigured()) {
    out.reason = "add a PokemonPriceTracker key in Settings for graded prices";
    return out;
  }
  if (!lookup) {
    out.canLoad = true;
    return out;
  }
  try {
    if (key) {
      await chrome.storage.local.set({
        lastGradedLookup: { productId: top.productId, grade: grade.label, card: `${top.name} #${top.number}` },
      });
      const { pptExhaustedUntil = 0 } = await chrome.storage.local.get("pptExhaustedUntil");
      if (Date.now() < pptExhaustedUntil) {
        out.reason = `PokemonPriceTracker daily limit reached (resets ${new Date(pptExhaustedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
        return out;
      }
      const pptCard = await fetchGradedCard(key, top.productId);
      const hit = pickGradedPrice(pptCard, grade.key);
      if (hit) Object.assign(out, hit);
      else out.reason = gradedMissingReason(pptCard);
      await gradedCachePut(top.productId, grade.key, hit ? hit : { reason: out.reason });
    } else {
      const hit = await gradedViaService(top.productId, grade.key, await getInstallId());
      if (hit) Object.assign(out, hit);
      else out.reason = "no graded sales found";
      await gradedCachePut(top.productId, grade.key, hit ? hit : { reason: out.reason });
    }
  } catch (e) {
    out.reason = gradedErrorReason(e);
    if (e && e.status === 429) {
      // Free credits reset at midnight UTC; don't spend calls that will fail until then.
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      await chrome.storage.local.set({ pptExhaustedUntil: reset.getTime() });
      out.reason = `PokemonPriceTracker daily limit reached (resets ${reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
    }
  }
  return out;
}

// Graded prices, remembered for a day so re-showing a slab costs no API credits.
const GRADED_TTL_MS = 24 * 60 * 60 * 1000;
const GRADED_CACHE_MAX = 300;

async function gradedCacheGet(productId, gradeKey) {
  const { gradedCache = {} } = await chrome.storage.local.get("gradedCache");
  const hit = gradedCache[`${productId}|${gradeKey}`];
  return hit && Date.now() - hit.at < GRADED_TTL_MS ? hit.value : null;
}

async function gradedCachePut(productId, gradeKey, value) {
  const { gradedCache = {} } = await chrome.storage.local.get("gradedCache");
  gradedCache[`${productId}|${gradeKey}`] = { at: Date.now(), value };
  const keys = Object.keys(gradedCache);
  if (keys.length > GRADED_CACHE_MAX) {
    keys.sort((a, b) => gradedCache[a].at - gradedCache[b].at);
    for (const k of keys.slice(0, keys.length - GRADED_CACHE_MAX)) delete gradedCache[k];
  }
  await chrome.storage.local.set({ gradedCache });
}

// Short, user-facing reasons a graded price is missing (shown under the grade).
function gradedMissingReason(pptCard) {
  if (!pptCard) return "card not on PokemonPriceTracker";
  if (!pptCard.ebay) return "no graded data from PokemonPriceTracker (may need a paid plan)";
  return "no recent sales at this grade";
}

function gradedErrorReason(e) {
  if (e && (e.status === 401 || e.status === 403)) return "PokemonPriceTracker rejected the key";
  if (e && e.status === 402) return "graded prices need a paid PokemonPriceTracker plan";
  if (e && e.status === 429) return "PokemonPriceTracker daily limit reached";
  return "graded price lookup failed";
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
      // Fallback for streams whose video pixels can't be read directly.
      try {
        const image = await captureFrame(sender.tab.windowId, msg.rect, msg.dpr || 1);
        return { ok: true, image };
      } catch {
        return { ok: false, error: "this stream's video can't be read. Try reloading the page." };
      }
    }
    case "identify": {
      try {
        return { ok: true, card: await identify(msg.image, msg.hint || "") };
      } catch (err) {
        return { ok: false, needsSetup: err instanceof NeedsSetupError, error: String(err.message || err) };
      }
    }
    case "price": {
      const card = msg.card;
      let result;
      try {
        // An unreadable number is a guess; price by name and set instead and list every printing.
        const numberOk = card.number_legible !== false;
        result = await searchCards({
          name: card.name,
          number: numberOk ? card.number : "",
          setTotal: card.set_total,
          setName: card.set_name,
          setCode: card.set_code,
          language: card.language,
        });
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
      const graded = card.graded ? await gradedFor(card, result.cards[0]) : null;
      return { ok: true, cards: result.cards, cached: !!result.cached, priceLanguage: result.language || "English", graded };
    }
    case "graded": {
      return { ok: true, graded: await gradedFor(msg.card, msg.top, { lookup: true }) };
    }
    case "warmUp": {
      const { mode } = await getSettings();
      return { ok: true, warmed: mode === "auto" && (await warmUpOnDevice().catch(() => false)) };
    }
    case "searchText": {
      const parsed = parseTitle(msg.text);
      if (!parsed.name) return { ok: false, error: "Couldn't find a card name in that text." };
      const result = await searchCards(parsed);
      return { ok: true, parsed, cards: result.cards };
    }
    case "getSettings": {
      const { mode, geminiKey, claudeKey } = await getSettings();
      const onDevice = await onDeviceStatus();
      const ready =
        mode === "gemini" ? !!geminiKey : mode === "claude" ? !!claudeKey : onDevice === "available" || serviceConfigured();
      return { ok: true, mode, ready, onDevice, service: serviceConfigured() };
    }
    case "openOptions": {
      await chrome.runtime.openOptionsPage();
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

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
