// Card-ID service: a Cloudflare Worker that holds the project's API keys so
// extension users don't need their own. Reuses the extension's code, so both always agree.
//   POST /identify {image, hint, installId}       -> {card}         (Gemini)
//   POST /graded   {tcgPlayerId, grade, installId} -> {graded}       (PokemonPriceTracker)
//   GET  /tcgcsv/<category>/groups | /<category>/<group>/(products|prices)
//        cached relay of TCGCSV price data, which is meant for server-side use

import { identifyCardGemini } from "../dev/src/gemini.js";
import { fetchGradedCard, pickGradedPrice } from "../dev/src/graded.js";
import { USER_AGENT } from "../dev/src/tcgcsv.js";

const MAX_IMAGE_CHARS = 3_000_000; // ~2.2 MB JPEG; the extension sends far less
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const GRADED_TTL_S = 24 * 60 * 60;
const TCGCSV_TTL_S = 12 * 60 * 60; // TCGCSV updates once a day
const TCGCSV_PATH = /^\/tcgcsv\/(3|85)\/(groups|\d{1,7}\/(products|prices))$/;

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function respond(status, body, origin) {
  const headers = { "content-type": "application/json" };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function withinLimit(limiter, key) {
  if (!limiter) return true; // binding missing in local tests
  const { success } = await limiter.limit({ key });
  return success;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const allowed = allowedOrigins(env);
    // Origin can be faked outside a browser, so this only stops casual reuse
    // from other web pages; the rate limits are the real protection.
    const originOk = !allowed.length || allowed.includes(origin);
    const corsOrigin = originOk && origin ? origin : "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: originOk ? 204 : 403,
        headers: corsOrigin
          ? {
              "access-control-allow-origin": corsOrigin,
              "access-control-allow-methods": "POST",
              "access-control-allow-headers": "content-type",
              "access-control-max-age": "86400",
            }
          : {},
      });
    }
    if (url.pathname === "/health") return respond(200, { ok: true }, corsOrigin);
    if (url.pathname.startsWith("/tcgcsv/")) {
      if (request.method !== "GET") return respond(405, { error: "Use GET." }, corsOrigin);
      if (!originOk) return respond(403, { error: "This service only accepts requests from the extension." });
      return tcgcsv(url, request, env, corsOrigin);
    }
    if (url.pathname !== "/identify" && url.pathname !== "/graded") return respond(404, { error: "Not found." }, corsOrigin);
    if (request.method !== "POST") return respond(405, { error: "Use POST." }, corsOrigin);
    if (!originOk) return respond(403, { error: "This service only accepts requests from the extension." });
    if (url.pathname === "/graded") return graded(request, env, corsOrigin);

    let body;
    try {
      body = await request.json();
    } catch {
      return respond(400, { error: "Request body must be JSON." }, corsOrigin);
    }
    const { image, hint = "", installId } = body || {};
    if (typeof image !== "string" || !image || image.length > MAX_IMAGE_CHARS || !BASE64.test(image)) {
      return respond(400, { error: "Missing or invalid image." }, corsOrigin);
    }
    if (typeof installId !== "string" || !UUID.test(installId)) {
      return respond(400, { error: "Missing or invalid installId." }, corsOrigin);
    }
    if (typeof hint !== "string" || hint.length > 300) {
      return respond(400, { error: "Invalid hint." }, corsOrigin);
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (!(await withinLimit(env.INSTALL_LIMITER, installId)) || !(await withinLimit(env.IP_LIMITER, ip))) {
      return respond(429, { error: "You're scanning faster than the free service allows. Wait a minute and try again." }, corsOrigin);
    }

    if (!env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY secret is not set");
      return respond(500, { error: "The card-ID service isn't configured yet." }, corsOrigin);
    }

    try {
      const card = await identifyCardGemini(env.GEMINI_API_KEY, image, hint);
      return respond(200, { card }, corsOrigin);
    } catch (e) {
      const status = e && e.status;
      console.error("identify failed", status, e && e.message);
      if (status === 429) {
        return respond(
          503,
          { error: "The free card-ID service is at its limit right now. Try again later, or add your own free Gemini key in Settings." },
          corsOrigin,
        );
      }
      return respond(502, { error: "The card-ID service couldn't read this frame. Try scanning again." }, corsOrigin);
    }
  },
};

async function graded(request, env, corsOrigin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return respond(400, { error: "Request body must be JSON." }, corsOrigin);
  }
  const { tcgPlayerId, grade, installId } = body || {};
  if (!/^\d{1,10}$/.test(String(tcgPlayerId || ""))) return respond(400, { error: "Invalid tcgPlayerId." }, corsOrigin);
  if (typeof grade !== "string" || !/^[a-z]{3,4}\d{1,3}(pristine|blacklabel)?$/.test(grade)) return respond(400, { error: "Invalid grade." }, corsOrigin);
  if (typeof installId !== "string" || !UUID.test(installId)) {
    return respond(400, { error: "Missing or invalid installId." }, corsOrigin);
  }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await withinLimit(env.INSTALL_LIMITER, installId)) || !(await withinLimit(env.IP_LIMITER, ip))) {
    return respond(429, { error: "Too many requests. Wait a minute and try again." }, corsOrigin);
  }
  if (!env.PPT_API_KEY) return respond(200, { graded: null }, corsOrigin);

  // One upstream call per card per day, shared by every user: the free tier is only ~50 lookups a day.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`https://graded-cache.internal/${tcgPlayerId}`);
  let card = null;
  const cached = cache && (await cache.match(cacheKey));
  if (cached) {
    card = await cached.json();
  } else {
    try {
      card = await fetchGradedCard(env.PPT_API_KEY, tcgPlayerId);
    } catch (e) {
      console.error("graded lookup failed", e.status, e.message);
      return respond(200, { graded: null }, corsOrigin);
    }
    if (cache) {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(card), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${GRADED_TTL_S}` },
        }),
      );
    }
  }
  return respond(200, { graded: pickGradedPrice(card, grade) }, corsOrigin);
}

async function tcgcsv(url, request, env, corsOrigin) {
  if (!TCGCSV_PATH.test(url.pathname)) return respond(404, { error: "Not found." }, corsOrigin);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await withinLimit(env.PRICE_LIMITER, ip))) {
    return respond(429, { error: "Too many requests. Wait a minute and try again." }, corsOrigin);
  }
  const upstream = `https://tcgcsv.com/tcgplayer/${url.pathname.slice("/tcgcsv/".length)}`;
  // Cloudflare's edge cache absorbs repeat requests, so TCGCSV sees about one fetch per file per day.
  const res = await fetch(upstream, {
    headers: { "User-Agent": USER_AGENT },
    cf: { cacheEverything: true, cacheTtl: TCGCSV_TTL_S },
  });
  const headers = { "content-type": "application/json", "cache-control": `public, max-age=${TCGCSV_TTL_S}` };
  if (corsOrigin) headers["access-control-allow-origin"] = corsOrigin;
  if (!res.ok) return respond(502, { error: `Price data source error ${res.status}.` }, corsOrigin);
  return new Response(res.body, { status: 200, headers });
}
