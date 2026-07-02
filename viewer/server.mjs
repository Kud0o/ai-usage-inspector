#!/usr/bin/env node
// Self-contained, zero-dependency viewer. Reads ONE project's records + config
// from a `.ai-usage` folder and serves the dashboard.
//
// It figures out which folder to read, in priority order:
//   1. $AI_USAGE_DIR                           (explicit / aggregate mode)
//   2. its own sibling folder, when this file was copied into a project at
//      <project>/.ai-usage/viewer/server.mjs   → reads <project>/.ai-usage
//   3. <argv path>/.ai-usage  or  <cwd>/.ai-usage
//
//   node server.mjs                 # reads ./.ai-usage
//   node server.mjs /path/to/proj   # reads that project
//   node server.mjs --port 8080     # or PORT=8080 / config.json "port"
//
// Port priority: --port flag > $PORT > config.json "port" > first free port
// starting at 4317 (auto-picked so it never fails to start).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");

function parseArgs(argv) {
  let port = null;
  let projectPath = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") {
      port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice("--port=".length));
    } else if (!a.startsWith("-")) {
      projectPath = a;
    }
  }
  return { port, projectPath };
}
const ARGS = parseArgs(process.argv);

// Field/defaults config module. In a bundled project it sits beside this file
// (viewer/config.mjs, placed there by the installer); when running from the repo
// it lives at ../src/lib/config.mjs. Try the bundle path, fall back to repo.
let CFG;
try {
  CFG = await import("./config.mjs");
} catch {
  CFG = await import("../src/lib/config.mjs");
}

// Same bundle-or-repo dance for the pricing refresher. On a fresh install the
// module may not be bundled yet; degrade silently if so.
let PRICING = null;
try {
  PRICING = await import("./remote-pricing.mjs");
} catch {
  try {
    PRICING = await import("../src/providers/claude/remote-pricing.mjs");
  } catch {}
}

function resolveDataDir() {
  if (process.env.AI_USAGE_DIR) return process.env.AI_USAGE_DIR;
  // Bundled inside a project: <project>/.ai-usage/viewer/server.mjs
  if (
    path.basename(__dirname) === "viewer" &&
    path.basename(path.dirname(__dirname)) === ".ai-usage"
  ) {
    return path.dirname(__dirname);
  }
  const base = ARGS.projectPath ? path.resolve(ARGS.projectPath) : process.cwd();
  return path.join(base, ".ai-usage");
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ---- per-project config (title/port/ui + tracking + stored fields) ----
function loadConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {}
  if (!c.title) c.title = path.basename(path.dirname(DATA_DIR)) || "workspace";
  if (!c.ui || typeof c.ui !== "object") c.ui = {};
  // Surface tracking + fields (seed a view from the global defaults so the
  // settings panel always has values, even before the hook has written them).
  const def = CFG.loadGlobalDefaults();
  c.tracking = { enabled: def.enabledDefault, ...(c.tracking || {}) };
  c.fields = { ...def.fields, ...(c.fields || {}) };
  return c;
}
function saveConfig(patch) {
  const c = loadConfig();
  const next = {
    ...c, ...patch,
    ui: { ...c.ui, ...(patch && patch.ui) },
    tracking: { ...c.tracking, ...(patch && patch.tracking) },
    fields: { ...c.fields, ...(patch && patch.fields) },
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch {}
  return next;
}

const requestedPort = ARGS.port || Number(process.env.PORT) || loadConfig().port;

// ---- data ----
function loadEvents() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return [];
  }
  const events = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
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

function toListItem(e) {
  const { prompt, response, ...rest } = e;
  return {
    ...rest,
    promptPreview: (prompt || "").slice(0, 280),
    responsePreview: (response || "").slice(0, 280),
  };
}

