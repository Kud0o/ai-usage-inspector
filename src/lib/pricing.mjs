// Model -> context window + USD pricing, and a per-usage cost calculator.
// Prices are USD per 1,000,000 tokens (source: Claude API skill, cached 2026-06).
// Cache writes: 5m = 1.25x input, 1h = 2x input. Cache reads = 0.1x input.

const M = 1_000_000;

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

/** Strip a trailing -YYYYMMDD date snapshot from a model id. */
export function normalize(modelId) {
  return String(modelId || "").replace(/-\d{8}$/, "");
}

/** Look up the pricing/context record for a model id (never throws). */
export function modelInfo(modelId) {
  return TABLE[normalize(modelId)] || FALLBACK;
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

export function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addCost(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}
