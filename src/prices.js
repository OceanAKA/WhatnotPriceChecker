// Price lookups against the free Pokemon TCG API (https://pokemontcg.io),
// which carries daily TCGPlayer + Cardmarket prices for English cards.

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
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
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

function normalizeNumber(number) {
  const n = (number || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!n) return "";
  // "025" -> "25"; codes like "TG05" or "SV107" stay as printed
  return /^\d+$/.test(n) ? String(parseInt(n, 10)) : n;
}

function rank(cards, { name, setTotal, setName }) {
  const total = parseInt(setTotal, 10);
  const wantName = (name || "").toLowerCase();
  const wantSet = (setName || "").toLowerCase().replace(/\s+set$/, "");
  const score = (c) => {
    let s = 0;
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

/**
 * Tries progressively looser queries until something matches.
 * @param {{name: string, number?: string, setTotal?: string, setName?: string}} card
 */
export async function searchCards(card) {
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
  if (lastError) throw new Error("The price database (pokemontcg.io) isn't responding. Try again in a moment.");
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
