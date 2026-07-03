// Dynamic OpenAI model pricing for the Codex provider. OpenAI publishes no
// machine-readable pricing (their docs page is an HTML app shell), so we use
// models.dev — an open, zero-auth, community-maintained JSON dataset — and
// keep the hardcoded table in pricing.mjs as the always-works fallback.
//
// Same architecture as the Claude refresher (../claude/remote-pricing.mjs):
//   - viewer refreshes the on-disk cache at start (content-diffed: cache/log
//     only move when a rate actually changed);
//   - the hook reads the cache synchronously, never touching the network.
//
// IMPORTANT: keep this file SELF-CONTAINED (node builtins only) — install.mjs
// copies it next to the bundled viewer as viewer/remote-pricing-codex.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRICING_URL = "https://models.dev/api.json";

export const CACHE_FILE = path.join(
  os.homedir(),
  ".ai-usage-inspector",
  "pricing-codex.json",
);

// models.dev shape: { openai: { models: { "<id>": { cost: { input, output,
// cache_read }, limit: { context } } } } }. Costs are USD per MTok already.
export function parseModelsDev(json) {
  const rates = {};
  const models = json && json.openai && json.openai.models;
  if (!models || typeof models !== "object") return rates;
  for (const [id, m] of Object.entries(models)) {
    const c = m && m.cost;
    if (!c || !(c.input >= 0) || !(c.output >= 0)) continue;
    rates[id] = {
      input: c.input,
      cachedInput: c.cache_read >= 0 ? c.cache_read : c.input * 0.1,
      output: c.output,
      contextMax: (m.limit && m.limit.context) || null,
    };
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

// Content diff — how we know pricing actually changed (no version/ETag to rely on).
export function diffRates(oldRates, nextRates) {
  const a = oldRates || {};
  const b = nextRates || {};
  const changes = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!y) changes.push({ id, type: "removed", from: x });
    else if (!x) changes.push({ id, type: "added", to: y });
    else if (
      x.input !== y.input ||
      x.output !== y.output ||
      x.cachedInput !== y.cachedInput
    )
      changes.push({ id, type: "changed", from: x, to: y });
  }
  return changes;
}

/**
 * Refresh the on-disk OpenAI pricing cache from models.dev. Best-effort; every
 * failure path falls back to the cached (or null) rates. Returns
 * { status, rates, changes? } — status: no-fetch | fresh | unchanged | updated |
 * offline | http-<code> | read-error | parse-thin.
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
    res = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch {
    return { status: "offline", rates: cached ? cached.rates : null };
  }
  if (!res.ok) {
    return { status: `http-${res.status}`, rates: cached ? cached.rates : null };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { status: "read-error", rates: cached ? cached.rates : null };
  }

  const rates = parseModelsDev(json);
  // Guard against a dataset restructure silently zeroing prices.
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
