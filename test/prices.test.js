// Live check against pokemontcg.io: does what Claude would return map to the right card?
import { searchCards, parseTitle } from "../src/prices.js";

const cases = [
  { name: "Charizard ex", number: "199", setTotal: "165", setName: "151" },
  { name: "Pikachu", number: "", setTotal: "102", setName: "Base Set" },
  { name: "Umbreon VMAX", number: "215", setTotal: "203", setName: "Evolving Skies" },
  parseTitle("PSA 10 Charizard ex 199/165 Pokemon 151"),
];
for (const c of cases) {
  const { cards, query } = await searchCards(c);
  const top = cards[0];
  const tp = top && top.tcgplayer && top.tcgplayer.prices;
  const market = tp ? Object.entries(tp).map(([k, v]) => `${k} $${v.market}`).join(", ") : "no price";
  console.log(`${JSON.stringify(c)}\n   query: ${query}\n   top:   ${top ? `${top.name} #${top.number} (${top.set.name}) -> ${market}` : "NONE"}`);
}
