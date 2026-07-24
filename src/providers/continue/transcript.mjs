// Parse one Continue dev-data event-log file (JSONL) into turn records.
// Zero third-party deps.
//
// Continue (continue.dev) writes local telemetry to ~/.continue/dev_data/<ver>/
// *.jsonl — one JSON event per line. The token-usage event carries model +
// prompt/generated token counts. Continue does NOT record cost, and dev-data
// generally omits prompt/response text, so records are usage-only.
//
// UNVERIFIED against a live install (Continue isn't installed on the dev
// machine). Field names are accessed with aliases spanning the schema variants
// Continue has shipped (promptTokens/tokens_prompt, generatedTokens/
// tokens_generated); confirm on a real install and adjust aliases if needed.
import fs from "node:fs";
import path from "node:path";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function isoOrNull(v) {
  if (v == null) return null;
  // Accept ms epoch, seconds epoch, or an ISO string.
  let ms = null;
  if (typeof v === "number") ms = v < 1e12 ? v * 1000 : v;
  else if (typeof v === "string") {
    const n = Number(v);
    ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// A token-usage event -> { model, input, output, ts } or null.
function tokenEvent(e) {
  if (!e || typeof e !== "object") return null;
  const input = num(e.promptTokens ?? e.tokens_prompt ?? e.inputTokens ?? e.prompt_tokens);
  const output = num(e.generatedTokens ?? e.tokens_generated ?? e.outputTokens ?? e.completion_tokens);
  if (!(input || output)) return null;
  const model = e.model || e.modelTitle || e.modelId || null;
  const ts = isoOrNull(e.timestamp ?? e.eventTimestamp ?? e.time);
  const cwd = (Array.isArray(e.workspaceDirs) && e.workspaceDirs[0]) || e.workspaceDir || null;
  return { model, input, output, ts, cwd };
}

/**
 * Parse one dev-data JSONL file into records. `ref` is { file, sessionId }.
 * Each token event becomes one usage-only turn; the file is the session unit
 * (so re-syncing upserts cleanly).
 */
export function buildTurns(ref, opts = {}) {
  const file = ref && ref.file;
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const sessionId = (ref && ref.sessionId) || path.basename(file);
  const out = [];
  let i = 0;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let e = null;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    const t = tokenEvent(e);
    if (!t) continue;
    out.push(record(t, { sessionId, index: i++, cwd: (ref && ref.cwd) || opts.cwd || t.cwd || null }));
  }
  return out;
}

function contextMax(model) {
  const m = String(model || "").toLowerCase();
  if (/gemini|gpt-4\.1|o[0-9]/.test(m)) return 1_000_000;
  if (/claude|sonnet|opus|haiku/.test(m)) return 200_000;
  if (/gpt-4o|gpt-4|gpt-5/.test(m)) return 128_000;
  return 0;
}

function record(t, ctx) {
  const usage = {
    input: t.input,
    output: t.output,
    reasoning: 0,
    cacheCreate: 0,
    cacheRead: 0,
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const ctxMax = contextMax(t.model);
  return {
    id: `${ctx.sessionId}:${ctx.index}`,
    provider: "continue",
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    slug: null,
    gitBranch: null,
    cliVersion: null,
    entrypoint: "continue",
    ts: t.ts,
    endTs: t.ts,
    durationMs: 0,
    firstResponseMs: 0,
    prompt: "",
    promptChars: 0,
    response: "",
    responseChars: 0,
    model: t.model,
    serviceTier: null,
    speed: null,
    permissionMode: "default",
    effortLevel: null,
    skills: [],
    usage,
    contextTokens: t.input,
    contextMax: ctxMax,
    contextFillPct: ctxMax ? Math.round((t.input / ctxMax) * 1000) / 10 : 0,
    counts: { apiCalls: 1, subagentCalls: 0, toolCalls: 0, thinkingBlocks: 0 },
    // Continue does not record cost; total stays 0 (tokens are still tracked).
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
    schema: 2,
  };
}
