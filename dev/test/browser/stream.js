// Fake Whatnot stream for testing the panel's auto-scan in a real browser.
// A canvas draws a scripted scene (cards brought in, held, flipped, swapped)
// and is played through a <video> element via captureStream(), so the
// extension's content script sees an ordinary stream. Extension APIs are
// stubbed; the AI stub records when each scan fires and what was on screen.
//
// Open scenario.html?name=<scenario> directly, or index.html to run them all.

/* eslint-disable no-undef */
(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get("name") || "plain";
  const W = 720;
  const H = 1280;

  // ---------- drawing helpers ----------

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");

  function plainCard(x, y, w, h, base, inner) {
    g.fillStyle = base;
    g.fillRect(x, y, w, h);
    g.fillStyle = inner;
    g.fillRect(x + w * 0.1, y + h * 0.1, w * 0.8, h * 0.43);
  }

  // Full-art / holo card: rainbow sheen sweeping across and sparkles that change
  // every frame, the way foil catches the light.
  function holoCard(cx, cy, w, h, base, t, angle = 0) {
    g.save();
    g.translate(cx, cy);
    g.rotate(angle);
    g.fillStyle = base;
    g.fillRect(-w / 2, -h / 2, w, h);
    g.fillStyle = "#222";
    g.fillRect(-w / 2 + w * 0.08, -h / 2 + h * 0.11, w * 0.84, h * 0.4);
    const band = ((t * 380) % (w + 200)) - 100 - w / 2;
    const grad = g.createLinearGradient(band - 80, -h / 2, band + 80, h / 2);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.65)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(-w / 2, -h / 2, w, h);
    for (let i = 0; i < 240; i++) {
      g.fillStyle = `hsl(${Math.random() * 360},100%,${55 + Math.random() * 40}%)`;
      g.fillRect(-w / 2 + Math.random() * w, -h / 2 + Math.random() * h, 6, 6);
    }
    g.restore();
  }

  // The back of a Pokemon card: blue with a Poke Ball.
  function cardBack(cx, cy, w, h) {
    g.fillStyle = "#1d4fb8";
    g.fillRect(cx - w / 2, cy - h / 2, w, h);
    g.fillStyle = "#e33";
    g.beginPath();
    g.arc(cx, cy, w * 0.23, Math.PI, 0);
    g.fill();
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(cx, cy, w * 0.23, 0, Math.PI);
    g.fill();
  }

  // A wall of cards in toploaders behind the seller, with glare flicker and camera noise.
  const wall = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) wall.push({ x: 20 + c * 175, y: 20 + r * 315, hue: Math.random() * 360 });
  function busyBackground() {
    g.fillStyle = "#3a3a44";
    g.fillRect(0, 0, W, H);
    for (const c of wall) {
      g.fillStyle = `hsl(${c.hue},55%,45%)`;
      g.fillRect(c.x, c.y, 150, 290);
      if (Math.random() < 0.3) {
        g.fillStyle = "rgba(255,255,255,0.5)";
        g.fillRect(c.x + Math.random() * 100, c.y + Math.random() * 240, 50, 50);
      }
    }
    for (let i = 0; i < 400; i++) {
      const v = () => (Math.random() < 0.5 ? 0 : 255);
      g.fillStyle = `rgba(${v()},${v()},${v()},0.15)`;
      g.fillRect(Math.random() * W, Math.random() * H, 4, 4);
    }
  }

  function plainBackground() {
    g.fillStyle = "#406080";
    g.fillRect(0, 0, W, H);
  }

  // Hand movement: small jitter for cards on a stand, sway and tilt when hand-held.
  const jitter = (t) => ({ x: Math.round(Math.sin(t * 7) * 4), y: Math.round(Math.cos(t * 5) * 4), a: 0 });
  const sway = (k) => (t) => ({
    x: (Math.sin(t * 1.7) * 18 + Math.sin(t * 4.1) * 7) * k,
    y: (Math.cos(t * 1.3) * 14 + Math.sin(t * 3.3) * 6) * k,
    a: Math.sin(t * 1.1) * 0.06 * k,
  });

  // ---------- scenarios ----------
  //
  // Each scenario is a list of timed segments. `scan: true` marks the moments a
  // scan is expected (exactly one scan per such segment); scans anywhere else
  // count as extra.

  const SCENARIOS = {
    plain: {
      title: "Plain cards",
      about: "Two non-holo cards brought in and held still, one after the other.",
      duration: 13,
      segments: [
        { from: 0, to: 2, label: "empty", draw: () => plainBackground() },
        { from: 2, to: 3, label: "bringing in", draw: (t) => { plainBackground(); plainCard(100 + (t - 2) * 400, 300, 300, 420, "#e0c040", "#c03030"); } },
        { from: 3, to: 7, label: "card A", card: "A", scan: true, draw: () => { plainBackground(); plainCard(210, 300, 300, 420, "#e0c040", "#c03030"); } },
        { from: 7, to: 8, label: "swapping", draw: (t) => { plainBackground(); plainCard(500 - (t - 7) * 300, 250, 320, 450, "#30c0e0", "#202020"); } },
        { from: 8, to: 13, label: "card B", card: "B", scan: true, draw: () => { plainBackground(); plainCard(200, 250, 320, 450, "#30c0e0", "#202020"); } },
      ],
    },
    holo: {
      title: "Holo / full-art cards",
      about: "Shimmering foil cards with small hand jitter. Before v3.2.4 the sparkle looked like motion and blocked scans.",
      duration: 17,
      segments: [
        { from: 0, to: 2, label: "empty", draw: () => plainBackground() },
        { from: 2, to: 3, label: "bringing in", draw: (t) => { plainBackground(); plainCard(100 + (t - 2) * 400, 300, 300, 420, "#e0c040", "#c03030"); } },
        { from: 3, to: 9, label: "card A", card: "A", scan: true, draw: (t) => { plainBackground(); const j = jitter(t); holoCard(360 + j.x, 510 + j.y, 300, 420, "#c040c0", t); } },
        { from: 9, to: 10, label: "swapping", draw: (t) => { plainBackground(); plainCard(500 - (t - 9) * 300, 250, 320, 450, "#30c0e0", "#202020"); } },
        { from: 10, to: 17, label: "card B", card: "B", scan: true, draw: (t) => { plainBackground(); const j = jitter(t); holoCard(360 + j.x, 475 + j.y, 320, 450, "#20a060", t); } },
      ],
    },
    "holo-back": {
      title: "Holo card, then its back",
      about: "The seller flips card A to show the back. The back is scanned but ignored, so card A stays on screen.",
      duration: 18,
      segments: [
        { from: 0, to: 2, label: "empty", draw: () => plainBackground() },
        { from: 2, to: 3, label: "bringing in", draw: (t) => { plainBackground(); plainCard(100 + (t - 2) * 400, 300, 300, 420, "#e0c040", "#c03030"); } },
        { from: 3, to: 7, label: "card A", card: "A", scan: true, draw: (t) => { plainBackground(); const j = jitter(t); holoCard(360 + j.x, 510 + j.y, 300, 420, "#c040c0", t); } },
        { from: 7, to: 7.6, label: "flipping", draw: (t) => { plainBackground(); plainCard(210 + (t - 7) * 200, 300, 300 - (t - 7) * 400, 420, "#808080", "#606060"); } },
        { from: 7.6, to: 11, label: "back of A", back: true, scan: true, draw: (t) => { plainBackground(); const j = jitter(t); cardBack(360 + j.x, 510 + j.y, 300, 420); } },
        { from: 11, to: 12, label: "swapping", draw: (t) => { plainBackground(); plainCard(500 - (t - 11) * 300, 250, 320, 450, "#30c0e0", "#202020"); } },
        { from: 12, to: 18, label: "card B", card: "B", scan: true, draw: (t) => { plainBackground(); const j = jitter(t); holoCard(360 + j.x, 475 + j.y, 320, 450, "#20a060", t); } },
      ],
    },
    sway: {
      title: "Hand-held, busy background",
      about: "A big holo card held in a swaying hand in front of a wall of holo cards, with camera noise.",
      duration: 18,
      segments: [
        { from: 0, to: 2, label: "empty", draw: () => busyBackground() },
        { from: 2, to: 3, label: "bringing in", draw: (t) => { busyBackground(); holoCard(-200 + (t - 2) * 560, 700, 380, 530, "#c9a227", t, 0.3); } },
        { from: 3, to: 9, label: "card A", card: "A", scan: true, draw: (t) => { busyBackground(); const s = sway(1)(t); holoCard(360 + s.x, 700 + s.y, 380, 530, "#c9a227", t, s.a); } },
        { from: 9, to: 10, label: "taking away", draw: (t) => { busyBackground(); holoCard(360 + (t - 9) * 700, 700, 380, 530, "#c9a227", t, 0.4); } },
        { from: 10, to: 11, label: "bringing in", draw: (t) => { busyBackground(); holoCard(-200 + (t - 10) * 560, 700, 380, 530, "#5a6fd0", t, -0.3); } },
        { from: 11, to: 18, label: "card B", card: "B", scan: true, draw: (t) => { busyBackground(); const s = sway(1)(t); holoCard(360 + s.x, 700 + s.y, 380, 530, "#5a6fd0", t, s.a); } },
      ],
    },
    "sway-strong": {
      title: "Strong hand sway",
      about: "Same as above with three times the sway and tilt: the card never holds still.",
      duration: 19,
      segments: [
        { from: 0, to: 2, label: "empty", draw: () => busyBackground() },
        { from: 2, to: 3, label: "bringing in", draw: (t) => { busyBackground(); holoCard(-200 + (t - 2) * 560, 700, 380, 530, "#c9a227", t, 0.3); } },
        { from: 3, to: 9, label: "card A", card: "A", scan: true, draw: (t) => { busyBackground(); const s = sway(3)(t); holoCard(360 + s.x, 700 + s.y, 380, 530, "#c9a227", t, s.a); } },
        { from: 9, to: 10, label: "taking away", draw: (t) => { busyBackground(); holoCard(360 + (t - 9) * 700, 700, 380, 530, "#c9a227", t, 0.4); } },
        { from: 10, to: 11, label: "bringing in", draw: (t) => { busyBackground(); holoCard(-200 + (t - 10) * 560, 700, 380, 530, "#5a6fd0", t, -0.3); } },
        { from: 11, to: 19, label: "card B", card: "B", scan: true, draw: (t) => { busyBackground(); const s = sway(3)(t); holoCard(360 + s.x, 700 + s.y, 380, 530, "#5a6fd0", t, s.a); } },
      ],
    },
  };
  window.SCENARIOS = SCENARIOS;

  const scenario = SCENARIOS[name];
  if (!scenario) {
    document.body.textContent = `Unknown scenario "${name}". Try: ${Object.keys(SCENARIOS).join(", ")}`;
    return;
  }

  // ---------- play the scenario through a <video> ----------

  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const segmentAt = (t) => scenario.segments.find((s) => t >= s.from && t < s.to) || scenario.segments[scenario.segments.length - 1];
  function draw() {
    const t = now();
    segmentAt(t).draw(t);
  }
  draw();
  // A timer rather than requestAnimationFrame: rAF pauses in background tabs.
  setInterval(draw, 50);

  const video = document.getElementById("stream");
  video.srcObject = canvas.captureStream(20);

  // ---------- stub the extension APIs ----------

  const scans = [];
  const fakeCard = (seg) => {
    if (seg.back) {
      return { card_visible: false, card_back: true, name: "", number_legible: false, number: "", set_total: "", set_code: "", set_name: "", language: "", graded: false, grade_label: "", confidence: "high", model: "test stub" };
    }
    const id = seg.card || "?";
    return { card_visible: !!seg.card, card_back: false, name: seg.card ? `Card ${id}` : "", number_legible: true, number: id === "A" ? "1" : "2", set_total: "", set_code: "", set_name: "Test", language: "English", graded: false, grade_label: "", confidence: "high", model: "test stub" };
  };
  window.chrome = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "getSettings") return { ok: true, ready: true };
        if (m.type === "warmUp") return { ok: true };
        if (m.type === "captureFrame") return { ok: false, error: "the screenshot fallback should not be needed" };
        if (m.type === "identify") {
          const t = now();
          const seg = segmentAt(t);
          scans.push({ at: +t.toFixed(2), segment: seg.label });
          return { ok: true, card: fakeCard(seg) };
        }
        if (m.type === "price") {
          const n = m.card.name;
          return { ok: true, priceLanguage: "English", cards: [{ id: n, name: n, number: m.card.number, setName: "Test", rarity: "", image: "", url: "", prices: [{ label: "Holofoil", market: n === "Card B" ? 20 : 10, low: 1, high: 30 }] }] };
        }
        if (m.type === "openOptions") return { ok: true };
        return { ok: false };
      },
    },
  };

  // ---------- run and report ----------

  // Switching auto-scan on scans the current frame once; that's expected, not graded.
  const INITIAL_SCAN_S = 1;

  function grade() {
    const initial = scans.filter((s) => s.at < INITIAL_SCAN_S);
    const graded = scans.filter((s) => s.at >= INITIAL_SCAN_S);
    const expected = scenario.segments.filter((s) => s.scan);
    const perSegment = expected.map((seg) => {
      const hits = graded.filter((s) => s.segment === seg.label);
      return { label: seg.label, from: seg.from, scans: hits.length, delay: hits.length ? +(hits[0].at - seg.from).toFixed(2) : null };
    });
    const extra = graded.filter((s) => !expected.some((seg) => seg.label === s.segment));
    const repeats = perSegment.reduce((n, s) => n + Math.max(0, s.scans - 1), 0);
    return {
      name,
      title: scenario.title,
      about: scenario.about,
      duration: scenario.duration,
      segments: scenario.segments.map(({ from, to, label, scan }) => ({ from, to, label, scan: !!scan })),
      scans: graded,
      initialScans: initial.length,
      perSegment,
      missed: perSegment.filter((s) => !s.scans).length,
      extra: extra.length + repeats,
      pass: perSegment.every((s) => s.scans === 1) && extra.length === 0,
    };
  }

  window.addEventListener("load", () => {
    const auto = document.querySelector("#wnpc-auto");
    auto.click(); // turn on auto-scan
    setTimeout(() => {
      const result = grade();
      window.__result = result;
      document.getElementById("summary").textContent = `${result.pass ? "PASS" : "FAIL"} · ${JSON.stringify(result.perSegment)}`;
      if (window.parent !== window) window.parent.postMessage({ type: "scenario-result", result }, "*");
    }, scenario.duration * 1000);
  });
})();
