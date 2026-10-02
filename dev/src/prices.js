// Card lookup: pokemontcg.io works out which card it is (search by name,
// number, set), then TCGCSV supplies current TCGplayer prices, since
// pokemontcg.io no longer has prices for new sets. Results come back in one
// display shape: {id, name, number, rarity, setName, image, url, prices[], ...}.

import { tcgcsvPrice, tcgcsvSearch, tcgcsvSearchByName, normalizeNumber, JAPANESE } from "./tcgcsv.js";

const API = "https://api.pokemontcg.io/v2/cards";
const SELECT = "id,name,number,rarity,set,images,tcgplayer,cardmarket";

let priceApiKey = "";
export function setPriceApiKey(key) {
  priceApiKey = (key || "").trim();
}

// The API intermittently answers 5xx for valid queries, so retry those.
async function apiSearch(q, pageSize = 24) {
  const url =
    `${API}?q=${encodeURIComponent(q)}` +
    `&pageSize=${pageSize}&orderBy=-set.releaseDate&select=${SELECT}`;
  const headers = priceApiKey ? { "X-Api-Key": priceApiKey } : {};
  let lastError;
  // Its 5xx errors are random rather than load-related, so retry almost immediately.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 150 * attempt));
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return (await res.json()).data || [];
      lastError = new Error(`Price API error ${res.status}`);
      if (res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function rank(cards, { name, number, setTotal, setName }) {
  const total = parseInt(setTotal, 10);
  const wantNumber = normalizeNumber(number);
  const wantName = (name || "").toLowerCase();
  const wantSet = (setName || "").toLowerCase().replace(/\s+set$/, "");
  const score = (c) => {
    let s = 0;
    // The collector number pins the exact printing, so it outweighs everything else.
    if (wantNumber && normalizeNumber(c.number) === wantNumber) s += 10;
    if (wantName && c.name.toLowerCase() === wantName) s += 4;
    if (total && c.set && c.set.printedTotal === total) s += 2;
    if (wantSet && c.set && c.set.name) {
      const have = c.set.name.toLowerCase();
      if (have === wantSet) s += 3;
      else if (have.includes(wantSet) || wantSet.includes(have)) s += 1;
    }
    return s;
  };
  // stable sort keeps newest-first among ties
  return cards
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

// Prices update daily, so a few hours of caching is safe and makes re-scans instant.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RESULTS = 6;
const cache = new Map();

/**
 * Find a card and its current prices.
 * @param {{name: string, number?: string, setTotal?: string, setName?: string, setCode?: string, language?: string}} card
 */
export async function searchCards(card) {
  const fields = [card.name, card.number, card.setTotal, card.setName, card.setCode, card.language];
  const key = JSON.stringify(fields.map((v) => (v || "").toLowerCase().trim()));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.result, cached: true };

  if (/japan/i.test(card.language || "")) {
    let cards = await tcgcsvSearch(card, JAPANESE).catch(() => []);
    // The AI often misreads small Japanese set codes; find the card by name instead.
    if (!cards.length) cards = await tcgcsvSearchByName(card, JAPANESE).catch(() => []);
    if (cards.length) {
      const result = { cards, language: "Japanese" };
      cache.set(key, { at: Date.now(), result });
      return result;
    }
    // Not found in the Japanese catalog: fall through to the English printing.
  }

  // TCGCSV is fast and reliable, so whenever the AI read a set, try it first.
  if (card.setCode || card.setName) {
    const direct = await tcgcsvSearch(card).catch(() => []);
    if (direct.length) {
      const result = { cards: direct };
      cache.set(key, { at: Date.now(), result });
      return result;
    }
  }

  let found = [];
  let identifyError = null;
  try {
    found = (await identifyCards(card)).cards.slice(0, MAX_RESULTS);
  } catch (e) {
    identifyError = e;
  }

  let cards;
  if (found.length) {
    cards = await Promise.all(found.map(priceCard));
  } else {
    // pokemontcg.io is down or didn't know the card: try TCGCSV directly with the set name the AI read.
    cards = await tcgcsvSearch(card).catch(() => []);
    if (!cards.length && identifyError) {
      throw new Error("The card database isn't responding. Try again in a moment.");
    }
  }
  const result = { cards };
  if (cards.length) cache.set(key, { at: Date.now(), result });
  return result;
}

function fromPokemonTcg(c) {
  const tp = (c.tcgplayer && c.tcgplayer.prices) || {};
  const label = (k) => k.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase());
  return {
    id: c.id,
    name: c.name,
    number: c.number,
    rarity: c.rarity || "",
    setName: c.set ? c.set.name : "",
    image: c.images ? c.images.small : "",
    url: tcgplayerSearchUrl(c),
    prices: Object.entries(tp).map(([k, p]) => ({ label: label(k), market: p.market, low: p.low, high: p.high })),
    cardmarketTrend: c.cardmarket && c.cardmarket.prices ? c.cardmarket.prices.trendPrice : null,
  };
}

function tcgplayerSearchUrl(c) {
  const q = `${c.name} ${c.number || ""}`.trim();
  return `https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&q=${encodeURIComponent(q)}`;
}

// Prefer TCGCSV's current prices and direct product link; keep pokemontcg.io's data as a fallback.
async function priceCard(c) {
  const base = fromPokemonTcg(c);
  const live = await tcgcsvPrice({
    name: c.name,
    number: c.number,
    setName: c.set && c.set.name,
    releaseDate: c.set && c.set.releaseDate,
  }).catch(() => null);
  if (!live) return base;
  return {
    ...base,
    productId: live.productId,
    url: live.url,
    prices: live.prices.length ? live.prices : base.prices,
    image: base.image || live.image,
  };
}

async function identifyCards(card) {
  const name = (card.name || "").replace(/"/g, "").trim();
  if (!name) return { cards: [], query: "" };
  const number = normalizeNumber(card.number);
  const total = parseInt(card.setTotal, 10);
  const quoted = `name:"${name}"`;
  const attempts = [];

  // "!name" is an exact match; plain "name" also matches e.g. "Pikachu & Zekrom-GX"
  if (number) attempts.push(`${quoted} number:${number}`);
  if (total) attempts.push(`!${quoted} set.printedTotal:${total}`);
  attempts.push(`!${quoted}`);
  attempts.push(quoted);
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length) attempts.push(words.map((w) => `name:${w}*`).join(" "));
  if (words.length > 1) attempts.push(`name:${words[0]}*`);

  let lastError = null;
  for (const q of attempts) {
    try {
      const cards = await apiSearch(q);
      if (cards.length) return { cards: rank(cards, { ...card, name }), query: q };
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return { cards: [], query: attempts[attempts.length - 1] };
}

// Turn a typed or pasted listing title into {name, number, setTotal}.
export function parseTitle(raw) {
  let s = " " + (raw || "").toLowerCase() + " ";

  let number = "";
  let setTotal = "";
  const numMatch = s.match(/\b([a-z]{0,3}\d{1,3})\s*\/\s*([a-z]{0,3}\d{1,3})\b/);
  if (numMatch) {
    number = numMatch[1];
    setTotal = numMatch[2].replace(/^\D+/, "");
  }
  s = s.replace(/\b[a-z]{0,3}\d{1,3}\s*\/\s*[a-z]{0,3}\d{1,3}\b/g, " ");

  s = s
    .replace(/\b(psa|cgc|bgs|beckett|ace|tag)\s*\d{1,2}(\.5)?\b/g, " ")
    .replace(/\b(gem\s*mint|mint|near\s*mint|nm|lp|mp|hp|dmg|damaged|slab(bed)?|graded|raw|pack\s*fresh)\b/g, " ")
    .replace(/\b(holo(foil)?|reverse|foil|non[-\s]?holo|full\s*art|alt\s*art|secret\s*rare|ultra\s*rare|illustration\s*rare|promo)\b/g, " ")
    .replace(/\b(pokemon|pok[eé]mon|tcg|card|cards|english|japanese|jpn|eng)\b/g, " ")
    .replace(/\b(giveaway|break|spot|random|mystery|bundle|lot|x\d+)\b/g, " ")
    .replace(/[^\w\s'&.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = s
    .split(" ")
    .filter((w) => w && !/^\d+$/.test(w))
    .slice(0, 4);
  return { name: words.join(" "), number, setTotal, setName: "" };
}
