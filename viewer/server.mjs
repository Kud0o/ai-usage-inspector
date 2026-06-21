#!/usr/bin/env node
// Zero-dependency local viewer for the Claude Code usage tracker.
// Reads every per-workspace ndjson file, serves a JSON API + the dashboard SPA.
//
//   node viewer/server.mjs            -> http://localhost:4317
//   PORT=8080 node viewer/server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspacesDir } from "../src/lib/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 4317;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Read + merge all workspace ndjson files. Tolerates partial/locked writes.
function loadEvents() {
  const dir = workspacesDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return [];
  }
  const events = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        events.push(JSON.parse(s));
      } catch {}
    }
  }
  events.sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  return events;
}

// Strip the heavy full-text fields for the list endpoint; keep previews.
function toListItem(e) {
  const { prompt, response, ...rest } = e;
  return {
    ...rest,
    promptPreview: (prompt || "").slice(0, 280),
    responsePreview: (response || "").slice(0, 280),
  };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  try {
    if (route === "/api/events") {
      const events = loadEvents();
      return send(res, 200, JSON.stringify(events.map(toListItem)));
    }
    if (route.startsWith("/api/event/")) {
      const id = decodeURIComponent(route.slice("/api/event/".length));
      const e = loadEvents().find((x) => x.id === id);
      return e ? send(res, 200, JSON.stringify(e)) : send(res, 404, "{}");
    }
    // Static files
    let rel = route === "/" ? "/index.html" : route;
    rel = rel.replace(/\.\.+/g, ""); // basic traversal guard
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
    const data = fs.readFileSync(file);
    return send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, "not found", "text/plain");
    return send(res, 500, "error", "text/plain");
  }
});

server.listen(PORT, () => {
  console.log(`\n  Claude usage viewer  ->  http://localhost:${PORT}\n`);
  console.log(`  data: ${workspacesDir()}\n`);
});
