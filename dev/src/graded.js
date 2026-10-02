// Graded (slabbed) card prices from PokemonPriceTracker, which summarizes
// recent eBay sales per grade. TCGplayer only prices raw cards.
// Used directly with a user's own key, or by the card-ID service with the project's key.

const PPT = "https://www.pokemonpricetracker.com/api/v2/cards";

/**
 * "CGC 10 Gem Mint"  -> { grader: "CGC", grade: "10", tier: "",         label: "CGC 10",          key: "cgc10" }
 * "CGC Pristine 10"  -> { grader: "CGC", grade: "10", tier: "pristine", label: "CGC Pristine 10", key: "cgc10pristine" }
 * Pristine (CGC, BGS) and Black Label (BGS) 10s are separate, pricier tiers.
 */
export function parseGrade(label) {
  const text = String(label || "").toUpperCase();
  const m = text.match(/\b(PSA|CGC|BGS|BECKETT|SGC|TAG|ACE)\b\D{0,20}?(10|[1-9](?:\.5)?)\b/);
  if (!m) return null;
  const grader = m[1] === "BECKETT" ? "BGS" : m[1];
  const grade = m[2];
  let tier = "";
  if (grade === "10" && /BLACK\s*LABEL/.test(text) && grader === "BGS") tier = "blacklabel";
  else if (grade === "10" && /PRISTINE/.test(text) && (grader === "CGC" || grader === "BGS")) tier = "pristine";
  const tierName = { pristine: "Pristine", blacklabel: "Black Label" }[tier];
  return {
    grader,
    grade,
    tier,
    label: tierName ? `${grader} ${tierName} ${grade}` : `${grader} ${grade}`,
    key: norm(grader + grade + tier),
  };
}

/** Response keys that can hold one grade's data ("cgc10pristine" may appear as "cgcPristine10", ...). */
function acceptedKeys(gradeKey) {
  const k = norm(gradeKey);
  const m = k.match(/^([a-z]+?)(\d+)(pristine|blacklabel)?$/);
  if (!m || !m[3]) return new Set([k]);
  const [, grader, grade, tier] = m;
  return new Set([k, `${grader}${tier}${grade}`, `${grader}${tier}`, `${tier}${grade}`]);
}

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

// Prices move fast after a release, so ask for the last week of eBay sales.
const RECENT_DAYS = 7;

let daysRejected = false; // the plan refused a custom window once; stop asking (each call costs credits)

