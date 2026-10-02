// Live check against pokemontcg.io + TCGCSV: does what the AI reads map to the right card and a current price?
import { searchCards, parseTitle } from "../src/prices.js";

const ok = (cond, label) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
const show = (c) => (c ? `${c.name} #${c.number} (${c.setName}) ${c.prices.map((p) => `${p.label} $${p.market}`).join(", ") || "no price"}` : "NONE");

const cases = [
  { why: "number beats newer same-name card", card: { name: "Team Rocket's Moltres ex", number: "208", setTotal: "182", setName: "Destined Rivals" }, expect: (c) => c.number.startsWith("208") },
  { why: "2026 set has a price (was missing on pokemontcg.io)", card: { name: "Mega Darkrai ex", number: "116", setTotal: "084", setName: "Pitch Black", setCode: "PBL" }, expect: (c) => c.number.startsWith("116") && c.prices.length > 0 },
  { why: "Japanese card priced from the Japanese catalog", card: { name: "Charizard ex", number: "201", setTotal: "165", setName: "Pokemon Card 151", setCode: "SV2a", language: "Japanese" }, expect: (c) => c.number.startsWith("201") && c.prices.length > 0 },
  { why: "classic card", card: { name: "Pikachu", number: "", setTotal: "102", setName: "Base Set" }, expect: (c) => c.name === "Pikachu" && c.prices.length > 0 },
  { why: "151 SIR via TCGCSV with a direct product link", card: { name: "Charizard ex", number: "199", setTotal: "165", setName: "151" }, expect: (c) => c.number.startsWith("199") && /tcgplayer\.com\/product\//.test(c.url) },
  { why: "typed title", card: parseTitle("PSA 10 Umbreon VMAX 215/203 evolving skies"), expect: (c) => c.number.startsWith("215") },
  { why: "unreadable number lists every printing in the set", card: { name: "Charizard ex", number: "", setName: "151", setCode: "MEW" }, expect: (c, all) => all.length >= 3 && all.every((x) => x.name === "Charizard ex") },
  { why: "misread number still lists the right card's other printings", card: { name: "Charizard ex", number: "998", setName: "151", setCode: "MEW" }, expect: (c, all) => all.some((x) => x.number.startsWith("199")) },
  { why: "Japanese card with a misread set is found by name", card: { name: "Cynthia's Spiritomb", number: "208", setTotal: "100", setName: "Battle Partners", setCode: "sv9", language: "Japanese" }, expect: (c) => c.name === "Cynthia's Spiritomb" && c.number.startsWith("208/193") },
  { why: "apostrophe names match TCGplayer's (Misty's -> Mistys)", card: { name: "Misty's Psyduck", number: "193", setTotal: "182", setName: "Destined Rivals", setCode: "DRI" }, expect: (c) => c.number.startsWith("193/") },
];
for (const { why, card, expect } of cases) {
  const t = performance.now();
  try {
    const { cards } = await searchCards(card);
    ok(cards[0] && expect(cards[0], cards), `${why}: ${show(cards[0])}${cards.length > 1 ? ` (+${cards.length - 1}: ${cards.slice(1).map((c) => "#" + c.number).join(" ")})` : ""} [${Math.round(performance.now() - t)}ms]`);
  } catch (e) {
    ok(false, `${why}: ${e.message}`);
  }
}
const t = performance.now();
const again = await searchCards(cases[0].card);
ok(again.cached && performance.now() - t < 5, "repeat lookup is served from cache");
