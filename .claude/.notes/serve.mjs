// Serves the notes in this folder at http://localhost:4311 and saves review comments next to each page
// (report.html → report.comments.json) so Claude can read them. Local only; no dependencies.
// Run: node .claude/.notes/serve.mjs  (or the "notes" entry in .claude/launch.json)
import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 4311;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const MAX_BODY = 1_000_000;

/** A path inside this folder, or null for anything that escapes it. */
function inside(urlPath) {
  try {
    const path = resolve(root, "." + normalize(decodeURIComponent(urlPath)));
    return path === root || path.startsWith(root + sep) ? path : null;
  } catch {
    return null;
  }
}

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function listing(dir, urlPath) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.name.endsWith(".html")))
    .sort((a, b) => a.name.localeCompare(b.name));
  const items = entries.map((e) => {
    const name = e.isDirectory() ? `${e.name}/` : e.name;
    return `<li><a href="${escape(urlPath + name)}">${escape(name)}</a></li>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>Notes</title>
<body style="font:15px/1.6 system-ui,sans-serif;padding:24px;max-width:720px">
<h1 style="font-size:20px">Notes ${escape(urlPath)}</h1><ul>${items.join("") || "<li>Empty</li>"}</ul></body>`;
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const path = inside(pathname);
  if (!path) return res.writeHead(403).end("Outside the notes folder");

  if (req.method === "PUT") {
    if (!path.endsWith(".comments.json")) return res.writeHead(405).end("Only *.comments.json can be written");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return res.writeHead(413).end("Too large");
    }
    try {
      JSON.parse(body);
    } catch {
      return res.writeHead(400).end("Not JSON");
    }
    await writeFile(path, body);
    return res.writeHead(204).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      if (!pathname.endsWith("/")) return res.writeHead(301, { Location: pathname + "/" }).end();
      const index = join(path, "index.html");
      const html = await readFile(index, "utf8").catch(() => listing(path, pathname));
      return res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" }).end(html);
    }
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Notes: http://localhost:${port}/`));