export async function fetchGradedCard(apiKey, tcgPlayerId) {
  const base = `${PPT}?tcgPlayerId=${encodeURIComponent(tcgPlayerId)}&includeEbay=true`;
  const get = (url) => fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  let res = await get(daysRejected ? base : `${base}&days=${RECENT_DAYS}`);
  // Some plans cap the window; retry with the API's default rather than fail.
  if (!daysRejected && (res.status === 400 || res.status === 402 || res.status === 403)) {
    const retry = await get(base);
    if (retry.ok) {
      daysRejected = true;
      res = retry;
    }
  }
  if (!res.ok) {
    const err = new Error(`Graded price API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return (Array.isArray(json.data) ? json.data[0] : json.data) || null;
}

// Summary numbers, most trustworthy first. New releases sell high at first,
// so an all-period average can sit well above today's price.
const PRICE_BASES = [
  [["smartMarketPrice"], "market"],
  [["medianPrice", "median"], "median"],
  [["averagePrice", "average", "avgPrice", "avg"], "avg"],
  [["marketPrice", "price"], "price"],
];
const COUNT_FIELDS = ["salesCount", "count", "totalSales", "sales", "numberOfSales"];

function firstNumber(obj, fields, depth = 0) {
  if (typeof obj === "number" && Number.isFinite(obj)) return obj;
  if (!obj || typeof obj !== "object") return null;
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v && typeof v === "object" && typeof v.value === "number") return v.value;
  }
  if (depth < 2) {
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const found = firstNumber(v, fields, depth + 1);
        if (found != null) return found;
      }
    }
  }
  return null;
}

/**
 * Pull one grade's sales summary out of a PokemonPriceTracker card. The
 * response nests grades under eBay data (e.g. ebay.cgc10 or ebay.salesByGrade.cgc10),
 * so search by normalized key instead of hard-coding one path.
 * @returns {{price: number, count: number|null} | null}
 */
export function pickGradedPrice(card, gradeKey) {
  if (!card) return null;
  const want = norm(gradeKey);
  const accepted = acceptedKeys(want);
  const roots = [card.ebay, card.graded, card.gradedPrices, card].filter(Boolean);
  const seen = new Set();
  const stack = roots.map((r) => [r, 0]);
  while (stack.length) {
    const [node, depth] = stack.shift();
    if (!node || typeof node !== "object" || seen.has(node) || depth > 4) continue;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (accepted.has(norm(k))) {
        const lastSold = pickLastSold(v) || lastSoldFromAnyList(card, want);
        const summary = gradeSummary(v);
        if (lastSold || summary) {
          return {
            price: summary ? summary.price : null,
            basis: summary ? summary.basis : null,
            count: firstNumber(v, COUNT_FIELDS),
            lastSold,
          };
        }
      }
      if (v && typeof v === "object") stack.push([v, depth + 1]);
    }
  }
  return null;
}

/** @returns {{price: number, basis: string} | null} */
function gradeSummary(node) {
  for (const [fields, basis] of PRICE_BASES) {
    const price = firstNumber(node, fields);
    if (price != null && price > 0) return { price, basis };
  }
  return null;
}

const SALE_PRICE_FIELDS = ["soldPrice", "salePrice", "price", "totalPrice", "amount", "value"];
const SALE_DATE_FIELDS = ["soldDate", "saleDate", "dateSold", "endDate", "date", "soldAt", "timestamp"];

function saleDate(sale) {
  for (const f of SALE_DATE_FIELDS) {
    const t = Date.parse(sale[f]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** "CGC 10", {grader: "CGC", grade: 10}, or a title like "... CGC 10 Gem Mint" -> "cgc10" */
function saleGradeKey(sale) {
  const grader = sale.grader || sale.gradingCompany || sale.company;
  const grade = sale.grade ?? sale.gradeValue;
  if (grader && grade != null) return norm(`${grader}${grade}`);
  for (const f of ["grade", "gradeLabel", "condition", "title", "name"]) {
    const parsed = typeof sale[f] === "string" ? parseGrade(sale[f]) : null;
    if (parsed) return parsed.key;
  }
  return null;
}

/** Newest sale of this grade from any list of sales in the response. */
function lastSoldFromAnyList(card, want) {
  let best = null;
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 5) return;
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        for (const sale of v) {
          if (!sale || typeof sale !== "object" || saleGradeKey(sale) !== want) continue;
          const price = firstNumber(sale, SALE_PRICE_FIELDS);
          const t = saleDate(sale);
          if (price > 0 && t && (!best || t > best.t)) best = { price, t };
        }
      } else if (v && typeof v === "object") {
        visit(v, depth + 1);
      }
    }
  };
  visit(card, 0);
  return best ? { price: best.price, date: new Date(best.t).toISOString() } : null;
}

/** Individual sales listed under a grade's data, newest first. */
function recentSales(gradeNode) {
  const out = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        for (const sale of v) {
          if (!sale || typeof sale !== "object") continue;
          const price = firstNumber(sale, SALE_PRICE_FIELDS);
          const t = saleDate(sale);
          if (price > 0 && t) out.push({ price, t });
        }
      } else if (v && typeof v === "object") {
        visit(v, depth + 1);
      }
    }
  };
  visit(gradeNode, 0);
  return out.sort((a, b) => b.t - a.t);
}

/**
 * Most recent individual sale for one grade, from a sales list or explicit
 * last-sale fields. @returns {{price: number, date: string|null} | null}
 */
export function pickLastSold(gradeNode) {
  if (!gradeNode || typeof gradeNode !== "object") return null;
  const sales = recentSales(gradeNode);
  if (sales.length) return { price: sales[0].price, date: new Date(sales[0].t).toISOString() };
  const direct = firstNumber(gradeNode, ["lastSoldPrice", "lastSalePrice", "lastSold"]);
  if (direct != null && direct > 0) {
    const t = Date.parse(gradeNode.lastSoldDate || gradeNode.lastSaleDate || "");
    return { price: direct, date: Number.isFinite(t) ? new Date(t).toISOString() : null };
  }
  return null;
}

export function ebaySoldUrl(name, number, gradeLabel) {
  const g = parseGrade(gradeLabel);
  let q = [name, number, gradeLabel].filter(Boolean).join(" ");
  // A plain 10 search would otherwise mix in pricier Pristine / Black Label sales.
  if (g && g.grade === "10" && !g.tier) {
    if (g.grader === "CGC") q += " -pristine";
    if (g.grader === "BGS") q += " -pristine -black";
  }
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1`;
}
