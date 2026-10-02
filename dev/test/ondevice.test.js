// On-device path and Automatic-mode routing, with Chrome's LanguageModel and
// extension APIs stubbed.
const ok = (cond, label) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);

let availability = "available";
let lastPrompt, lastOpts, created = 0;
const CARD = { card_visible: true, name: "Charizard ex", number: "199", set_total: "165", set_name: "151", language: "English", graded: false, grade_label: "", confidence: "high", notes: "" };
let reply = JSON.stringify(CARD);
globalThis.LanguageModel = {
  availability: async () => availability,
  create: async (opts) => {
    created++;
    const session = {
      clone: async () => session,
      prompt: async (p, o) => { lastPrompt = p; lastOpts = o; return reply; },
      destroy: () => {},
    };
    session.createOpts = opts;
    return session;
  },
};

const store = {};
let listener;
globalThis.chrome = {
  storage: { local: { get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]])), set: async (o) => Object.assign(store, o) } },
  runtime: { onMessage: { addListener: (f) => (listener = f) }, onInstalled: { addListener: () => {} }, openOptionsPage: async () => {} },
};
const send = (msg) => new Promise((res) => listener(msg, { tab: { windowId: 1 } }, res));

// Prices: answer from a canned list so the test stays offline.
globalThis.fetch = async () => Response.json({ data: [{ id: "sv3pt5-199", name: "Charizard ex", number: "199", set: { name: "151", printedTotal: 165 } }] });

await import("../src/background.js");

let r = await send({ type: "identify", image: "QUJD", hint: "" });
ok(r.ok && r.card.model === "on-device Gemini Nano", `Automatic mode uses on-device AI when available (${r.card && r.card.model})`);
const priced = await send({ type: "price", card: r.card });
ok(priced.ok && priced.cards.length === 1 && priced.cards[0].id === "sv3pt5-199", "price lookup ran on the on-device result");
ok(lastPrompt[0].content[0].type === "image" && lastPrompt[0].content[0].value instanceof Blob, "frame passed to the model as an image Blob");
ok(lastOpts.responseConstraint && lastOpts.omitResponseConstraintInput === true, "JSON schema constraint applied");

await send({ type: "identify", image: "QUJD", hint: "" });
ok(created === 1, "base session is created once and reused");

let s = await send({ type: "getSettings" });
ok(s.mode === "auto" && s.ready === true && s.onDevice === "available", "settings report Automatic + ready");

availability = "downloadable";
r = await send({ type: "identify", image: "QUJD", hint: "" });
ok(!r.ok && r.needsSetup && /one-time download/.test(r.error), `model not downloaded -> download prompt ("${r.error}")`);

const realLM = globalThis.LanguageModel;
delete globalThis.LanguageModel;
r = await send({ type: "identify", image: "QUJD", hint: "" });
ok(!r.ok && r.needsSetup && /Google Chrome/.test(r.error), `browser without built-in AI (e.g. Brave) -> use Chrome ("${r.error}")`);
globalThis.LanguageModel = realLM;

availability = "unavailable";
r = await send({ type: "identify", image: "QUJD", hint: "" });
ok(!r.ok && r.needsSetup && /requirements/.test(r.error), `weak computer -> requirements message ("${r.error}")`);
s = await send({ type: "getSettings" });
ok(s.ready === false, "settings report not ready");

store.mode = "gemini";
r = await send({ type: "identify", image: "QUJD", hint: "" });
ok(!r.ok && r.needsSetup && /Gemini API key/.test(r.error), "own-key mode without a key asks for one");

