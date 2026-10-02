// Checks the request we send to Claude and how a bad key is reported,
// without spending money: fetch is stubbed to return a 401.
import { identifyCard, describeApiError } from "../src/claude.js";

let captured;
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
  return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
    status: 401, headers: { "content-type": "application/json" },
  });
};

try {
  await identifyCard("sk-ant-fake", "AAAA", "Charizard ex 199/165");
  console.log("FAIL: expected an error");
} catch (e) {
  console.log("error message ->", describeApiError(e));
}
const b = captured.body;
const h = captured.headers instanceof Headers ? Object.fromEntries(captured.headers) : captured.headers;
console.log("url        ->", captured.url);
console.log("beta hdr   ->", h["anthropic-beta"]);
console.log("model      ->", b.model, "| effort:", b.output_config.effort, "| fallbacks:", b.fallbacks);
console.log("format     ->", b.output_config.format.type, Object.keys(b.output_config.format.schema.properties).join(","));
console.log("content    ->", b.messages[0].content.map((c) => c.type).join(" + "), "|", b.messages[0].content[1].text.split("\n")[0]);
