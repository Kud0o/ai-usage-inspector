// Parse one OpenCode session into per-prompt turn records matching the shared
// schema. Zero third-party deps (SQLite via store.mjs).
//
// Realities handled:
//  - Cost + tokens are real (OpenCode computes and stores them), so nothing is
//    estimated. Per-assistant-message `data` JSON carries
//      { modelID, cost, tokens:{ input, output, reasoning, cache:{ read, write } } }
//    accessed defensively (field aliases) so schema drift degrades, not breaks.
//  - When per-message data isn't usable (older build / parts absent), we fall
//    back to ONE session-level record built from the authoritative `session`
//    table columns (tokens_*, cost, model) — correct totals, coarser grain.
//  - OpenCode stores a single total cost per message, not an input/output split,
//    so the record's cost breakdown carries `total` with zeroed components.
import { readSession } from "./store.mjs";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function isoOrNull(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
}

// Assistant message.data -> normalized usage, or null when no tokens present.
function msgUsage(data) {
  const tok = data && data.tokens;
  if (!tok || typeof tok !== "object") return null;
  const cache = tok.cache && typeof tok.cache === "object" ? tok.cache : {};
  const input = num(tok.input ?? tok.inputTokens);
  const output = num(tok.output ?? tok.outputTokens);
  const reasoning = num(tok.reasoning ?? tok.reasoningTokens);
  const cacheRead = num(cache.read ?? tok.cacheRead ?? tok.cache_read);
  const cacheWrite = num(cache.write ?? tok.cacheWrite ?? tok.cache_write);
  if (!(input || output || reasoning || cacheRead || cacheWrite)) return null;
  return { input, output, reasoning, cacheRead, cacheWrite };
}

const roleOf = (data) => (data && (data.role || data.type)) || null;
const modelOf = (data) => (data && (data.modelID || data.model || data.modelId)) || null;

// OpenCode stores session.model as a JSON string, e.g.
// '{"id":"deepseek-v4-flash-free","providerID":"opencode"}'. Reduce it to the
// bare model id; leave a plain string untouched.
function cleanModel(model) {
  if (model && typeof model === "object") {
    return cleanModel(model.id || model.modelID || model.modelId || model.model);
  }
  if (typeof model !== "string" || !model) return null;
  if (model[0] === "{") {
    try {
      const o = JSON.parse(model);
      return o.id || o.modelID || o.model || model;
    } catch {
      return model;
    }
  }
  return model;
}

// Concatenate the text of a message's parts (skip tool/other part types).
function partsText(parts) {
  let text = "";
  let tools = 0;
  for (const p of parts || []) {
    if (!p || typeof p !== "object") continue;
    const t = p.type;
    if (t === "text" && typeof p.text === "string") text += p.text;
    else if (t === "tool" || t === "tool-invocation" || t === "tool_use") tools++;
  }
  return { text, tools };
}

// Very small context-window lookup by model substring; 0 (unknown) is fine —
// the dashboard just shows 0% context fill for that turn.
function contextMax(model) {
  const m = String(model || "").toLowerCase();
  if (/gemini|gpt-4\.1|o[0-9]/.test(m)) return 1_000_000;
  if (/claude|sonnet|opus|haiku/.test(m)) return 200_000;
  if (/gpt-4o|gpt-4|gpt-5/.test(m)) return 128_000;
  return 0;
}

/**
 * Parse a session into turn records. `ref` is the opaque transcript reference:
 * { sessionId, cwd }. Async (SQLite via store.mjs).
 */
