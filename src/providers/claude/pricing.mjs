// Model -> context window + USD pricing, and a per-usage cost calculator.
// Prices are USD per 1,000,000 tokens. The table below is the built-in
// fallback (cached 2026-06); current rates fetched from Claude's pricing docs
// override it when available (see remote-pricing.mjs / applyRemoteRates).
// Cache writes: 5m = 1.25x input, 1h = 2x input. Cache reads = 0.1x input.
import { M, zeroCost, addCost } from "../../lib/pricing-core.mjs";
import { readCachedRates } from "./remote-pricing.mjs";

export { zeroCost, addCost };

// Per-MTok rates. cw5m/cw1h/cr are derived from input where omitted.
function model(input, output, ctx) {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
    contextMax: ctx,
  };
}

// Keyed by normalized model id (date suffix stripped, see normalize()).
const TABLE = {
  "claude-fable-5": model(10, 50, 1_000_000),
  "claude-mythos-5": model(10, 50, 1_000_000),
  "claude-opus-4-8": model(5, 25, 1_000_000),
  "claude-opus-4-7": model(5, 25, 1_000_000),
  "claude-opus-4-6": model(5, 25, 1_000_000),
  "claude-opus-4-5": model(5, 25, 200_000),
  "claude-sonnet-4-6": model(3, 15, 1_000_000),
  "claude-sonnet-4-5": model(3, 15, 200_000),
  "claude-haiku-4-5": model(1, 5, 200_000),
};

const FALLBACK = model(5, 25, 200_000);

// Rates fetched from the pricing docs, keyed like TABLE. Carry only input/output
// (the docs don't list context windows), so the context max falls back to the
// built-in entry. Applied at import from the on-disk cache; the viewer refreshes
// that cache, so newly recorded turns price at current rates.
let OVERRIDES = {};

/**
 * Merge fetched { id: { input, output } } rates over the built-in table.
 * Sanity-checked: a non-numeric or negative rate is ignored, never poisoning
 * a model's pricing.
 */
export function applyRemoteRates(rates) {
  if (!rates) return;
  for (const [id, r] of Object.entries(rates)) {
    if (!r || !(r.input >= 0) || !(r.output >= 0)) continue;
    const ctx = (TABLE[id] && TABLE[id].contextMax) || FALLBACK.contextMax;
    OVERRIDES[id] = model(r.input, r.output, ctx);
  }
}

// Seed overrides from whatever the viewer last cached. Best-effort; the hook
// stays fully offline (no fetch here, just a local file read).
try {
  applyRemoteRates(readCachedRates());
} catch {}

/** Strip a trailing -YYYYMMDD date snapshot from a model id. */
export function normalize(modelId) {
  return String(modelId || "").replace(/-\d{8}$/, "");
}

/** Look up the pricing/context record for a model id (never throws). */
export function modelInfo(modelId) {
  const id = normalize(modelId);
  return OVERRIDES[id] || TABLE[id] || FALLBACK;
}

/** Context window (tokens) for a model id. */
export function contextMax(modelId) {
  return modelInfo(modelId).contextMax;
}

/**
 * Cost (USD) of one assistant message's usage, priced at that message's model.
 * `usage` is the Anthropic usage object from the transcript.
 */
export function costOf(modelId, usage) {
  if (!usage) return zeroCost();
  const r = modelInfo(modelId);
  const cc = usage.cache_creation || {};
  // If no breakdown, treat all cache_creation as 5m (the common case).
  const c1h = cc.ephemeral_1h_input_tokens || 0;
  const c5m =
    cc.ephemeral_5m_input_tokens != null
      ? cc.ephemeral_5m_input_tokens
      : Math.max(0, (usage.cache_creation_input_tokens || 0) - c1h);

  const input = ((usage.input_tokens || 0) * r.input) / M;
  const output = ((usage.output_tokens || 0) * r.output) / M;
  const cacheRead = ((usage.cache_read_input_tokens || 0) * r.cacheRead) / M;
  const cacheWrite = (c5m * r.cacheWrite5m + c1h * r.cacheWrite1h) / M;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}
