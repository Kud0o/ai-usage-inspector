// Parse an OpenAI Codex CLI "rollout" JSONL into per-prompt turn records that
// match the shared schema (so the dashboard treats Codex and Claude identically).
// Zero dependencies.
//
// Rollout shape (Codex >= ~0.44): one JSON object per line, each
//   { timestamp, type, payload }
// where `type` is "session_meta" | "response_item" | "event_msg" | ...:
//   - session_meta            -> payload has id, cwd, cli_version, (maybe) model
//   - response_item / message -> payload.role ("user"|"assistant") + content[]
//   - event_msg / token_count -> payload.info.{ total_token_usage, last_token_usage,
//                                model_context_window }
// Token usage is cumulative in total_token_usage, so a turn's usage is the delta
// of the running total across that turn — robust to multiple model calls per turn
// (tool loops). Older flat formats (no `payload` wrapper) are tolerated.
import fs from "node:fs";
import { costOf, contextMax } from "./pricing.mjs";

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* skip torn/partial line */
    }
  }
  return out;
}

// Normalize a record into { top, body, sub, role, ts }. Supports the wrapped
// ({type, payload}) and older flat formats.
function classify(rec) {
  if (!rec || typeof rec !== "object") return null;
  const top = rec.type;
  const body = rec.payload && typeof rec.payload === "object" ? rec.payload : rec;
  return {
    top,
    body,
    sub: body && body.type,
    role: body && body.role,
    ts: rec.timestamp || rec.ts || (body && body.timestamp) || null,
  };
}

function isUserMessage(c) {
  return (c.sub === "message" || c.top === "message") && c.role === "user";
}
function isAssistantMessage(c) {
  return (c.sub === "message" || c.top === "message") && c.role === "assistant";
}
function isTokenCount(c) {
  return c.sub === "token_count" || c.top === "token_count";
}
function isSessionMeta(c) {
  return c.top === "session_meta" || (c.body && c.body.cwd && c.body.id && !c.role);
}

// Join the text out of a Responses-API content array (input_text/output_text/text).
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function usageVec(u) {
  u = u || {};
  return {
    input: u.input_tokens || 0,
    cached: u.cached_input_tokens || 0,
    output: u.output_tokens || 0,
    reasoning: u.reasoning_output_tokens || 0,
  };
}
const sub = (a, b) => ({
  input: Math.max(0, a.input - b.input),
  cached: Math.max(0, a.cached - b.cached),
  output: Math.max(0, a.output - b.output),
  reasoning: Math.max(0, a.reasoning - b.reasoning),
});

/**
 * Parse a rollout into an array of turn records (one per user prompt).
 * `opts.model` / `opts.cwd` / `opts.sessionId` (from the hook payload) fill in
 * fields the rollout doesn't reliably carry. Returns [] if unreadable/empty.
 */
