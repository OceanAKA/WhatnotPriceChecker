import Anthropic from "@anthropic-ai/sdk";
import { CARD_SCHEMA, SYSTEM, userText, parseCardJson } from "./prompt.js";

export const MODEL = "claude-opus-5-5";

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
      text: userText(listingHint),
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
  return { ...parseCardJson(text.text), model: MODEL };
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
