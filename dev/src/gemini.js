// Google Gemini via the free tier of the Gemini API (key from aistudio.google.com).
// Each model has its own free quota, so when one is used up we move on to the next.

import { CARD_SCHEMA, SYSTEM, userText, parseCardJson } from "./prompt.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Used when the model list can't be fetched. Newest first.
const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const MODEL_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;

const cooldownUntil = new Map(); // model -> timestamp it can be tried again
let modelCache = { key: "", at: 0, models: [] };

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// responseSchema takes an OpenAPI subset that has no additionalProperties.
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties") continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

function versionOf(name) {
  const m = name.match(/^gemini-(\d+)(?:\.(\d+))?/);
  return m ? Number(m[1]) + Number(m[2] || 0) / 100 : 0;
}

// Stable vision-capable Flash models only: no previews, image generators, TTS, or live models.
export function pickModels(names) {
  const usable = names.filter((n) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(n));
  return usable.sort((a, b) => {
    const liteA = a.endsWith("-lite"), liteB = b.endsWith("-lite");
    if (liteA !== liteB) return liteA ? 1 : -1;
    return versionOf(b) - versionOf(a);
  });
}

async function listModels(apiKey) {
  if (modelCache.key === apiKey && Date.now() - modelCache.at < MODEL_LIST_TTL_MS && modelCache.models.length) {
    return modelCache.models;
  }
  try {
    const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey } });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new GeminiError("Invalid Gemini API key. Check it in ⚙ settings.", res.status);
    }
    if (!res.ok) return FALLBACK_MODELS;
    const json = await res.json();
    const names = (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    const models = pickModels(names);
    if (!models.length) return FALLBACK_MODELS;
    modelCache = { key: apiKey, at: Date.now(), models };
    return models;
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    return FALLBACK_MODELS;
  }
}

// Card reading doesn't need deep reasoning; low thinking cuts latency a lot.
// Lightest thinking level each model accepts: "minimal" where supported (and
// the default on Flash-Lite), else "low", else the model's own default.
const THINKING_LEVELS = ["minimal", "low", null];
const thinkingLevel = new Map(); // model -> index into THINKING_LEVELS that it accepted

// A stalled request on a busy free tier shouldn't hold the scan; move to the next model.
const REQUEST_TIMEOUT_MS = 12000;
const SLOW_COOLDOWN_MS = 2 * 60 * 1000;

// Per Google's docs, 3.7 / 3.8 Flash don't accept "minimal"; start them at "low" so a
// fresh background worker (Chrome restarts it after ~30 s idle) doesn't waste a request.
const NO_MINIMAL = /^gemini-3\.[78]-flash$/;

async function callModel(apiKey, model, imageBase64, listingHint) {
  const first = thinkingLevel.has(model) ? thinkingLevel.get(model) : NO_MINIMAL.test(model) ? 1 : 0;
  for (let i = first; i < THINKING_LEVELS.length; i++) {
    try {
      const card = await callModelOnce(apiKey, model, imageBase64, listingHint, THINKING_LEVELS[i]);
      thinkingLevel.set(model, i);
      return card;
    } catch (e) {
      // Any 400 other than a bad key is most likely the thinking level; try a lighter config.
      const rejectedLevel = e instanceof GeminiError && e.status === 400 && !/api key/i.test(e.message);
      if (!rejectedLevel || i === THINKING_LEVELS.length - 1) throw e;
    }
  }
}

async function callModelOnce(apiKey, model, imageBase64, listingHint, level) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          { text: userText(listingHint) },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiSchema(CARD_SCHEMA),
      ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}/models/${model}:generateContent`, {
      signal: controller.signal,
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new GeminiError(`${model} took over ${REQUEST_TIMEOUT_MS / 1000}s`, 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
    throw new GeminiError(msg, res.status);
  }

  const cand = json.candidates && json.candidates[0];
  if (!cand) {
    const reason = json.promptFeedback && json.promptFeedback.blockReason;
    throw new GeminiError(reason ? `Gemini blocked this frame (${reason}).` : "Gemini returned no answer.", 200);
  }
  const text = ((cand.content && cand.content.parts) || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text) throw new GeminiError(`Gemini returned no answer (${cand.finishReason || "unknown reason"}).`, 200);
  return parseCardJson(text);
}

/**
 * Same contract as the Claude identifier, plus which model answered.
 * @returns {Promise<object>} card fields from CARD_SCHEMA and `model`
 */
export async function identifyCardGemini(apiKey, imageBase64, listingHint = "") {
  const models = await listModels(apiKey);
  const now = Date.now();
  const ready = models.filter((m) => (cooldownUntil.get(m) || 0) <= now);
  const order = ready.length ? ready : models;

  let quotaHit = false;
  let lastError = null;
  const trace = []; // which models were tried and how long each took, shown when a scan is slow
  for (const model of order) {
    const started = Date.now();
    try {
      const card = await callModel(apiKey, model, imageBase64, listingHint);
      trace.push({ model, ms: Date.now() - started });
      return { ...card, model, trace };
    } catch (e) {
      lastError = e;
      const status = e instanceof GeminiError ? e.status : 0;
      trace.push({ model, ms: Date.now() - started, status });
      if (status === 400 && /api key/i.test(e.message)) {
        throw new GeminiError("Invalid Gemini API key. Check it in ⚙ settings.", 400);
      }
      if (status === 401 || status === 403) {
        throw new GeminiError("Gemini rejected this API key: " + e.message, status);
      }
      if (status === 429) {
        quotaHit = true;
        cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
        continue;
      }
      if (status === 504) {
        cooldownUntil.set(model, Date.now() + SLOW_COOLDOWN_MS);
        continue;
      }
      // Model retired, overloaded, or a transient server error: try the next one.
      if (status === 404 || status >= 500) continue;
      throw e;
    }
  }
  if (quotaHit) {
    throw new GeminiError(
      "Gemini's free limit is used up for now. Wait a few minutes (or until tomorrow for the daily limit), or switch to Claude in ⚙ settings.",
      429,
    );
  }
  throw lastError || new GeminiError("No Gemini model was available.", 0);
}