export function buildTurns(rolloutPath, opts = {}) {
  const recs = readJsonl(rolloutPath).map(classify).filter(Boolean);
  if (!recs.length) return [];

  // Session-level metadata (rollout first, hook payload as fallback).
  let meta = {};
  for (const c of recs) if (isSessionMeta(c)) { meta = c.body; break; }
  const sessionId = opts.sessionId || meta.id || meta.session_id || null;
  const cwd = opts.cwd || meta.cwd || null;
  const model = opts.model || meta.model || (meta.turn_context && meta.turn_context.model) || "unknown";
  const cliVersion = meta.cli_version || meta.version || null;

  // Segment into turns at each user message; attach the token-count deltas and
  // assistant text that follow it.
  const turns = [];
  let cur = null;
  let runningTotal = { input: 0, cached: 0, output: 0, reasoning: 0 };

  const openTurn = (c) => {
    cur = {
      ts: c.ts,
      endTs: c.ts,
      firstAsstTs: null,
      prompt: contentText(c.body.content),
      response: "",
      startTotal: { ...runningTotal },
      lastCtxInput: 0,
      ctxWindow: 0,
      apiCalls: 0,
      toolCalls: 0,
      thinking: 0,
    };
    turns.push(cur);
  };

  for (const c of recs) {
    if (isUserMessage(c)) {
      openTurn(c);
      continue;
    }
    if (!cur) continue; // skip anything before the first user prompt
    if (c.ts) cur.endTs = c.ts;

    if (isAssistantMessage(c)) {
      cur.response += contentText(c.body.content);
      if (!cur.firstAsstTs) cur.firstAsstTs = c.ts;
    } else if (isTokenCount(c)) {
      const info = c.body.info || c.body;
      if (info.total_token_usage) runningTotal = usageVec(info.total_token_usage);
      const last = usageVec(info.last_token_usage || info.total_token_usage);
      // Context occupancy = the prompt size of the most recent request this turn.
      cur.lastCtxInput = last.input || cur.lastCtxInput;
      cur.ctxWindow = info.model_context_window || cur.ctxWindow;
      cur.apiCalls++;
      if (!cur.firstAsstTs) cur.firstAsstTs = c.ts;
    } else if (c.sub === "function_call" || c.sub === "local_shell_call" || c.sub === "custom_tool_call") {
      cur.toolCalls++;
    } else if (c.sub === "reasoning") {
      cur.thinking++;
    }
  }

  // A turn's end total = the next turn's start snapshot; the last turn ends at
  // the session-final running total.
  for (let i = 0; i < turns.length; i++) {
    turns[i].endTotal = i + 1 < turns.length ? turns[i + 1].startTotal : runningTotal;
  }

  return turns
    .map((t, i) => finalizeTurn(t, { sessionId, cwd, model, cliVersion, index: i }))
    .filter(Boolean);
}

function finalizeTurn(t, ctx) {
  // Turn usage = delta of the cumulative total across the turn.
  const d = sub(t.endTotal, t.startTotal);

  const tokens = {
    input: Math.max(0, d.input - d.cached), // billable (non-cached) input
    output: d.output,
    reasoning: d.reasoning,
    cacheCreate: 0,
    cacheRead: d.cached,
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const cost = costOf(ctx.model, { input: tokens.input, cached: d.cached, output: d.output });

  const ctxTokens = t.lastCtxInput || d.input;
  const ctxMax = t.ctxWindow || contextMax(ctx.model);
  const startTs = t.ts;
  const endTs = t.endTs || startTs;
  const durationMs =
    startTs && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(startTs)) : 0;
  const firstResponseMs =
    startTs && t.firstAsstTs ? Math.max(0, Date.parse(t.firstAsstTs) - Date.parse(startTs)) : 0;

  return {
    id: `${ctx.sessionId || "codex"}:${ctx.index}`,
    provider: "codex",
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    slug: null,
    gitBranch: null,
    cliVersion: ctx.cliVersion,
    entrypoint: null,
    ts: startTs,
    endTs,
    durationMs,
    firstResponseMs,
    prompt: t.prompt,
    promptChars: t.prompt.length,
    response: t.response,
    responseChars: t.response.length,
    model: ctx.model,
    serviceTier: null,
    speed: null,
    permissionMode: "default",
    effortLevel: null,
    skills: [],
    usage: tokens,
    contextTokens: ctxTokens,
    contextMax: ctxMax,
    contextFillPct: ctxMax ? Math.round((ctxTokens / ctxMax) * 1000) / 10 : 0,
    counts: {
      apiCalls: t.apiCalls,
      subagentCalls: 0,
      toolCalls: t.toolCalls,
      thinkingBlocks: t.thinking,
    },
    cost: {
      input: round4(cost.input),
      output: round4(cost.output),
      cacheWrite: round4(cost.cacheWrite),
      cacheRead: round4(cost.cacheRead),
      total: round4(cost.total),
    },
    schema: 2,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
