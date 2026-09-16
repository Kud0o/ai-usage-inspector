// Model -> context window + USD pricing, and a per-usage cost calculator.
// Prices are USD per 1,000,000 tokens. The table below is the built-in
// fallback; current rates and context windows fetched from Claude's docs
// override it when available (see remote-pricing.mjs / applyRemoteRates).
// Cache writes: 5m = 1.25x input, 1h = 2x input. Cache reads = 0.1x input,
// except where a model publishes its own cache prices.
import { M, zeroCost, addCost } from "../../lib/pricing-core.mjs";
import { readCachedRates, readCachedWindows } from "./remote-pricing.mjs";

// Which version of this table a cost was worked out under. Costs carry it, so a
// correction can name the models it corrected and the revision it arrived in:
// a stored cost from before that revision is worked out again on the next read
// instead of being kept. Stored costs are otherwise never rewritten — what a
// turn cost at the time stands — but these were never Anthropic's prices.
export const RATES_REVISION = 2;
const CORRECTED_IN = {
  // Missing from the table before revision 2. Without fetched rates they were
  // priced at the Opus-tier guess — Sonnet 5 2.5x too high, Fable and Mythos 5.1
  // at half — and labelled estimated even where the guess happened to be right.
  "claude-opus-5": 2,
  "claude-sonnet-5": 2,
  // Cache hits on these are 0.025x input, not 0.1x: priced four times too high
  // with or without fetched rates, which only ever carried input and output.
  "claude-fable-5-1": 2,
  "claude-mythos-5-1": 2,
};

export { zeroCost, addCost };

// Per-MTok rates. Cache prices follow input by the standard multipliers unless a
// model publishes its own: Fable 5.1 and Mythos 5.1 price cache hits at 0.025x.
function model(input, output, ctx, { cacheWrite5m, cacheWrite1h, cacheRead } = {}) {
  return {
    input,
    output,
    cacheWrite5m: cacheWrite5m ?? input * 1.25,
    cacheWrite1h: cacheWrite1h ?? input * 2,
    cacheRead: cacheRead ?? input * 0.1,
    contextMax: ctx,
  };
}

// Keyed by normalized model id (date suffix stripped, see normalize()).
// Figures from Anthropic's pricing and models pages, checked 2026-09-16.
const TABLE = {
  "claude-fable-5-1": model(10, 50, 1_000_000, { cacheRead: 0.25 }),
  "claude-mythos-5-1": model(10, 50, 1_000_000, { cacheRead: 0.25 }),
  "claude-fable-5": model(10, 50, 1_000_000),
  "claude-mythos-5": model(10, 50, 1_000_000),
  "claude-opus-5": model(5, 25, 1_000_000),
  "claude-sonnet-5": model(2, 10, 1_000_000),
  "claude-opus-4-8": model(5, 25, 1_000_000),
  "claude-opus-4-7": model(5, 25, 1_000_000),
  "claude-opus-4-6": model(5, 25, 1_000_000),
  "claude-opus-4-5": model(5, 25, 200_000),
  "claude-sonnet-4-6": model(3, 15, 1_000_000),
  "claude-sonnet-4-5": model(3, 15, 200_000),
  "claude-haiku-4-5": model(1, 5, 200_000),
};

// Unknown Claude models fall back to the current Opus tier. The rate is a
// guess, so entries built from it carry `estimated` and any cost derived from
// them is labelled "estimated" rather than "priced".
const FALLBACK = { ...model(5, 25, 200_000), estimated: true };

// Rates and context windows fetched from the docs, keyed like TABLE. Applied at
// import from the on-disk cache; the viewer, install and sync refresh that
// cache, so newly recorded turns price and fill against current figures.
let OVERRIDES = {};

const price = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const tokens = (n) => typeof n === "number" && Number.isFinite(n) && n >= 1_000;

/**
 * Merge fetched rates ({ id: { input, output, cacheWrite5m?, cacheWrite1h?,
 * cacheRead? } }) and context windows ({ id: tokens }) over the built-in table.
 * Sanity-checked: a non-numeric or negative figure is ignored, never poisoning a
 * model's pricing.
 */
export function applyRemoteRates(rates, windows) {
  const r = rates && typeof rates === "object" ? rates : {};
  const w = windows && typeof windows === "object" ? windows : {};
  for (const id of new Set([...Object.keys(r), ...Object.keys(w)])) {
    const base = TABLE[id];
    const fetched = r[id];
    const ctx = tokens(w[id]) ? w[id] : (base && base.contextMax) || FALLBACK.contextMax;
    if (fetched && price(fetched.input) && price(fetched.output)) {
      // A cache price the page did not give is taken from the built-in entry
      // while the fetched input still matches it: a cache written before cache
      // prices were fetched must not pull Fable 5.1's cache hits back to 0.1x.
      const same = base && base.input === fetched.input;
      const cache = (key) => (price(fetched[key]) ? fetched[key] : same ? base[key] : undefined);
      OVERRIDES[id] = model(fetched.input, fetched.output, ctx, {
        cacheWrite5m: cache("cacheWrite5m"),
        cacheWrite1h: cache("cacheWrite1h"),
        cacheRead: cache("cacheRead"),
      });
    } else if (tokens(w[id])) {
      // A window without a price: the model's own rates if the table has them,
      // otherwise still the guessed rate — but no longer a guessed window.
      OVERRIDES[id] = { ...(base || FALLBACK), contextMax: w[id] };
    }
  }
}

// Seed overrides from whatever was last cached. Best-effort; the hook stays
// fully offline (no fetch here, just a local file read).
try {
  applyRemoteRates(readCachedRates(), readCachedWindows());
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

/** The window of a model this version actually knows — never the fallback guess. */
export function knownContextMax(modelId) {
  const info = modelInfo(modelId);
  return info.estimated ? null : info.contextMax;
}

/**
 * Cost (USD) of one assistant message's usage, priced at that message's model.
 * `usage` is the Anthropic usage object from the transcript.
 */
export function costOf(modelId, usage) {
  if (!usage) return { ...zeroCost(), source: "priced" };
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
    source: r.estimated ? "estimated" : "priced",
    ...(r.estimated ? { estimatedRate: true } : {}),
    rates: RATES_REVISION,
    ...(CORRECTED_IN[normalize(modelId)] ? { supersedes: CORRECTED_IN[normalize(modelId)] } : {}),
  };
}