// Permanently remove records by id across all ndjson files. Rewrites each file
// atomically (tmp + rename); deletes a file that becomes empty. Returns how many
// records were removed and how many bytes that freed.
function deleteEvents(ids) {
  const set = new Set(ids || []);
  if (!set.size) return { removed: 0, bytesFreed: 0 };
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }
  let removed = 0,
    bytesFreed = 0;
  for (const f of files) {
    const fp = path.join(DATA_DIR, f);
    let text;
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    const before = Buffer.byteLength(text);
    const kept = [];
    let changed = false;
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let id = null;
      try {
        id = JSON.parse(s).id;
      } catch {}
      if (id != null && set.has(id)) {
        removed++;
        changed = true;
      } else {
        kept.push(s);
      }
    }
    if (!changed) continue;
    const out = kept.length ? kept.join("\n") + "\n" : "";
    try {
      if (out) {
        const tmp = fp + ".tmp";
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, fp);
      } else {
        fs.rmSync(fp, { force: true });
      }
      bytesFreed += Math.max(0, before - Buffer.byteLength(out));
    } catch {}
  }
  return { removed, bytesFreed };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, "http://localhost").pathname;
  try {
    if (route === "/api/events") {
      if (req.method === "DELETE") {
        let body = {};
        try {
          body = JSON.parse(await readBody(req)) || {};
        } catch {}
        return send(res, 200, JSON.stringify(deleteEvents(body.ids)));
      }
      return send(res, 200, JSON.stringify(loadEvents().map(toListItem)));
    }
    if (route.startsWith("/api/event/")) {
      const id = decodeURIComponent(route.slice("/api/event/".length));
      const e = loadEvents().find((x) => x.id === id);
      return e ? send(res, 200, JSON.stringify(e)) : send(res, 404, "{}");
    }
    if (route === "/api/config") {
      if (req.method === "POST") {
        let patch = {};
        try {
          patch = JSON.parse(await readBody(req)) || {};
        } catch {}
        return send(res, 200, JSON.stringify(saveConfig(patch)));
      }
      return send(res, 200, JSON.stringify(loadConfig()));
    }
    // static
    let rel = (route === "/" ? "/index.html" : route).replace(/\.\.+/g, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, "not found", "text/plain");
    return send(res, 500, "error", "text/plain");
  }
});

// When no port was explicitly requested, retry on the next port instead of
// failing — the real listen() (not a separate probe) decides what's free,
// since pre-checking with a throwaway socket is unreliable on Windows.
let port = requestedPort || 4317;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    if (!requestedPort) {
      port++;
      server.listen(port);
      return;
    }
    console.error(`\n  Port ${port} is already in use. Pick another with --port <n>.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`\n  AI Usage Inspector  ->  http://localhost:${port}`);
  console.log(`  project: ${loadConfig().title}`);
  console.log(`  reading: ${DATA_DIR}\n`);
  refreshPricing();
});

// Refresh the shared Claude pricing cache from Claude's public docs (the only
// provider with a machine-readable price source; OpenAI/Codex rates are the
// built-in table). No pricing API or version stamp to diff against, so we
// re-fetch on every viewer start (a manual, occasional launch) and content-diff
// the result — the cache and the log only move when a rate actually changed.
// Skipped when this project isn't tracking cost. Non-blocking, best-effort,
// offline-safe.
function refreshPricing() {
  if (!PRICING) return;
  if (!loadConfig().fields.cost) return;
  PRICING.refreshPricing({ ttlMs: 0 })
    .then((r) => {
      if (r.status === "updated") {
        const what = (r.changes || [])
          .map((c) =>
            c.type === "changed"
              ? `${c.id} ${c.from.input}/${c.from.output}→${c.to.input}/${c.to.output}`
              : `${c.id} ${c.type}`,
          )
          .join(", ");
        console.log(`  pricing: updated Claude rates from docs — ${what}`);
      } else if (r.status === "offline") {
        console.log(`  pricing: offline — using cached/built-in rates`);
      }
    })
    .catch(() => {});
}
