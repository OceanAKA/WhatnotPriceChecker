// Floating price-checker panel injected on whatnot.com.
// "Scan" screenshots the stream video, Claude identifies the card on
// camera, and the panel shows its market prices. Manual search still works.

(() => {
  if (window.__wnPriceCheckerLoaded) return;
  window.__wnPriceCheckerLoaded = true;

  const AUTO_SCAN_MS = 30000;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF never fires in a background tab, so don't wait on it forever
  const nextFrame = () =>
    Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), sleep(150)]);

  // ---------- page inspection ----------

  // The stream is the largest visible <video>; crop the screenshot to it so
  // the card fills as much of the image as possible.
  function findStreamRect() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const right = Math.min(window.innerWidth, r.right);
      const bottom = Math.min(window.innerHeight, r.bottom);
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      if (area > bestArea) {
        bestArea = area;
        best = { left, top, width: right - left, height: bottom - top };
      }
    }
    return bestArea > 10000 ? best : null;
  }

  // Best-effort listing title, passed to Claude as a hint only.
  function listingHint() {
    const sels = ['[data-testid*="listing" i]', '[data-testid*="product" i]', '[data-testid*="auction" i]', "h1", "h2", "h3"];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest("#wn-price-checker")) continue;
        const t = (el.textContent || "").trim().replace(/\s+/g, " ");
        if (t.length >= 4 && t.length <= 140 && /[a-z]/i.test(t)) return t;
      }
    }
    return "";
  }

  // ---------- UI ----------

  const panel = document.createElement("div");
  panel.id = "wn-price-checker";
  panel.innerHTML = `
    <div class="wnpc-header">
      <span class="wnpc-title">💰 Card Prices</span>
      <label class="wnpc-auto" title="Scan the stream automatically every 30 seconds"><input type="checkbox" id="wnpc-auto"> auto-scan</label>
      <button class="wnpc-icon" id="wnpc-gear" title="Settings">⚙</button>
      <button class="wnpc-icon" id="wnpc-min" title="Collapse">–</button>
    </div>
    <div class="wnpc-body">
      <div class="wnpc-settings" id="wnpc-settings" hidden>
        <div class="wnpc-label">Anthropic API key</div>
        <div class="wnpc-row">
          <input id="wnpc-key" type="password" placeholder="sk-ant-…" spellcheck="false" autocomplete="off">
          <button id="wnpc-save">Save</button>
        </div>
        <div class="wnpc-hint">Stored only in this browser. Get one at console.anthropic.com → API Keys. Each scan costs about 1¢.</div>
        <div class="wnpc-label">pokemontcg.io key <span class="wnpc-hint">(optional, free: steadier price lookups)</span></div>
        <div class="wnpc-row">
          <input id="wnpc-pkey" type="password" placeholder="optional" spellcheck="false" autocomplete="off">
          <button id="wnpc-psave">Save</button>
        </div>
      </div>
      <button class="wnpc-scan" id="wnpc-scan">📷 Scan card on stream</button>
      <div class="wnpc-row">
        <input id="wnpc-input" type="text" placeholder="…or type a card, e.g. charizard ex 199/165" spellcheck="false">
        <button id="wnpc-search">Search</button>
      </div>
      <div class="wnpc-status" id="wnpc-status">Hit Scan while the seller shows a card.</div>
      <div class="wnpc-seen" id="wnpc-seen" hidden></div>
      <div class="wnpc-results" id="wnpc-results"></div>
      <div class="wnpc-foot">Raw (ungraded) market prices · TCGPlayer &amp; Cardmarket via pokemontcg.io · card ID by Claude</div>
    </div>`;
  document.documentElement.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const input = $("#wnpc-input");
  const status = $("#wnpc-status");
  const seen = $("#wnpc-seen");
  const results = $("#wnpc-results");
  const settings = $("#wnpc-settings");
  const scanBtn = $("#wnpc-scan");
  const autoBox = $("#wnpc-auto");

  for (const el of panel.querySelectorAll("input")) {
    el.addEventListener("keydown", (e) => e.stopPropagation()); // keep Whatnot hotkeys out
  }

  // Drag by header
  (() => {
    const header = $(".wnpc-header");
    let sx, sy, px, py, dragging = false;
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button,input,label")) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      px = r.left; py = r.top;
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, px + e.clientX - sx) + "px";
      panel.style.top = Math.max(0, py + e.clientY - sy) + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    header.addEventListener("pointerup", () => (dragging = false));
  })();

  $("#wnpc-min").addEventListener("click", () => {
    panel.classList.toggle("wnpc-collapsed");
    $("#wnpc-min").textContent = panel.classList.contains("wnpc-collapsed") ? "+" : "–";
  });

  $("#wnpc-gear").addEventListener("click", () => {
    settings.hidden = !settings.hidden;
  });

  $("#wnpc-save").addEventListener("click", async () => {
    const key = $("#wnpc-key").value.trim();
    await send({ type: "saveApiKey", key });
    $("#wnpc-key").value = "";
    settings.hidden = !!key;
    status.textContent = key ? "API key saved. Hit Scan while the seller shows a card." : "API key removed.";
  });

  $("#wnpc-psave").addEventListener("click", async () => {
    const key = $("#wnpc-pkey").value.trim();
    await send({ type: "savePriceApiKey", key });
    $("#wnpc-pkey").value = "";
    status.textContent = key ? "Price API key saved." : "Price API key removed.";
  });

  send({ type: "getSettings" }).then((s) => {
    if (s && !s.hasKey) {
      settings.hidden = false;
      status.textContent = "Add your Anthropic API key to enable AI scanning.";
    }
  });

  // ---------- rendering ----------

  const money = (n) => (n == null ? "—" : "$" + Number(n).toFixed(2));
  const euro = (n) => (n == null ? "—" : "€" + Number(n).toFixed(2));

  function renderSeen(card, image) {
    const num = card.number ? `#${card.number}${card.set_total ? "/" + card.set_total : ""}` : "";
    const warnings = [];
    if (card.graded) {
      warnings.push(`Graded${card.grade_label ? " " + card.grade_label : ""}: slabs sell well above the raw prices below.`);
    }
    if (card.language && !/english/i.test(card.language)) {
      warnings.push(`${card.language} card: prices below are for the English printing.`);
    }
    seen.hidden = false;
    seen.innerHTML = `
      <img class="wnpc-thumb" src="data:image/jpeg;base64,${image}" alt="Frame sent to AI">
      <div class="wnpc-seen-info">
        <div class="wnpc-seen-label">AI sees <span class="wnpc-conf wnpc-conf-${esc(card.confidence)}">${esc(card.confidence)} confidence</span></div>
        <div class="wnpc-seen-name">${card.card_visible && card.name ? esc(card.name) + " " + esc(num) : "No card identified"}</div>
        <div class="wnpc-seen-sub">${esc(card.set_name)}</div>
        ${card.notes ? `<div class="wnpc-seen-sub">${esc(card.notes)}</div>` : ""}
        ${warnings.map((w) => `<div class="wnpc-warn">${esc(w)}</div>`).join("")}
      </div>`;
  }

  function renderCards(cards) {
    results.innerHTML = "";
    for (const card of cards.slice(0, 6)) {
      const div = document.createElement("div");
      div.className = "wnpc-card";

      const tp = card.tcgplayer && card.tcgplayer.prices ? card.tcgplayer.prices : {};
      const variantRows = Object.entries(tp)
        .map(([variant, p]) => {
          const label = variant.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
          return `<div class="wnpc-variant">
              <span class="wnpc-vname">${esc(label)}</span>
              <span class="wnpc-market">${money(p.market)}</span>
              <span class="wnpc-range">${money(p.low)} – ${money(p.high)}</span>
            </div>`;
        })
        .join("");

      const cm = card.cardmarket && card.cardmarket.prices;
      const cmRow =
        cm && cm.trendPrice != null
          ? `<div class="wnpc-variant"><span class="wnpc-vname">Cardmarket trend</span><span class="wnpc-market">${euro(cm.trendPrice)}</span><span class="wnpc-range"></span></div>`
          : "";

      const tpUrl = card.tcgplayer && card.tcgplayer.url;
      const updated =
        card.tcgplayer && card.tcgplayer.updatedAt
          ? `<span class="wnpc-updated">prices ${esc(card.tcgplayer.updatedAt)}</span>`
          : "";

      div.innerHTML = `
        <img class="wnpc-img" src="${esc(card.images ? card.images.small : "")}" alt="">
        <div class="wnpc-info">
          <div class="wnpc-name">${esc(card.name)} <span class="wnpc-num">#${esc(card.number)}</span></div>
          <div class="wnpc-set">${esc(card.set ? card.set.name : "")}${card.rarity ? " · " + esc(card.rarity) : ""} ${updated}</div>
          ${variantRows || '<div class="wnpc-variant"><span class="wnpc-vname">No TCGPlayer price listed</span></div>'}
          ${cmRow}
          ${tpUrl ? `<a class="wnpc-link" href="${esc(tpUrl)}" target="_blank" rel="noopener">View on TCGPlayer ↗</a>` : ""}
        </div>`;
      results.appendChild(div);
    }
  }

  // ---------- actions ----------

  let busy = false;
  let lastCardKey = "";

  async function scan({ auto = false } = {}) {
    if (busy) return;
    busy = true;
    scanBtn.disabled = true;
    try {
      status.textContent = "Capturing the stream…";
      const rect = findStreamRect();
      panel.style.visibility = "hidden";
      let frame;
      try {
        await nextFrame();
        await sleep(30);
        frame = await send({ type: "captureFrame", rect, dpr: window.devicePixelRatio || 1 });
      } finally {
        panel.style.visibility = "";
      }
      if (!frame || !frame.ok) {
        status.textContent = "Couldn't capture the stream: " + (frame ? frame.error : "no response");
        return;
      }

      status.textContent = "Asking AI which card this is…";
      const resp = await send({ type: "identifyAndPrice", image: frame.image, hint: listingHint() });
      if (!resp || !resp.ok) {
        if (resp && resp.needsKey) settings.hidden = false;
        status.textContent = resp ? resp.error : "No response from the extension.";
        return;
      }

      const card = resp.card;
      const key = `${card.name}|${card.number}|${card.set_total}`.toLowerCase();
      if (auto && card.card_visible && key === lastCardKey) {
        status.textContent = `Still ${card.name} (checked ${new Date().toLocaleTimeString()}).`;
        return;
      }
      lastCardKey = card.card_visible ? key : "";

      renderSeen(card, frame.image);
      if (!card.card_visible || !card.name) {
        results.innerHTML = "";
        status.textContent = "No card in view. Scan again when the seller holds one up.";
      } else if (resp.priceError) {
        results.innerHTML = "";
        status.textContent = resp.priceError;
      } else if (!resp.cards.length) {
        results.innerHTML = "";
        status.textContent = `No price data found for “${card.name}”. Try typing it below.`;
      } else {
        status.textContent = `Best match first (${resp.cards.length} result${resp.cards.length > 1 ? "s" : ""}):`;
        renderCards(resp.cards);
      }
    } catch (e) {
      status.textContent = "Scan failed: " + (e && e.message ? e.message : e);
    } finally {
      busy = false;
      scanBtn.disabled = false;
    }
  }

  async function searchText(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    busy = true;
    status.textContent = "Searching…";
    results.innerHTML = "";
    try {
      const resp = await send({ type: "searchText", text });
      if (!resp || !resp.ok) {
        status.textContent = resp ? resp.error : "No response from the extension.";
      } else if (!resp.cards.length) {
        status.textContent = `No matches for “${resp.parsed.name}”. Try just the Pokémon's name.`;
      } else {
        status.textContent = `${resp.cards.length} match${resp.cards.length > 1 ? "es" : ""}:`;
        renderCards(resp.cards);
      }
    } catch (e) {
      status.textContent = "Lookup failed: " + (e && e.message ? e.message : e);
    } finally {
      busy = false;
    }
  }

  scanBtn.addEventListener("click", () => scan());
  $("#wnpc-search").addEventListener("click", () => searchText(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchText(input.value);
  });

  let autoTimer = null;
  autoBox.addEventListener("change", () => {
    clearInterval(autoTimer);
    lastCardKey = "";
    if (autoBox.checked) {
      scan({ auto: true });
      autoTimer = setInterval(() => {
        // captureVisibleTab grabs whatever tab is showing, so only scan when this one is
        if (document.visibilityState === "visible") scan({ auto: true });
      }, AUTO_SCAN_MS);
    }
  });
})();
