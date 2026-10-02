// TCGplayer prices via TCGCSV (https://tcgcsv.com), a free daily mirror of
// TCGplayer's catalog and prices. pokemontcg.io stopped carrying prices for
// new sets, so this is the price source; it also gives direct product links.

const DIRECT = "https://tcgcsv.com/tcgplayer";
// TCGCSV asks every client to identify itself and blocks anonymous requests.
export const USER_AGENT = "WhatnotPriceChecker/3.2.4 (+https://github.com/OceanAKA/WhatnotPriceChecker)";
let base = DIRECT;

/** Route requests through the card-ID service's cached TCGCSV proxy (TCGCSV is meant for server-side use). */
export function setTcgcsvBase(url) {
  base = url || DIRECT;
}
export const ENGLISH = 3; // TCGplayer category "Pokemon"
export const JAPANESE = 85; // TCGplayer category "Pokemon Japan"
const TTL_MS = 6 * 60 * 60 * 1000;

const memo = new Map(); // url -> { at, promise }

async function getJson(url) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = (async () => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 200 * attempt));
      try {
        const res = await fetch(url, base === DIRECT ? { headers: { "User-Agent": USER_AGENT } } : undefined);
        if (res.ok) return (await res.json()).results || [];
        lastError = new Error(`TCGCSV error ${res.status}`);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  })();
  memo.set(url, { at: Date.now(), promise });
  promise.catch(() => memo.delete(url));
  return promise;
}

const groups = (cat) => getJson(`${base}/${cat}/groups`);
const products = (cat, groupId) => getJson(`${base}/${cat}/${groupId}/products`);
const prices = (cat, groupId) => getJson(`${base}/${cat}/${groupId}/prices`);

// "SV: Scarlet & Violet 151" / "ME05: Pitch Black" -> comparable word sets
function words(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/^[a-z]{1,5}\d{0,3}[a-z]?\s*:\s*/, "")
      .replace(/['’]/g, "") // TCGplayer's clean names drop apostrophes: "Misty's" -> "Mistys"
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w && w !== "set" && w !== "the"),
  );
}

// Mostly "is one name contained in the other" ("151" in "Scarlet & Violet 151"),
// with a small bonus for closer overall length so "Base Set" beats "Base Set 2".
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return 0.7 * (shared / Math.min(A.size, B.size)) + 0.3 * (shared / Math.max(A.size, B.size));
}

