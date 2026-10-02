// The hosted card-ID service (server/worker.js), which holds the project's
// Gemini key so users don't need one.

import { SERVICE_URL } from "./config.js";

export function serviceConfigured() {
  return /^https:\/\//.test(SERVICE_URL);
}

export async function identifyCardViaService(imageBase64, listingHint, installId) {
  let res;
  try {
    res = await fetch(`${SERVICE_URL.replace(/\/$/, "")}/identify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: imageBase64, hint: listingHint || "", installId }),
    });
  } catch {
    throw new Error("Couldn't reach the card-ID service. Check your internet connection.");
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 429) {
    throw new Error(json.error || "You're scanning faster than the free service allows. Wait a minute and try again.");
  }
  if (!res.ok) throw new Error(json.error || `Card-ID service error ${res.status}.`);
  return json.card;
}

export async function gradedViaService(tcgPlayerId, gradeKey, installId) {
  const res = await fetch(`${SERVICE_URL.replace(/\/$/, "")}/graded`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tcgPlayerId, grade: gradeKey, installId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Card-ID service error ${res.status}.`);
  return json.graded || null;
}
