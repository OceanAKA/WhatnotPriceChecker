// Chrome's built-in model (Gemini Nano) through the Prompt API. Runs on the
// user's own machine: no key, no server, no cost. Only some computers can run it.

import { CARD_SCHEMA, SYSTEM, userText, parseCardJson } from "./prompt.js";

export const ON_DEVICE_MODEL = "on-device Gemini Nano";

const OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

let baseSession = null;

function api() {
  return typeof LanguageModel === "undefined" ? null : LanguageModel;
}

/** "available" | "downloadable" | "downloading" | "unavailable" | "unsupported" */
export async function onDeviceStatus() {
  const LM = api();
  if (!LM) return "unsupported";
  try {
    return await LM.availability(OPTIONS);
  } catch {
    return "unavailable";
  }
}

async function getBaseSession() {
  if (!baseSession) {
    // Share one in-flight create() between the warm-up and a scan that starts before it finishes.
    baseSession = api()
      .create({ ...OPTIONS, initialPrompts: [{ role: "system", content: SYSTEM }] })
      .catch((e) => {
        baseSession = null;
        throw e;
      });
  }
  return baseSession;
}

// Loading the model onto the GPU is the slowest part of a first scan, so do it ahead of time.
export async function warmUpOnDevice() {
  if ((await onDeviceStatus()) !== "available") return false;
  await getBaseSession();
  return true;
}

function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

export async function identifyCardOnDevice(imageBase64, listingHint = "") {
  if ((await onDeviceStatus()) !== "available") {
    throw new Error("On-device AI isn't ready on this computer.");
  }
  // Clone so each scan starts from just the system prompt instead of piling up history.
  const session = await (await getBaseSession()).clone();
  try {
    const text = await session.prompt(
      [
        {
          role: "user",
          content: [
            { type: "image", value: base64ToBlob(imageBase64) },
            { type: "text", value: userText(listingHint) },
          ],
        },
      ],
      { responseConstraint: CARD_SCHEMA, omitResponseConstraintInput: true },
    );
    return { ...parseCardJson(text), model: ON_DEVICE_MODEL };
  } finally {
    session.destroy();
  }
}