export function normalizeNumber(n) {
  const s = String(n || "").split("/")[0].trim().toUpperCase().replace(/\s+/g, "");
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

function productNumber(p) {
  const e = (p.extendedData || []).find((x) => x.name === "Number");
  return e ? e.value : "";
}

function productRarity(p) {
  const e = (p.extendedData || []).find((x) => x.name === "Rarity");
  return e ? e.value : "";
}

// Edit distance of at most one: the AI misreads tiny set codes ("PDR" for "POR").
function oneOff(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 3) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

function groupScore(g, { setName, setCode, releaseDate }) {
  let score = setName ? similarity(setName, g.name) : 0;
  // The printed set code ("MEW", "SV2a") is TCGplayer's group abbreviation: the strongest signal.
  const code = (setCode || "").toLowerCase();
  const abbr = (g.abbreviation || "").toLowerCase();
  if (code && abbr === code) score += 2;
  else if (code && abbr && oneOff(abbr, code)) score += 1; // name + number must still match, so near-misses are safe
  const day = releaseDate ? releaseDate.replace(/\//g, "-").slice(0, 10) : "";
  if (day && (g.publishedOn || "").slice(0, 10) === day) score += 1;
  return score;
}

/** TCGCSV groups (sets) ranked by how well they match, best first. */
async function rankGroups(cat, set, max) {
  return (await groups(cat))
    .map((g) => ({ g, s: groupScore(g, set) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.g);
}

// "Charizard ex - 199/165" -> "Charizard ex"
function baseName(p) {
  return (p.name || "").replace(/\s+-\s+[^-]*\d[^-]*$/, "");
}

function sameName(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || A.size !== B.size) return false;
  for (const w of A) if (!B.has(w)) return false;
  return true;
}

/**
 * In one set: the printing with this number (if a number was read), plus every
 * other printing with the same card name, so a misread number still shows the right card.
 */
async function findProducts(cat, groupId, name, number) {
  const [items, rows] = await Promise.all([products(cat, groupId), prices(cat, groupId)]);
  const cards = items.filter((p) => productNumber(p));
  const want = normalizeNumber(number);
  const nameWords = words(name);

  let exact = null;
  if (want) {
    let bestScore = -1;
    for (const p of cards) {
      if (normalizeNumber(productNumber(p)) !== want) continue;
      const pw = words(p.cleanName || p.name);
      let shared = 0;
      for (const w of nameWords) if (pw.has(w)) shared++;
      const score = nameWords.size ? shared / nameWords.size : 0;
      if (score > bestScore) {
        exact = p;
        bestScore = score;
      }
    }
    // The number pins the printing, so a partial name match is enough.
    if (bestScore < 0.5) exact = null;
  }
  const others = cards.filter((p) => p !== exact && sameName(baseName(p), name));
  const withRows = (p) => ({ product: p, rows: rows.filter((r) => r.productId === p.productId) });
  return { exact: exact && withRows(exact), others: others.map(withRows) };
}

function toCard(group, product, rows) {
  return {
    id: `tcgplayer-${product.productId}`,
    productId: product.productId,
    // "Cynthia's Spiritomb - 108/193 (Poke Ball Pattern)" -> "Cynthia's Spiritomb (Poke Ball Pattern)";
    // promos have no "/total": "Turtwig - 040" -> "Turtwig"
    name: (product.name || "").replace(/\s+-\s+[A-Z]{0,4}-?\d+[A-Z]?(?:\/[A-Z0-9-]{1,8})?(?=\s|$)/, ""),
    number: productNumber(product),
    rarity: productRarity(product),
    setName: (group.name || "").replace(/^[A-Z]{1,5}\d{0,3}[a-z]?\s*:\s*/, ""),
    image: product.imageUrl ? product.imageUrl.replace(/_200w\.jpg$/, "_400w.jpg") : "",
    url: product.url,
    prices: rows
      .filter((r) => r.marketPrice != null || r.lowPrice != null)
      .map((r) => ({ label: r.subTypeName || "Market", market: r.marketPrice, low: r.lowPrice, high: r.highPrice })),
  };
}

// Sets from the last two years, for searching by card name when the set the AI read is wrong.
const RECENT_DAYS = 730;

/**
 * Find a card by name across every recent set in a catalog, ranked by how well
 * the printed number matches. First use downloads each recent set's card list
 * (cached afterwards), so this is only a fallback.
 */
export async function tcgcsvSearchByName({ name, number, setTotal }, cat = ENGLISH, { exactNumberOnly = false } = {}) {
  if (!name) return [];
  if (exactNumberOnly && !normalizeNumber(number)) return [];
  const cutoff = Date.now() - RECENT_DAYS * 864e5;
  const recent = (await groups(cat)).filter((g) => Date.parse(g.publishedOn) >= cutoff);
  const want = normalizeNumber(number);
  const total = parseInt(setTotal, 10);
  const found = [];
  const queue = [...recent];
  async function worker() {
    while (queue.length) {
      const g = queue.shift();
      const hit = await findProducts(cat, g.groupId, name, "").catch(() => null);
      if (hit) for (const o of hit.others) found.push(toCard(g, o.product, o.rows));
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const score = (c) => {
    const [n, d] = String(c.number).split("/");
    let sc = 0;
    if (want && normalizeNumber(n) === want) sc += 2;
    if (total && parseInt(d, 10) === total) sc += 1;
    return sc;
  };
  const ranked = found.sort((a, b) => score(b) - score(a));
  return (exactNumberOnly ? ranked.filter((c) => score(c) >= 2) : ranked).slice(0, 8);
}

/** Price one English card identified by pokemontcg.io (set name + release date + number). */
export async function tcgcsvPrice({ name, number, setName, releaseDate }) {
  const [group] = await rankGroups(ENGLISH, { setName, releaseDate }, 1);
  if (!group) return null;
  const { exact } = await findProducts(ENGLISH, group.groupId, name, number);
  return exact ? toCard(group, exact.product, exact.rows) : null;
}

/**
 * Look a card up in TCGCSV alone: Japanese cards (pokemontcg.io is English-only),
 * or English cards the AI read a set for. Exact number matches come first, then
 * the card's other printings in the same set. Needs a set code or set name.
 */
export async function tcgcsvSearch({ name, number, setName, setCode, setTotal }, cat = ENGLISH) {
  if (!name || (!setName && !setCode)) return [];
  const exacts = [];
  const others = [];
  const candidates = await rankGroups(cat, { setName, setCode }, 6);
  const hits = await Promise.all(candidates.map((g) => findProducts(cat, g.groupId, name, number).catch(() => null)));
  candidates.forEach((g, i) => {
    const hit = hits[i];
    if (!hit) return;
    if (hit.exact) exacts.push(toCard(g, hit.exact.product, hit.exact.rows));
    // Only the best-matching set's other printings; later sets are weaker guesses.
    if (!others.length) others.push(...hit.others.map((o) => toCard(g, o.product, o.rows)));
  });
  // Prefer the printing whose "/total" matches what was read off the card.
  const total = parseInt(setTotal, 10);
  if (total) {
    const denom = (c) => parseInt(String(c.number).split("/")[1], 10);
    exacts.sort((a, b) => (denom(b) === total) - (denom(a) === total));
  }
  const seen = new Set();
  const out = [...exacts, ...others].filter((c) => !seen.has(c.productId) && seen.add(c.productId)).slice(0, 8);
  out.hasExact = exacts.length > 0; // false: only other printings of that name in the matched sets
  return out;
}

/**
 * Find a set name inside typed text ("umbreon vmax 215/203 evolving skies"),
 * using TCGplayer's set list. Returns the set's name and the words it used.
 */
export async function findSetInText(text, cat = ENGLISH) {
  const have = words(text);
  let best = null;
  for (const g of await groups(cat)) {
    const w = words(g.name);
    if (w.size < 1 || [...w].every((x) => /^\d+$/.test(x))) continue;
    if (![...w].every((x) => have.has(x))) continue;
    if (!best || w.size > best.words.size) best = { name: g.name, words: w };
  }
  return best;
}
