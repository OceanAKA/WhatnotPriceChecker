// Shared by every AI provider so they all return the same card shape.

export const CARD_SCHEMA = {
  type: "object",
  properties: {
    card_visible: {
      type: "boolean",
      description: "True if the front of a single Pokemon card is clearly the focus of the frame.",
    },
    card_back: {
      type: "boolean",
      description: "True if the card being shown is turned around so its back (the blue Poke Ball design) faces the camera. Then card_visible is false and the other fields are empty.",
    },
    name: {
      type: "string",
      description: 'English name of the card, including suffixes like "ex", "V", "VMAX", "GX", even if the card is printed in another language (e.g. "Charizard ex" for a Japanese リザードンex). Empty if unknown.',
    },
    number_legible: {
      type: "boolean",
      description: "True only if you can actually read every character of the collector number in this image. False if it is blurry, cut off, covered, too small, or you would be inferring it from the artwork or from memory.",
    },
    number: {
      type: "string",
      description: 'Collector number before the slash exactly as read, e.g. "199" from 199/165, or a full code like "TG05", "SV107", "GG44". Must be empty when number_legible is false.',
    },
    set_total: {
      type: "string",
      description: 'Number after the slash, e.g. "165". Empty if unreadable or absent.',
    },
    set_code: {
      type: "string",
      description: 'Set code printed in the bottom corner next to the regulation mark, e.g. "MEW", "PBL", "SV2a", "sv8a". Empty if not printed or unreadable.',
    },
    set_name: {
      type: "string",
      description: "English set name if identifiable from the set code, set symbol, card style, or listing text. Empty if unsure.",
    },
    language: {
      type: "string",
      description: 'Printed language of the card, e.g. "English", "Japanese".',
    },
    graded: {
      type: "boolean",
      description: "True if the card is in a grading slab.",
    },
    grade_label: {
      type: "string",
      description: 'Grader, grade, and tier wording exactly as on the slab label, e.g. "PSA 10", "CGC 10 Gem Mint", "CGC Pristine 10", "BGS 9.5", "BGS Black Label 10". CGC Pristine and BGS Pristine / Black Label slabs say so on the label and sell for more than a regular 10, so include that word when present. Empty if not graded or unreadable.',
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
  },
  required: [
    "card_visible", "card_back", "name", "number_legible", "number", "set_total", "set_code", "set_name",
    "language", "graded", "grade_label", "confidence",
  ],
  additionalProperties: false,
};

export const SYSTEM = `You identify Pokemon trading cards from frames of Whatnot live-shopping streams.
The seller usually holds the current auction card up to the camera, sometimes in a sleeve, toploader, or grading slab, often with fingers or a glove covering part of it. The frame may be blurry, angled, or show a wall of other cards in the background; identify the one being presented, even if part of it is covered.
Read the collector number in the bottom corner whenever it is legible, since it pins the exact printing. Use the artwork, set symbol, and card frame to infer the set when the number is unclear.
Listing titles on Whatnot are usually generic placeholders such as "$1 Starting Card On Screen" because sellers run hundreds of cards through one listing. Ignore the listing text unless it names a specific card, and even then the card in the frame wins when they disagree.
Japanese and other non-English cards are common; report the printed language and still give the card's English name.
Never guess or recall a collector number: a wrong number prices the wrong card. If you cannot read it in this image, set number_legible to false and leave number empty. The same goes for set_total and set_code.`;

export function userText(listingHint) {
  return listingHint
    ? `Listing text on the page: "${listingHint}"\n\nIdentify the card in this frame.`
    : "Identify the card in this frame.";
}

// Some models wrap the JSON in prose or code fences; pull out the object.
export function parseCardJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("The AI's answer wasn't valid JSON; try scanning again.");
  }
}
