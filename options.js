const $ = (s) => document.querySelector(s);
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const currentMode = () => (modeInputs.find((r) => r.checked) || {}).value || "auto";

// Must match dev/src/ondevice.js
const OD_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

function showPanels() {
  for (const p of document.querySelectorAll(".panel")) p.hidden = p.dataset.for !== currentMode();
}
modeInputs.forEach((r) => r.addEventListener("change", showPanels));

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

async function refreshOnDevice() {
  const el = $("#od-status");
  $("#od-download").hidden = true;
  $("#od-note").hidden = true;
  if (typeof LanguageModel === "undefined") {
    setStatus(el, "Needs Google Chrome", "bad");
    $("#od-note").textContent =
      "This browser doesn't include Chrome's built-in AI (Brave, Edge, and other Chromium browsers leave it out). Open this extension in Google Chrome to use it.";
    $("#od-note").hidden = false;
    return;
  }
  let state;
  try {
    state = await LanguageModel.availability(OD_OPTIONS);
  } catch {
    state = "unavailable";
  }
  if (state === "available") setStatus(el, "Ready ✓", "good");
  else if (state === "downloading") setStatus(el, "Downloading…", "warn");
  else if (state === "downloadable") {
    setStatus(el, "Not downloaded yet", "warn");
    $("#od-download").hidden = false;
  } else {
    setStatus(el, "Not available on this computer", "bad");
    $("#od-note").textContent =
      "Chrome's on-device AI needs a graphics card with more than 4 GB of memory (or 16 GB of RAM), 22 GB of free disk space, and an up-to-date Chrome.";
    $("#od-note").hidden = false;
  }
}

$("#od-button").addEventListener("click", async () => {
  const btn = $("#od-button");
  const bar = $("#od-progress");
  btn.disabled = true;
  bar.hidden = false;
  setStatus($("#od-status"), "Downloading…", "warn");
  try {
    const session = await LanguageModel.create({
      ...OD_OPTIONS,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => (bar.value = e.loaded));
      },
    });
    session.destroy();
  } catch (e) {
    $("#msg").textContent = "Download failed: " + (e && e.message ? e.message : e);
  }
  btn.disabled = false;
  bar.hidden = true;
  refreshOnDevice();
});

async function load() {
  const s = await chrome.storage.local.get(["mode", "provider", "geminiApiKey", "anthropicApiKey", "pokemontcgApiKey", "pptApiKey"]);
  const saved = s.mode || s.provider; // "provider" is the v2 name
  const mode = ["auto", "gemini", "claude"].includes(saved) ? saved : "auto";
  modeInputs.forEach((r) => (r.checked = r.value === mode));
  showPanels();
  $("#gemini-saved").hidden = !s.geminiApiKey;
  $("#claude-saved").hidden = !s.anthropicApiKey;
  $("#price-saved").hidden = !s.pokemontcgApiKey;
  $("#ppt-saved").hidden = !s.pptApiKey;

  const bg = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (bg && bg.service) setStatus($("#svc-status"), "Available ✓", "good");
  else setStatus($("#svc-status"), "Not set up in this build", "bad");
  refreshOnDevice();
}

$("#save").addEventListener("click", async () => {
  const update = { mode: currentMode() };
  const g = $("#gemini-key").value.trim();
  const c = $("#claude-key").value.trim();
  const p = $("#price-key").value.trim();
  const t = $("#ppt-key").value.trim();
  if (g) update.geminiApiKey = g;
  if (c) update.anthropicApiKey = c;
  if (p) update.pokemontcgApiKey = p;
  if (t) update.pptApiKey = t;
  await chrome.storage.local.set(update);
  ["#gemini-key", "#claude-key", "#price-key", "#ppt-key"].forEach((id) => ($(id).value = ""));
  const bg = await chrome.runtime.sendMessage({ type: "getSettings" });
  $("#msg").textContent = bg && bg.ready
    ? "Saved. Open a Whatnot stream and press Scan."
    : "Saved, but this mode isn't ready yet. See the status above.";
  load();
});

load();

// Shows exactly what PokemonPriceTracker returns for the last graded card scanned
// (or a well-known sample card), to check what the key unlocks and what the numbers are.
const TEST_TCGPLAYER_ID = 517045;

$("#ppt-test").addEventListener("click", async () => {
  const msg = $("#ppt-test-msg");
  const out = $("#ppt-test-out");
  const typed = $("#ppt-key").value.trim();
  const { pptApiKey } = await chrome.storage.local.get("pptApiKey");
  const key = typed || (pptApiKey || "").trim();
  if (!key) {
    msg.textContent = "Paste a PokemonPriceTracker key first.";
    return;
  }
  const { lastGradedLookup } = await chrome.storage.local.get("lastGradedLookup");
  const target = lastGradedLookup || { productId: TEST_TCGPLAYER_ID, card: "Charizard ex #199/165 (sample)", grade: "" };
  msg.textContent = `Asking PokemonPriceTracker about ${target.card}…`;
  out.hidden = true;
  try {
    const res = await fetch(
      `https://www.pokemonpricetracker.com/api/v2/cards?tcgPlayerId=${target.productId}&includeEbay=true&days=7`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const card = body && body.data ? (Array.isArray(body.data) ? body.data[0] : body.data) : null;
    const hasGraded = !!(card && card.ebay);
    msg.textContent = !res.ok
      ? `HTTP ${res.status}: the key or plan was rejected (details below).`
      : hasGraded
        ? "✓ Graded eBay data is included with this key."
        : card
          ? "The card came back without graded eBay data (details below)."
          : "No card came back (details below).";
    const summary = {
      card: target.card,
      gradeOnSlab: target.grade || undefined,
      status: res.status,
      cardFields: card ? Object.keys(card) : null,
      ebay: card ? card.ebay : undefined,
      body: card ? undefined : body,
    };
    out.textContent = JSON.stringify(summary, null, 2).slice(0, 8000);
    out.hidden = false;
  } catch (e) {
    msg.textContent = "Request failed: " + (e && e.message ? e.message : e);
  }
});
