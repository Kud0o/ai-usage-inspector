// Dynamic model pricing: fetch current per-MTok rates from Claude's public
// pricing docs and cache them on disk, so recorded costs track price changes
// without a code edit. Zero-dependency, fully offline-safe.
//
// Split of responsibilities:
//   - The viewer (long-lived, has network) calls refreshPricing() on start to
//     keep the cache current. It uses a conditional GET (ETag) so the page is
//     only re-parsed when it actually changed.
//   - The Stop hook (short-lived, must stay fast) never hits the network. It
//     reads the cached rates synchronously via readCachedRates() — see
//     pricing.mjs, which applies them over the built-in table at import.
//
// The built-in table in pricing.mjs is always the fallback: if the network is
// down, the page format changes, or nothing has been cached yet, costs still
// compute from the bundled rates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Anthropic's public pricing page, in machine-readable markdown. No API key
// needed. The "Model pricing" table lists one model per row as `$N / MTok`.
export const PRICING_URL =
  "https://platform.claude.com/docs/en/about-claude/pricing.md";

// Shared across every project on this machine — pricing is global, not
// per-project. Lives beside the installed app's global config. Per-provider
// file so providers never clobber each other's cached rates.
export const CACHE_FILE = path.join(
  os.homedir(),
  ".ai-usage-inspector",
  "pricing-claude.json",
);

// "Claude Opus 4.8" -> "claude-opus-4-8". Trailing footnotes/links in the cell
// (e.g. "Claude Sonnet 5 through August 31, 2026") are ignored: we only read
// the leading `Claude <tier> <version>`.
function nameToId(name) {
  const m = /^Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)/i.exec(
    String(name || "").trim(),
  );
  if (!m) return null;
  return `claude-${m[1].toLowerCase()}-${m[2].replace(/\./g, "-")}`;
}

// "$12.50 / MTok" -> 12.5 ; non-price cells -> null.
function parsePrice(cell) {
  const m = /\$\s*([\d.]+)\s*\/\s*MTok/i.exec(String(cell || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Parse the pricing markdown into { "<model-id>": { input, output } }.
// Each model row renders as: Model | Base Input | 5m | 1h | Cache hit | Output.
// We take the first price as input and the last as output, so the column count
// can shift without breaking. First row for a given id wins — the canonical
// "Model pricing" table sits above the batch/fast-mode tables, and currently
// effective intro pricing is listed before the future standard price.
export function parsePricingMarkdown(md) {
  const rates = {};
  for (const line of String(md || "").split("\n")) {
    if (line[0] !== "|") continue;
    const cells = line.split("|").map((c) => c.trim());
    const id = nameToId(cells[1]);
    if (!id || id in rates) continue;
    const prices = cells.slice(2).map(parsePrice).filter((n) => n != null);
    if (prices.length < 2) continue;
    const input = prices[0];
    const output = prices[prices.length - 1];
    if (input >= 0 && output >= 0) rates[id] = { input, output };
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

/** Cached rate map ({id:{input,output}}) or null. Sync, never throws. */
export function readCachedRates(file = CACHE_FILE) {
  const c = readCache(file);
  return c && c.rates ? c.rates : null;
}

// What actually changed between two rate maps: a model added, removed, or
// repriced. This — not an ETag — is how we know there's a real change, since
// the docs CDN doesn't send validators. Returns [] when nothing moved.
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
 * Refresh the on-disk pricing cache from the public docs. Best-effort and
 * non-blocking by contract — every failure path falls back to the cached (or
 * null) rates and the caller keeps using the built-in table.
 *
 * Returns { status, rates, changes? }. status is one of: no-fetch, fresh (cache
 * still within ttl, skipped network), not-modified (304 from server), unchanged
 * (re-fetched but the parsed rates are identical), updated (rates actually
 * differ — `changes` lists what moved), offline, http-<code>, read-error,
 * parse-thin.
 */
export async function refreshPricing({
  file = CACHE_FILE,
  url = PRICING_URL,
  ttlMs = 12 * 60 * 60 * 1000,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return { status: "no-fetch", rates: readCachedRates(file) };
  }
  const cached = readCache(file);
  // Don't even open a socket if we refreshed recently.
  if (cached && cached.fetchedAt && now - cached.fetchedAt < ttlMs) {
    return { status: "fresh", rates: cached.rates || null };
  }

  const headers = { accept: "text/markdown, text/plain, */*" };
  if (cached && cached.etag) headers["if-none-match"] = cached.etag;

  let res;
  try {
    res = await fetchImpl(url, { headers });
  } catch {
    return { status: "offline", rates: cached ? cached.rates : null };
  }

  // Unchanged since last fetch — bump the timestamp, skip re-parsing.
  if (res.status === 304 && cached) {
    writeCache(file, { ...cached, fetchedAt: now });
    return { status: "not-modified", rates: cached.rates || null };
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
  // Guard against a page redesign silently zeroing out prices: keep the old
  // cache if the parse came back implausibly thin.
  if (Object.keys(rates).length < 3) {
    return { status: "parse-thin", rates: cached ? cached.rates : null };
  }

  const etag = res.headers.get("etag") || (cached && cached.etag) || null;
  const changes = diffRates(cached && cached.rates, rates);
  // Re-fetched, but the numbers are identical — no real change. Just record
  // that we checked (bump fetchedAt / refresh the etag) and report it.
  if (cached && changes.length === 0) {
    writeCache(file, { ...cached, etag, fetchedAt: now, rates });
    return { status: "unchanged", rates };
  }
  writeCache(file, { etag, fetchedAt: now, source: url, rates });
  return { status: "updated", rates, changes };
}
