import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";

const CARD_SCHEMA = {
  type: "object",
  properties: {
    card_visible: {
      type: "boolean",
      description: "True if a single Pokemon card is clearly the focus of the frame.",
    },
    name: {
      type: "string",
      description: 'Card name exactly as printed in English, including suffixes like "ex", "V", "VMAX", "GX". Empty if unknown.',
    },
    number: {
      type: "string",
      description: 'Collector number before the slash, e.g. "199" from 199/165, or a full code like "TG05", "SV107", "GG44". Empty if unreadable.',
    },
    set_total: {
      type: "string",
      description: 'Number after the slash, e.g. "165". Empty if unreadable or absent.',
    },
    set_name: {
      type: "string",
      description: "English set name if identifiable from the set symbol, card style, or listing text. Empty if unsure.",
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
      description: 'Grader and grade from the slab label, e.g. "PSA 10". Empty if not graded or unreadable.',
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
    notes: {
      type: "string",
      description: "One short sentence on what is visible or why identification is uncertain.",
    },
  },
  required: [
    "card_visible", "name", "number", "set_total", "set_name",
    "language", "graded", "grade_label", "confidence", "notes",
  ],
  additionalProperties: false,
};

const SYSTEM = `You identify Pokemon trading cards from frames of Whatnot live-shopping streams.
The seller usually holds the current auction card up to the camera, sometimes in a sleeve, toploader, or grading slab. The frame may be blurry, angled, or show other cards in the background; identify the one being presented.
Read the collector number in the bottom corner whenever it is legible, since it pins the exact printing. Use the artwork, set symbol, and card frame to infer the set when the number is unclear.
Listing titles on Whatnot are usually generic placeholders such as "$1 Starting Card On Screen" because sellers run hundreds of cards through one listing. Ignore the listing text unless it names a specific card, and even then the card in the frame wins when they disagree.
Never guess a number you cannot read; leave it empty instead.`;

/**
 * @param {string} apiKey
 * @param {string} imageBase64 JPEG, base64 without the data: prefix
 * @param {string} listingHint text scraped from the Whatnot page, may be empty
 */
export async function identifyCard(apiKey, imageBase64, listingHint = "") {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content = [
    {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
    },
    {
      type: "text",
      text: listingHint
        ? `Listing text on the page: "${listingHint}"\n\nIdentify the card in this frame.`
        : "Identify the card in this frame.",
    },
  ];

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: CARD_SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to analyze this frame.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's response was cut off; try scanning again.");
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text) throw new Error("Claude returned no answer.");
  return JSON.parse(text.text);
}

export function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key. Check it in ⚙ settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use " + MODEL + ".";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Wait a moment and scan again.";
  if (err instanceof Anthropic.BadRequestError) return "Anthropic rejected the request: " + err.message;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return String(err && err.message ? err.message : err);
}
