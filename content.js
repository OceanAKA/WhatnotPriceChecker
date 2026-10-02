// Floating price-checker panel injected on whatnot.com.
// "Scan" grabs the current stream frame, an AI identifies the card on camera,
// and the panel shows its market prices. Manual search still works.

(() => {
  if (window.__wnPriceCheckerLoaded) return;
  window.__wnPriceCheckerLoaded = true;

  // Frames go to the AI at up to this size; full-HD vertical streams fit as-is.
  const MAX_FRAME_EDGE = 1920;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF never fires in a background tab, so don't wait on it forever
  const nextFrame = () =>
    Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), sleep(150)]);

  // ---------- page inspection ----------

  // The stream is the largest visible <video>.
  function findStream() {
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
        best = { video: v, rect: { left, top, width: right - left, height: bottom - top } };
      }
    }
    return bestArea > 10000 ? best : null;
  }

  // Read the frame straight from the video at the stream's own resolution,
  // which is often several times sharper than the on-screen player. Returns
  // null if the browser won't let the page read the video's pixels.
  function grabVideoFrame(video) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h || video.readyState < 2) return null;
    const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
    } catch {
      return null; // cross-origin video: fall back to a screenshot
    }
  }

  async function captureStreamFrame() {
    const stream = findStream();
    const direct = stream && grabVideoFrame(stream.video);
    if (direct) return { ok: true, image: direct };
    panel.style.visibility = "hidden";
    try {
      await nextFrame();
      await sleep(30);
      return await send({ type: "captureFrame", rect: stream && stream.rect, dpr: window.devicePixelRatio || 1 });
    } finally {
      panel.style.visibility = "";
    }
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
      <label class="wnpc-auto" title="Scan automatically whenever a new card is held up to the camera"><input type="checkbox" id="wnpc-auto"> auto-scan</label>
      <button class="wnpc-icon" id="wnpc-gear" title="Settings">⚙</button>
      <button class="wnpc-icon" id="wnpc-min" title="Collapse">–</button>
    </div>
    <div class="wnpc-body">
      <button class="wnpc-scan" id="wnpc-scan">📷 Scan card on stream</button>
      <div class="wnpc-row">
        <input id="wnpc-input" type="text" placeholder="…or type a card, e.g. charizard ex 199/165" spellcheck="false">
        <button id="wnpc-search">Search</button>
      </div>
      <div class="wnpc-status" id="wnpc-status">Hit Scan while the seller shows a card.</div>
      <div class="wnpc-seen" id="wnpc-seen" hidden></div>
      <div class="wnpc-results" id="wnpc-results"></div>
      <div class="wnpc-foot">Prices: TCGplayer via TCGCSV · graded: eBay sales</div>
    </div>`;
  document.documentElement.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const input = $("#wnpc-input");
  const status = $("#wnpc-status");
  const seen = $("#wnpc-seen");
  const results = $("#wnpc-results");
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

  const openOptions = () => send({ type: "openOptions" });
  $("#wnpc-gear").addEventListener("click", openOptions);

  // Status text with an inline "Open settings" link for setup problems.
  function showSetupNeeded(text) {
    status.textContent = text + " ";
    const link = document.createElement("a");
    link.href = "#";
    link.className = "wnpc-link";
    link.textContent = "Open settings";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openOptions();
    });
    status.appendChild(link);
  }

  send({ type: "getSettings" }).then((s) => {
    if (s && !s.ready) showSetupNeeded("Card scanning needs a one-time setup.");
  });
  // Load the on-device model now so the first scan doesn't wait for it.
  send({ type: "warmUp" }).catch(() => {});

  // ---------- rendering ----------

  const money = (n) => (n == null ? "—" : "$" + Number(n).toFixed(2));
  const euro = (n) => (n == null ? "—" : "€" + Number(n).toFixed(2));

  const chip = (text, cls = "") => `<span class="wnpc-chip ${cls}">${esc(text)}</span>`;

  function renderSeen(card, image) {
    const num =
      card.number && card.number_legible !== false ? `#${card.number}${card.set_total ? "/" + card.set_total : ""}` : "#?";
    const chips = [];
    if (card.graded) chips.push(chip(card.grade_label || "Graded", "wnpc-chip-grade"));
    if (card.language && !/english/i.test(card.language)) chips.push(chip(card.language));
    const setLine = [card.set_name, card.set_code].filter(Boolean).join(" · ");
    seen.hidden = false;
    seen.innerHTML = `
      <img class="wnpc-thumb" src="data:image/jpeg;base64,${image}" alt="Frame sent to AI">
      <div class="wnpc-seen-info">
        <div class="wnpc-seen-label">${esc(card.model || "AI")} sees <span class="wnpc-conf wnpc-conf-${esc(card.confidence)}">${esc(card.confidence)} confidence</span></div>
        <div class="wnpc-seen-name">${card.card_visible && card.name ? esc(card.name) + " " + esc(num) : "No card identified"}</div>
        ${setLine ? `<div class="wnpc-seen-sub">${esc(setLine)}</div>` : ""}
        ${chips.length ? `<div class="wnpc-chips">${chips.join("")}</div>` : ""}
        <div class="wnpc-timing"></div>
      </div>`;
  }

  const row = (label, price, extra = "", cls = "") =>
    `<div class="wnpc-variant ${cls}"><span class="wnpc-vname">${esc(label)}</span><span class="wnpc-market">${price}</span><span class="wnpc-range">${extra}</span></div>`;

  /**
   * @param {object[]} cards display-shape cards from the background worker
   * @param {{graded?: object, rawLabel?: boolean, otherLanguage?: string}} opts
   */
  // What the results list is showing, so a graded price loaded later can re-render it.
  let shown = null;

  function renderCards(cards, opts = {}, card = null) {
    shown = { cards, opts, card };
    results.innerHTML = "";
    cards.slice(0, 6).forEach((card, i) => {
      const div = document.createElement("div");
      div.className = "wnpc-card";
      let rows = "";

      const g = i === 0 && opts.graded;
      if (g) {
        const ebay = `<a class="wnpc-link" href="${esc(g.ebayUrl)}" target="_blank" rel="noopener">eBay sold ↗</a>`;
        if (g.lastSold) {
          const when = g.lastSold.date
            ? new Date(g.lastSold.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : "";
          rows += row(`${g.label} last sold`, money(g.lastSold.price), when, "wnpc-graded");
          rows += `<div class="wnpc-variant">${ebay}</div>`;
        } else if (g.price != null) {
          rows += row(`${g.label} ${g.basis || ""}`.trim(), money(g.price), g.count ? `${g.count} sold` : "", "wnpc-graded");
          rows += `<div class="wnpc-variant">${ebay}</div>`;
        } else if (g.canLoad) {
          rows += row(g.label, `<button class="wnpc-load" data-load-graded>Tap for price</button>`, ebay, "wnpc-graded");
        } else {
          rows += row(g.label, "—", ebay, "wnpc-graded");
          if (g.reason) rows += `<div class="wnpc-reason">${esc(g.reason)}</div>`;
        }
      }

      const suffix = opts.rawLabel ? " (raw)" : "";
      rows += (card.prices || [])
        .map((p) => row(p.label + suffix, money(p.market), `${money(p.low)} – ${money(p.high)}`))
        .join("");
      if (!(card.prices || []).length) rows += row("No TCGplayer price", "");
      if (card.cardmarketTrend) rows += row("Cardmarket trend", euro(card.cardmarketTrend));

      const tags = opts.otherLanguage ? chip("EN price") : "";
      div.innerHTML = `
        <img class="wnpc-img" src="${esc(card.image || "")}" alt="">
        <div class="wnpc-info">
          <div class="wnpc-name">${esc(card.name)} <span class="wnpc-num">#${esc(card.number)}</span> ${tags}</div>
          <div class="wnpc-set">${esc(card.setName || "")}${card.rarity ? " · " + esc(card.rarity) : ""}</div>
          ${rows}
          ${card.url ? `<a class="wnpc-link" href="${esc(card.url)}" target="_blank" rel="noopener">View on TCGplayer ↗</a>` : ""}
        </div>`;
      results.appendChild(div);
    });
  }

  // ---------- actions ----------

  let busy = false;
  let lastCardKey = "";

  const secs = (ms) => (ms / 1000).toFixed(1) + "s";

  function showTimings(t) {
    const el = seen.querySelector(".wnpc-timing");
    if (!el) return;
    const parts = [`capture ${secs(t.capture)}`, `AI ${secs(t.ai)}`];
    if (t.price != null) parts.push(`prices ${t.cached ? "cached" : secs(t.price)}`);
    el.textContent = parts.join(" · ");
  }

  async function scan({ auto = false } = {}) {
    if (busy) return;
    busy = true;
    scanBtn.disabled = true;
    const t = {};
    try {
      status.textContent = "Capturing the stream…";
      let start = performance.now();
      const frame = await captureStreamFrame();
      t.capture = performance.now() - start;
      if (!frame || !frame.ok) {
        status.textContent = "Couldn't capture the stream: " + (frame ? frame.error : "no response");
        return;
      }

      status.textContent = "Reading the card…";
      start = performance.now();
      const resp = await send({ type: "identify", image: frame.image, hint: listingHint() });
      t.ai = performance.now() - start;
      if (!resp || !resp.ok) {
        if (resp && resp.needsSetup) showSetupNeeded(resp.error);
        else status.textContent = resp ? resp.error : "No response from the extension.";
        return;
      }

      const card = resp.card;
      const key = `${card.name}|${card.number}|${card.set_total}`.toLowerCase();
      if (auto && card.card_visible && key === lastCardKey) {
        status.textContent = `Still ${card.name} (checked ${new Date().toLocaleTimeString()}).`;
        return;
      }
      lastCardKey = card.card_visible ? key : "";

      // Show what the AI read right away; prices fill in when they arrive.
      renderSeen(card, frame.image);
      showTimings(t);
      results.innerHTML = "";
      if (!card.card_visible || !card.name) {
        status.textContent = "No card in view. Scan again when the seller holds one up.";
        return;
      }

      status.textContent = "Looking up prices…";
      start = performance.now();
      const prices = await send({ type: "price", card });
      t.price = performance.now() - start;
      t.cached = !!(prices && prices.cached);
      showTimings(t);
      if (!prices || !prices.ok) {
        status.textContent = prices ? prices.error : "No response from the extension.";
      } else if (!prices.cards.length) {
        status.textContent = `No price data found for “${card.name}”. Try typing it below.`;
      } else {
        status.textContent =
          card.number_legible === false || !card.number
            ? "Couldn't read the number. Every printing in this set:"
            : `Best match first (${prices.cards.length} result${prices.cards.length > 1 ? "s" : ""}):`;
        const printed = card.language || "English";
        renderCards(
          prices.cards,
          {
            graded: prices.graded,
            rawLabel: !!prices.graded,
            // Priced from a different language's catalog than the card in the frame.
            otherLanguage: !/english/i.test(printed) && !new RegExp(prices.priceLanguage, "i").test(printed),
          },
          card,
        );
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

  // Graded prices cost API credits, so they load only when tapped.
  results.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-load-graded]");
    if (!btn || !shown || !shown.card) return;
    btn.disabled = true;
    btn.textContent = "Loading…";
    const view = shown;
    try {
      const resp = await send({ type: "graded", card: view.card, top: view.cards[0] });
      if (shown !== view) return; // a newer scan replaced the list
      renderCards(view.cards, { ...view.opts, graded: resp && resp.graded ? resp.graded : view.opts.graded }, view.card);
    } catch {
      btn.disabled = false;
      btn.textContent = "Tap for price";
    }
  });

  scanBtn.addEventListener("click", () => scan());
  $("#wnpc-search").addEventListener("click", () => searchText(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchText(input.value);
  });

  // ---------- auto-scan: scan when a new card is held up ----------
  //
  // A tiny grayscale copy of the video is sampled a few times a second. A scan
  // fires when the picture has changed a lot since the last scan (the seller
  // brought out something new) and has then held still briefly (they're
  // showing it to the camera). The AI then confirms whether it's a card, and
  // the same card shown again is not re-priced.

  const SAMPLE_W = 36;
  const SAMPLE_H = 64;
  const SAMPLE_MS = 250;
  const STILL_MS = 700; // how long the picture must hold still before scanning
  const MIN_GAP_MS = 2500; // between automatic scans
  const PIXEL_DELTA = 28; // brightness change that counts as "this pixel changed"
  // A card usually fills only 10-30% of the frame, so a modest share of changed pixels means "new card".
  const NEW_SCENE = 0.08; // share of pixels changed since the last scan
  const STILL = 0.05; // at most this share changing between samples counts as held still (allows hand jitter)
  const FALLBACK_MS = 15000; // when the video's pixels can't be read

  const sampler = document.createElement("canvas");
  sampler.width = SAMPLE_W;
  sampler.height = SAMPLE_H;
  const sctx = sampler.getContext("2d", { willReadFrequently: true });

  function sampleFrame() {
    const stream = findStream();
    if (!stream || stream.video.readyState < 2) return null;
    try {
      sctx.drawImage(stream.video, 0, 0, SAMPLE_W, SAMPLE_H);
      const px = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const gray = new Uint8Array(SAMPLE_W * SAMPLE_H);
      for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
      return gray;
    } catch {
      return "unreadable";
    }
  }

  function changedShare(a, b) {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DELTA) n++;
    return n / a.length;
  }

  let autoTimer = null;
  let prevSample = null;
  let scannedSample = null;
  let stillSince = 0;
  let lastAutoScan = 0;

  function autoTick() {
    if (document.visibilityState !== "visible" || busy) return;
    const now = performance.now();
    const cur = sampleFrame();
    if (cur === "unreadable") {
      // Can't watch the video, so fall back to a slow timer.
      if (now - lastAutoScan > FALLBACK_MS) {
        lastAutoScan = now;
        scan({ auto: true });
      }
      return;
    }
    if (!cur) return;
    const moving = prevSample ? changedShare(cur, prevSample) > STILL : true;
    prevSample = cur;
    if (moving) {
      stillSince = 0;
      return;
    }
    if (!stillSince) stillSince = now;
    const isNew = !scannedSample || changedShare(cur, scannedSample) > NEW_SCENE;
    if (isNew && now - stillSince >= STILL_MS && now - lastAutoScan >= MIN_GAP_MS) {
      scannedSample = cur;
      lastAutoScan = now;
      scan({ auto: true });
    }
  }

  autoBox.addEventListener("change", () => {
    clearInterval(autoTimer);
    lastCardKey = "";
    prevSample = scannedSample = null;
    stillSince = lastAutoScan = 0;
    if (autoBox.checked) {
      status.textContent = "Auto-scan on: hold a card up to the camera.";
      autoTimer = setInterval(autoTick, SAMPLE_MS);
    }
  });
})();
