// Exercises the Gemini path with a stubbed fetch: model picking, quota
// fallback to the next model, bad-key handling, and the request shape.
import { identifyCardGemini, pickModels } from "../src/gemini.js";

const ok = (cond, label) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

ok(
  JSON.stringify(pickModels(["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-3.1-flash-image", "gemini-3.5-flash", "gemini-3.1-pro-preview"])) ===
    JSON.stringify(["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]),
  "pickModels keeps stable Flash models, newest first, lite last",
);

const CARD = { card_visible: true, name: "Charizard ex", number: "199", set_total: "165", set_name: "151", language: "English", graded: false, grade_label: "", confidence: "high", notes: "" };
let calls = [];
let lastBody;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push(url.replace("https://generativelanguage.googleapis.com/v1beta/", ""));
  const key = init.headers && init.headers["x-goog-api-key"];
  if (key === "bad") return json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
  if (url.includes("/models?")) {
    return json(200, { models: [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-005", supportedGenerationMethods: ["embedContent"] },
    ] });
  }
  lastBody = JSON.parse(init.body);
  if (url.includes("gemini-3.8-flash:")) return json(429, { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } });
  return json(200, { candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify(CARD) + "\n```" }] }, finishReason: "STOP" }] });
};

const card = await identifyCardGemini("good", "AAAA", "$1 Starting Card On Screen");
ok(card.name === "Charizard ex" && card.number === "199", "card parsed (even wrapped in a code fence)");
ok(card.model === "gemini-3.5-flash-lite", `fell back to next model after 429 (answered by ${card.model})`);
ok(calls[0].startsWith("models?"), "listed models first");
ok(lastBody.generationConfig.responseMimeType === "application/json", "asks for JSON output");
ok(!JSON.stringify(lastBody.generationConfig.responseSchema).includes("additionalProperties"), "schema has no additionalProperties");
ok(lastBody.contents[0].parts[0].inlineData.mimeType === "image/jpeg", "image sent as inline JPEG");
ok(lastBody.contents[0].parts[1].text.includes("$1 Starting Card On Screen"), "listing hint included");

calls = [];
await identifyCardGemini("good", "AAAA", "");
ok(calls.length === 1 && calls[0].startsWith("models/gemini-3.5-flash-lite"), "cooled-down model skipped, model list cached");

try {
  await identifyCardGemini("bad", "AAAA", "");
  ok(false, "bad key should throw");
} catch (e) {
  ok(/Invalid Gemini API key/.test(e.message), `bad key message: "${e.message}"`);
}

// Thinking level: "minimal" first, falling back when a model rejects it.
{
  const levels = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("/models?")) return json(200, { models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] });
    const body = JSON.parse(init.body);
    if (url.includes("gemini-3.5-flash")) {
      const lv = body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel;
      levels.push(lv || "none");
      if (lv === "minimal") return json(400, { error: { code: 400, message: "Invalid value at generation_config", status: "INVALID_ARGUMENT" } });
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(CARD) }] } }] });
    }
    const level = body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel;
    levels.push(level || "none");
    if (level === "minimal") return json(400, { error: { code: 400, message: "thinking_level minimal is not supported for this model", status: "INVALID_ARGUMENT" } });
    return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(CARD) }] } }] });
  };
  const c = await identifyCardGemini("good2", "AAAA", "");
  ok(c.name === "Charizard ex" && levels.join(",") === "low", `3.8 Flash starts at "low" (${levels.join(" -> ")})`);
  levels.length = 0;
  await identifyCardGemini("good2", "AAAA", "");
  ok(levels.join(",") === "low", `remembers the accepted level next time (${levels.join(",")})`);
  ok(Array.isArray(c.trace) && c.trace[0].model === "gemini-3.8-flash", "trace lists the model that answered");
}

// A stalled model is abandoned and the next one answers.
{
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("/models?")) return json(200, { models: [
      { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
    ] });
    if (url.includes("gemini-3.7-flash")) {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(CARD) }] } }] });
  };
  const t0 = Date.now();
  const c = await identifyCardGemini("good3", "AAAA", "");
  const took = Date.now() - t0;
  ok(c.model === "gemini-3.6-flash" && c.trace[0].status === 504 && took < 14000, `stalled model abandoned after ~12s, next model answered (${(took / 1000).toFixed(1)}s, ${c.trace.map((x) => x.model + ":" + (x.status || x.ms + "ms")).join(", ")})`);
}

// Other models try "minimal" first; any non-key 400 falls back (Google's wording may vary).
{
  const levels = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("/models?")) return json(200, { models: [{ name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] }] });
    const body = JSON.parse(init.body);
    const lv = body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel;
    levels.push(lv || "none");
    if (lv === "minimal") return json(400, { error: { code: 400, message: "Invalid value at generation_config", status: "INVALID_ARGUMENT" } });
    return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(CARD) }] } }] });
  };
  const c = await identifyCardGemini("good4", "AAAA", "");
  ok(c.name === "Charizard ex" && levels.join(",") === "minimal,low", `3.5 Flash: minimal rejected (other wording) -> low (${levels.join(" -> ")})`);
}
