// Serves the repo root so the browser tests can load the real extension files.
// Usage: npm run test:browser, then open the printed URL in Chrome.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT) || 8321;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
  const file = path.normalize(path.join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Browser tests: http://localhost:${port}/dev/test/browser/`);
});
