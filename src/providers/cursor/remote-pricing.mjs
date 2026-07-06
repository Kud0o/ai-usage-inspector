// Dynamic Cursor model pricing, scraped from cursor.com's public docs — which
// serve raw markdown at the .md suffix. Table shape (verified 2026-07):
//   | Model | Provider | $<input> | $<output> |
// Bare dollar cells, no per-MTok suffix, no cache column (cachedInput = 10% of
// input). Same architecture as the other providers' refreshers: the viewer
// refreshes the on-disk cache (content-diffed); the hook/sync path reads the
// cache synchronously and never touches the network.
//
// IMPORTANT: keep this file SELF-CONTAINED (node builtins only) — install.mjs
// copies it next to the bundled viewer as viewer/remote-pricing-cursor.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRICING_URL = "https://cursor.com/docs/models-and-pricing.md";

export const CACHE_FILE = path.join(
  os.homedir(),
  ".ai-usage-inspector",
  "pricing-cursor.json",
);

// Table layout (verified 2026-07):
//   | Model | Provider | Input | Cache write | Cache read | Output | Notes |
// The Model cell is a markdown link `[Name](url)`; prices are bare `$N`.
const COL = { model: 1, input: 3, cacheRead: 5, output: 6 };

// "[Claude 4.6 Sonnet](url)" -> "claude-4.6-sonnet". Link + parens stripped.
function nameToId(cell) {
  let s = String(cell || "");
  const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(s.trim()); // markdown link → text
  if (link) s = link[1];
  s = s.toLowerCase().replace(/\([^)]*\)/g, "").trim().replace(/\s+/g, "-");
  return s || null;
}

// "$3" / "$12.50" -> number; anything else -> null.
function parsePrice(cell) {
  const m = /^\$\s*([\d.]+)$/.exec(String(cell || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Markdown -> { id: { input, cachedInput, output } }. First row per id wins. */
export function parsePricingMarkdown(md) {
  const rates = {};
  for (const line of String(md || "").split("\n")) {
    if (line[0] !== "|") continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length <= COL.output) continue;
    const id = nameToId(cells[COL.model]);
    const input = parsePrice(cells[COL.input]);
    const output = parsePrice(cells[COL.output]);
    if (!id || id in rates || input == null || output == null) continue;
    const cr = parsePrice(cells[COL.cacheRead]);
    rates[id] = { input, cachedInput: cr != null ? cr : input * 0.1, output };
  }
  return rates;
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {}
}

/** Cached rate map or null. Sync, never throws. */
export function readCachedRates(file = CACHE_FILE) {
  const c = readCache(file);
  return c && c.rates ? c.rates : null;
}

// Content diff — the only change signal available (no version/ETag).
export function diffRates(oldRates, nextRates) {
  const a = oldRates || {};
  const b = nextRates || {};
  const changes = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!y) changes.push({ id, type: "removed", from: x });
    else if (!x) changes.push({ id, type: "added", to: y });
    else if (x.input !== y.input || x.output !== y.output)
      changes.push({ id, type: "changed", from: x, to: y });
  }
  return changes;
}

/**
 * Refresh the on-disk Cursor pricing cache. Best-effort; every failure path
 * falls back to cached (or null) rates. Returns { status, rates, changes? } —
 * status: no-fetch | fresh | unchanged | updated | offline | http-<code> |
 * read-error | parse-thin.
 */
export async function refreshPricing({
  file = CACHE_FILE,
  url = PRICING_URL,
  ttlMs = 0,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return { status: "no-fetch", rates: readCachedRates(file) };
  }
  const cached = readCache(file);
  if (cached && cached.fetchedAt && ttlMs > 0 && now - cached.fetchedAt < ttlMs) {
    return { status: "fresh", rates: cached.rates || null };
  }

  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "text/markdown, text/plain, */*" } });
  } catch {
    return { status: "offline", rates: cached ? cached.rates : null };
  }
  if (!res.ok) {
    return { status: `http-${res.status}`, rates: cached ? cached.rates : null };
  }

  let md;
  try {
    md = await res.text();
  } catch {
    return { status: "read-error", rates: cached ? cached.rates : null };
  }

  const rates = parsePricingMarkdown(md);
  // Guard against a docs redesign (or an HTML response) zeroing prices.
  if (Object.keys(rates).length < 3) {
    return { status: "parse-thin", rates: cached ? cached.rates : null };
  }

  const changes = diffRates(cached && cached.rates, rates);
  if (cached && changes.length === 0) {
    writeCache(file, { ...cached, fetchedAt: now, rates });
    return { status: "unchanged", rates };
  }
  writeCache(file, { fetchedAt: now, source: url, rates });
  return { status: "updated", rates, changes };
}
