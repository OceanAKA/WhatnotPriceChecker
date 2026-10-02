// The card-ID Worker with Gemini and the rate limiters stubbed (no API spend).
import worker from "../../server/worker.js";

const ok = (cond, label) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
const CARD = { card_visible: true, name: "Pikachu", number: "58", set_total: "102", set_name: "Base", language: "English", graded: false, grade_label: "", confidence: "high", notes: "" };
const ID = "123e4567-e89b-12d3-a456-426614174000";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let geminiMode = "ok";
let pptCalls = 0;
const tcgcsvCalls = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.includes("tcgcsv.com")) {
    tcgcsvCalls.push({ url, ua: init && init.headers && init.headers["User-Agent"] });
    return Response.json({ results: [{ groupId: 1 }] });
  }
  if (url.includes("pokemonpricetracker")) {
    pptCalls++;
    return Response.json({ data: [{ tcgPlayerId: "704873", ebay: { cgc10: { averagePrice: 612.4, salesCount: 5 } } }] });
  }
  if (url.includes("/models?")) return Response.json({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] });
  if (geminiMode === "quota") return Response.json({ error: { message: "quota" } }, { status: 429 });
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(CARD) }] } }] });
};

const limiter = (max) => { const n = new Map(); return { limit: async ({ key }) => { n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= max }; } }; };
const env = () => ({ GEMINI_API_KEY: "k", ALLOWED_ORIGINS: EXT, INSTALL_LIMITER: limiter(2), IP_LIMITER: limiter(100) });
const post = (body, origin = EXT) => new Request("https://svc.example/identify", { method: "POST", headers: { "content-type": "application/json", origin, "cf-connecting-ip": "1.2.3.4" }, body: JSON.stringify(body) });

let e = env();
let r = await worker.fetch(post({ image: "QUJD", installId: ID }), e);
let j = await r.json();
ok(r.status === 200 && j.card.name === "Pikachu" && j.card.model === "gemini-3.8-flash", `identifies a card (${r.status})`);
ok(r.headers.get("access-control-allow-origin") === EXT, "CORS header echoes the extension origin");

r = await worker.fetch(post({ image: "QUJD", installId: ID }, "https://evil.example"), e);
ok(r.status === 403, `other origins rejected (${r.status})`);

r = await worker.fetch(post({ image: "not base64!!", installId: ID }), e);
ok(r.status === 400, `bad image rejected (${r.status})`);
r = await worker.fetch(post({ image: "QUJD", installId: "nope" }), e);
ok(r.status === 400, `bad installId rejected (${r.status})`);

await worker.fetch(post({ image: "QUJD", installId: ID }), e);
r = await worker.fetch(post({ image: "QUJD", installId: ID }), e);
ok(r.status === 429, `per-install rate limit kicks in on the 3rd scan (${r.status})`);

geminiMode = "quota";
r = await worker.fetch(post({ image: "QUJD", installId: "223e4567-e89b-12d3-a456-426614174000" }), env());
j = await r.json();
ok(r.status === 503 && /own free Gemini key/.test(j.error), `Gemini quota exhausted -> 503 with friendly message (${r.status})`);

r = await worker.fetch(post({ image: "QUJD", installId: ID }), { ...env(), GEMINI_API_KEY: "" });
ok(r.status === 500, `missing secret -> 500 (${r.status})`);

r = await worker.fetch(new Request("https://svc.example/health"), env());
ok(r.status === 200, "health check");

const gpost = (body) => new Request("https://svc.example/graded", { method: "POST", headers: { "content-type": "application/json", origin: EXT, "cf-connecting-ip": "5.6.7.8" }, body: JSON.stringify(body) });
r = await worker.fetch(gpost({ tcgPlayerId: 704873, grade: "cgc10", installId: "323e4567-e89b-12d3-a456-426614174000" }), { ...env(), PPT_API_KEY: "p" });
j = await r.json();
ok(r.status === 200 && j.graded && j.graded.price === 612.4 && j.graded.count === 5, `graded price returned (${JSON.stringify(j.graded)})`);
r = await worker.fetch(gpost({ tcgPlayerId: "x", grade: "cgc10", installId: ID }), { ...env(), PPT_API_KEY: "p" });
ok(r.status === 400, `bad tcgPlayerId rejected (${r.status})`);
r = await worker.fetch(gpost({ tcgPlayerId: 704873, grade: "cgc10", installId: "423e4567-e89b-12d3-a456-426614174000" }), env());
j = await r.json();
ok(r.status === 200 && j.graded === null, "no PPT key configured -> graded: null, not an error");

const get = (path, origin = EXT) => new Request(`https://svc.example${path}`, { headers: { origin, "cf-connecting-ip": "9.9.9.9" } });
r = await worker.fetch(get("/tcgcsv/3/24688/prices"), env());
j = await r.json();
ok(r.status === 200 && j.results && tcgcsvCalls[0].url === "https://tcgcsv.com/tcgplayer/3/24688/prices", `relays TCGCSV prices (${r.status})`);
ok(/^WhatnotPriceChecker\//.test(tcgcsvCalls[0].ua), `identifies itself to TCGCSV (${tcgcsvCalls[0].ua})`);
r = await worker.fetch(get("/tcgcsv/3/../../etc"), env());
ok(r.status === 404, `only TCGCSV price paths are relayed (${r.status})`);
r = await worker.fetch(get("/tcgcsv/85/groups", "https://evil.example"), env());
ok(r.status === 403, `relay rejects other origins (${r.status})`);