export async function buildTurns(ref, opts = {}) {
  const sessionId = (ref && ref.sessionId) || (typeof ref === "string" ? ref : null);
  if (!sessionId) return [];

  const { session, messages, partsByMsg, inputs } = await readSession(sessionId);
  if (!session && !messages.length) return [];

  const cwd = (ref && ref.cwd) || opts.cwd || (session && session.directory) || null;
  const sessionModel = cleanModel(session && session.model);

  // Segment at user messages; attach following assistant messages.
  const turns = [];
  let cur = null;
  for (const m of messages) {
    const role = roleOf(m.data);
    const { text, tools } = partsText(partsByMsg.get(m.id));
    if (role === "user") {
      cur = { prompt: text, response: "", model: null, usage: null, usageCalls: 0, cost: 0, apiCalls: 0, toolCalls: tools, ts: m.ts, endTs: m.ts };
      turns.push(cur);
    } else if (role === "assistant" && cur) {
      cur.response += text;
      cur.toolCalls += tools;
      cur.apiCalls++;
      cur.endTs = m.ts || cur.endTs;
      cur.model = cur.model || cleanModel(modelOf(m.data));
      cur.cost += num(m.data && m.data.cost);
      const u = msgUsage(m.data);
      if (u) {
        cur.usageCalls++;
        cur.usage = cur.usage || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
        cur.usage.input += u.input;
        cur.usage.output += u.output;
        cur.usage.reasoning += u.reasoning;
        cur.usage.cacheRead += u.cacheRead;
        cur.usage.cacheWrite += u.cacheWrite;
      }
    }
  }

  const completeUsage =
    turns.length > 0 &&
    turns.every((t) => t.apiCalls > 0 && t.usageCalls === t.apiCalls);
  if (completeUsage) {
    return turns.map((t, i) =>
      finalizeTurn(
        {
          prompt: t.prompt || promptFor(inputs, i),
          response: t.response,
          model: t.model || sessionModel,
          usage: t.usage || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: t.cost,
          apiCalls: t.apiCalls,
          toolCalls: t.toolCalls,
          ts: t.ts,
          endTs: t.endTs,
        },
        { sessionId, cwd, index: i },
      ),
    );
  }

  // Any missing assistant usage makes per-turn accounting incomplete. Do not
  // invent an allocation: emit one authoritative session rollup instead.
  return [sessionRecord(session, inputs, { sessionId, cwd })];
}

const promptFor = (inputs, i) => (inputs[i] && inputs[i].prompt) || (inputs[0] && inputs[0].prompt) || "";

function finalizeTurn(t, ctx) {
  const u = t.usage;
  const usage = {
    input: num(u.input),
    output: num(u.output),
    reasoning: num(u.reasoning),
    cacheCreate: num(u.cacheWrite),
    cacheRead: num(u.cacheRead),
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const ctxTokens = usage.input + usage.cacheRead;
  const ctxMax = contextMax(t.model);
  const total = num(t.cost);
  const ts = isoOrNull(t.ts);
  const endTs = isoOrNull(t.endTs) || ts;
  return record({
    id: `${ctx.sessionId}:${ctx.index}`,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    model: t.model || null,
    prompt: t.prompt || "",
    response: t.response || "",
    ts,
    endTs,
    durationMs: ts && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(ts)) : 0,
    usage,
    ctxTokens,
    ctxMax,
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total, source: "provider" },
    counts: { apiCalls: t.apiCalls, subagentCalls: 0, toolCalls: t.toolCalls, thinkingBlocks: 0 },
  });
}

function sessionRecord(session, inputs, ctx) {
  const s = session || {};
  const usage = {
    input: num(s.tokens_input),
    output: num(s.tokens_output),
    reasoning: num(s.tokens_reasoning),
    cacheCreate: num(s.tokens_cache_write),
    cacheRead: num(s.tokens_cache_read),
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const ctxTokens = usage.input + usage.cacheRead;
  const ts = isoOrNull(s.time_created);
  const endTs = isoOrNull(s.time_updated) || ts;
  return record({
    id: `${ctx.sessionId}:0`,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    model: cleanModel(s.model),
    prompt: (inputs[0] && inputs[0].prompt) || s.title || "",
    response: "",
    ts,
    endTs,
    durationMs: ts && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(ts)) : 0,
    usage,
    ctxTokens,
    ctxMax: contextMax(cleanModel(s.model)),
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: num(s.cost), source: "provider" },
    counts: { apiCalls: 0, subagentCalls: 0, toolCalls: 0, thinkingBlocks: 0 },
    quality: "session-rollup",
  });
}

// Assemble a full schema-2 record from the pieces above.
function record(r) {
  return {
    id: r.id,
    provider: "opencode",
    sessionId: r.sessionId,
    cwd: r.cwd,
    slug: null,
    gitBranch: null,
    cliVersion: null,
    entrypoint: "opencode",
    ts: r.ts,
    endTs: r.endTs,
    durationMs: r.durationMs || 0,
    firstResponseMs: 0,
    prompt: r.prompt,
    promptChars: r.prompt.length,
    response: r.response,
    responseChars: r.response.length,
    model: r.model,
    serviceTier: null,
    speed: null,
    permissionMode: "default",
    effortLevel: null,
    skills: [],
    usage: r.usage,
    contextTokens: r.ctxTokens,
    contextMax: r.ctxMax,
    contextFillPct: r.ctxMax ? Math.round((r.ctxTokens / r.ctxMax) * 1000) / 10 : 0,
    counts: r.counts,
    cost: r.cost,
    ...(r.quality ? { quality: r.quality } : {}),
    schema: 2,
  };
}
