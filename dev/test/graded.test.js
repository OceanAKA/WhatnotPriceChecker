// Grade parsing and pulling a grade's price out of differently shaped responses.
import { parseGrade, pickGradedPrice, ebaySoldUrl } from "../src/graded.js";

const ok = (cond, label) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
const g = (s) => (parseGrade(s) || {}).key;

ok(g("CGC 10") === "cgc10", "CGC 10");
ok(g("CGC 10 Pristine") === "cgc10pristine", "CGC 10 Pristine is its own tier");
ok(g("PSA GEM MT 10") === "psa10", "PSA GEM MT 10");
ok(g("Beckett 9.5") === "bgs95", "Beckett 9.5 -> BGS 9.5");
ok(g("bgs 9.5 gem mint") === "bgs95", "bgs 9.5 gem mint");
ok(parseGrade("") === null && parseGrade("raw") === null, "no grade -> null");
ok(parseGrade("PSA 9").label === "PSA 9", "label is tidy");

const shapes = {
  "ebay.cgc10.averagePrice": { ebay: { cgc10: { averagePrice: 412.5, salesCount: 7 } } },
  "ebay.salesByGrade.cgc10.stats": { ebay: { salesByGrade: { cgc10: { stats: { average: 410, count: 6 } } } } },
  "ebay['CGC 10'].smartMarketPrice": { ebay: { "CGC 10": { smartMarketPrice: 399, salesCount: 3 } } },
  "graded.cgc_10.medianPrice": { graded: { cgc_10: { medianPrice: 405 } } },
};
for (const [name, card] of Object.entries(shapes)) {
  const hit = pickGradedPrice(card, "cgc10");
  ok(hit && hit.price > 0, `finds price in ${name} (${hit && hit.price}${hit && hit.count ? ", " + hit.count + " sold" : ""})`);
}
ok(pickGradedPrice({ ebay: { psa10: { averagePrice: 900 } } }, "cgc10") === null, "other grades don't match");
ok(pickGradedPrice({ ebay: { cgc10: { averagePrice: 0 } } }, "cgc10") === null, "zero price ignored");

const withSales = { ebay: { cgc10: { averagePrice: 52, salesCount: 3, sales: [
  { soldPrice: 61, soldDate: "2026-08-20" }, { soldPrice: 37, soldDate: "2026-09-04" }, { soldPrice: 58, soldDate: "2026-07-01" },
] } } };
let hit = pickGradedPrice(withSales, "cgc10");
ok(hit.lastSold && hit.lastSold.price === 37 && hit.lastSold.date.startsWith("2026-09-04"), `last sold = most recent sale (${JSON.stringify(hit.lastSold)})`);
hit = pickGradedPrice({ ebay: { psa10: { averagePrice: 800, lastSoldPrice: 750, lastSoldDate: "2026-09-30" } } }, "psa10");
ok(hit.lastSold && hit.lastSold.price === 750, "explicit last-sale fields");
hit = pickGradedPrice({ ebay: { psa9: { averagePrice: 100 } } }, "psa9");
ok(hit.price === 100 && hit.lastSold === null, "no sales list -> average only");

// A new release: early sales high, recent ones settled. Last sold is the newest sale.
hit = pickGradedPrice({ ebay: { cgc10: { avg: 54.11, salesCount: 159, sales: [
  { price: 85, date: "2026-08-01" }, { price: 39.99, date: "2026-10-01" }, { price: 28, date: "2026-09-30" },
] } } }, "cgc10");
ok(hit.lastSold.price === 39.99 && hit.lastSold.date.startsWith("2026-10-01"), `last sold is the newest sale ($${hit.lastSold.price})`);
hit = pickGradedPrice({ ebay: { cgc10: { avg: 54.11, median: 36, salesCount: 159 } } }, "cgc10");
ok(hit.price === 36 && hit.basis === "median" && hit.lastSold === null, `no sales list -> median preferred over average ($${hit.price})`);

// Sales in one combined list, each tagged with its grade.
hit = pickGradedPrice({ ebay: { cgc10: { median: 64.99, salesCount: 86 }, recentSales: [
  { title: "Espeon ex 175 CGC 10 Gem Mint", price: 39.99, soldDate: "2026-09-29" },
  { title: "Espeon ex 175 PSA 10", price: 120, soldDate: "2026-10-01" },
  { grader: "CGC", grade: 10, price: 43, soldDate: "2026-10-01" },
] } }, "cgc10");
ok(hit.lastSold && hit.lastSold.price === 43, `last sold found in a combined list, other grades ignored ($${hit.lastSold && hit.lastSold.price})`);

// Pristine / Black Label are their own tiers.
ok(g("CGC Pristine 10") === "cgc10pristine" && parseGrade("CGC Pristine 10").label === "CGC Pristine 10", "CGC Pristine 10");
ok(g("CGC 10 PRISTINE") === "cgc10pristine", "CGC 10 PRISTINE");
ok(g("CGC 10 Gem Mint") === "cgc10" && parseGrade("CGC 10 Gem Mint").label === "CGC 10", "CGC 10 Gem Mint stays cgc10");
ok(g("BGS Black Label 10") === "bgs10blacklabel", "BGS Black Label 10");
ok(g("BGS 10 Pristine") === "bgs10pristine", "BGS Pristine 10");
ok(g("PSA 10 Gem Mint") === "psa10", "PSA has no Pristine tier");
const both = { ebay: { cgc10: { median: 30 }, cgcPristine10: { median: 75 } } };
ok(pickGradedPrice(both, "cgc10").price === 30, "Gem Mint 10 price not mixed with Pristine");
ok(pickGradedPrice(both, "cgc10pristine").price === 75, "Pristine 10 price found under cgcPristine10");
ok(pickGradedPrice({ ebay: { cgc10: { median: 30 } } }, "cgc10pristine") === null, "no Pristine data -> no price (not the Gem Mint one)");
hit = pickGradedPrice({ ebay: { cgc10: { median: 30 }, sales: [
  { title: "Turtwig 040 CGC 10 Pristine", price: 39.99, soldDate: "2026-10-01" },
  { title: "Turtwig 040 CGC 10 Gem Mint", price: 26, soldDate: "2026-09-30" },
] } }, "cgc10");
ok(hit.lastSold && hit.lastSold.price === 26, `Gem Mint last sold ignores the Pristine sale ($${hit.lastSold && hit.lastSold.price})`);
ok(decodeURIComponent(ebaySoldUrl("Turtwig", "040", "CGC 10")).includes("CGC 10 -pristine"), "Gem Mint eBay search excludes Pristine");
ok(!decodeURIComponent(ebaySoldUrl("Turtwig", "040", "CGC Pristine 10")).includes("-pristine"), "Pristine eBay search keeps Pristine");