// Graded lookups with a user's PokemonPriceTracker key: missing eBay data must say why.
store.mode = "auto";
availability = "available";
store.pptApiKey = "pokeprice_free_test_key_123456";
let pptBody, pptStatus;
let pptCallCount = 0;
const priceFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.includes("pokemonpricetracker")) {
    pptCallCount++;
    return Response.json(pptBody, { status: pptStatus });
  }
  if (url.endsWith("/85/groups")) return Response.json({ results: [{ groupId: 1, name: "SV: Scarlet & Violet 151", abbreviation: "MEW", publishedOn: "2023-09-22T00:00:00" }] });
  if (url.endsWith("/85/1/products")) return Response.json({ results: [{ productId: 99, name: "Charizard ex - 199/165", cleanName: "Charizard ex 199 165", url: "https://www.tcgplayer.com/product/99", extendedData: [{ name: "Number", value: "199/165" }] }] });
  if (url.endsWith("/85/1/prices")) return Response.json({ results: [{ productId: 99, marketPrice: 300, lowPrice: 280, highPrice: 400, subTypeName: "Holofoil" }] });
  return priceFetch(url, init);
};
const slab = { ...CARD, language: "Japanese", number_legible: true, set_code: "MEW", graded: true, grade_label: "CGC 10" };

pptStatus = 200;
pptBody = { data: [{ tcgPlayerId: "99", name: "Charizard ex" }] };
pptCallCount = 0;
r = await send({ type: "price", card: slab });
ok(pptCallCount === 0 && r.graded && r.graded.canLoad && r.graded.price === null, `scan offers "tap for price" without spending credits (calls: ${pptCallCount})`);
r = { ...r, graded: (await send({ type: "graded", card: slab, top: r.cards[0] })).graded };
ok(r.cards[0].productId === 99 && r.graded && r.graded.price === null && /no graded data/.test(r.graded.reason), `no eBay data in response -> says so ("${r.graded && r.graded.reason}")`);
ok(r.cards[0].prices[0].market === 300, "raw price still shown");

store.gradedCache = {};
pptStatus = 401;
pptBody = { error: "Invalid API key" };
r = await send({ type: "price", card: slab });
r = { ...r, graded: (await send({ type: "graded", card: slab, top: r.cards[0] })).graded };
ok(/rejected the key/.test(r.graded.reason), `bad key -> "${r.graded.reason}"`);

store.gradedCache = {};
pptStatus = 200;
pptBody = { data: [{ tcgPlayerId: "99", ebay: { cgc10: { avg: 455, salesCount: 6 } } }] };
r = await send({ type: "price", card: slab });
r = { ...r, graded: (await send({ type: "graded", card: slab, top: r.cards[0] })).graded };
const again = await send({ type: "price", card: slab });
ok(again.graded.price === 455 && !again.graded.canLoad, "after a tap, the next scan of that slab shows the cached price");
ok(r.graded.price === 455 && r.graded.count === 6 && !r.graded.reason, `paid key -> CGC 10 avg $${r.graded.price}, ${r.graded.count} sold`);

// Graded price must not be attached to a different printing than the one read off the slab.
r = await send({ type: "price", card: { ...slab, number: "998" } });
ok(r.graded && r.graded.price === null && /exact printing not found/.test(r.graded.reason), `number mismatch -> no graded price ("${r.graded && r.graded.reason}")`);
r = await send({ type: "price", card: { ...slab, number_legible: false, number: "" } });
ok(r.graded && r.graded.price === null && /couldn't read/.test(r.graded.reason), `unread number -> no graded price ("${r.graded && r.graded.reason}")`);

// Credits: a repeat slab is served from the cache; after a 429 no more calls are made today.
pptCallCount = 0;
await send({ type: "price", card: slab });
ok(pptCallCount === 0, `repeat slab costs no API call (calls: ${pptCallCount})`);
store.gradedCache = {};
pptStatus = 429;
pptBody = { error: "Daily limit exceeded" };
r = await send({ type: "price", card: slab });
r = { ...r, graded: (await send({ type: "graded", card: slab, top: r.cards[0] })).graded };
ok(/daily limit reached \(resets/.test(r.graded.reason), `429 -> "${r.graded.reason}"`);
pptCallCount = 0;
store.gradedCache = {};
r = await send({ type: "graded", card: slab, top: r.cards[0] });
ok(pptCallCount === 0 && /daily limit/.test(r.graded.reason), `after the limit, no further calls until reset (calls: ${pptCallCount})`);
delete store.pptExhaustedUntil;
