// Parse a Claude Code transcript (+ its subagent transcripts) into per-prompt
// "turn" records. Zero dependencies.
//
// Key realities of the JSONL format this handles:
//  - One assistant message spans MULTIPLE lines (one per content block /
//    streaming checkpoint), all sharing message.id. Usage is repeated and grows
//    to a final value -> we dedupe by message.id and keep the final usage.
//  - Subagent turns live in separate files under <session>/subagents/, flagged
//    isSidechain:true, and carry the initiating prompt's `promptId` -> we
//    attribute their tokens/cost to the matching main-thread turn.
//  - Subagents may run a different model -> cost is computed per message.

import fs from "node:fs";
import { costOf, contextMax, zeroCost, addCost } from "./pricing.mjs";
import { subagentsDir } from "./paths.mjs";

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

// Is this entry a genuine human prompt on the main thread?
function isHumanPrompt(e) {
  if (!e || e.type !== "user" || e.isSidechain === true) return false;
  if (e.isMeta) return false;
  if (e.toolUseResult !== undefined) return false; // tool result, not a prompt
  const c = e.message && e.message.content;
  if (typeof c === "string") return true;
  if (Array.isArray(c)) return !c.some((b) => b && b.type === "tool_result");
  return false;
}

function promptText(e) {
  const c = e.message && e.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// Group assistant entries by message.id, keeping the final usage (max
// output_tokens) and the union of content blocks across partial lines.
function collectAssistants(entries) {
  const byId = new Map();
  const order = [];
  for (const e of entries) {
    if (!e || e.type !== "assistant" || !e.message || !e.message.id) continue;
    const id = e.message.id;
    let g = byId.get(id);
    if (!g) {
      g = {
        id,
        model: e.message.model,
        promptId: e.promptId,
        blocks: [],
        usage: e.message.usage || null,
        bestOut: (e.message.usage && e.message.usage.output_tokens) || -1,
        stopReason: e.message.stop_reason || null,
        ts: e.timestamp,
        serviceTier: e.message.usage && e.message.usage.service_tier,
        speed: e.message.usage && e.message.usage.speed,
      };
      byId.set(id, g);
      order.push(id);
    }
    if (Array.isArray(e.message.content)) g.blocks.push(...e.message.content);
    const out = (e.message.usage && e.message.usage.output_tokens) || 0;
    // Keep the most complete usage (final streamed value / the one that stopped).
    if (e.message.usage && (e.message.stop_reason || out > g.bestOut)) {
      g.usage = e.message.usage;
      g.bestOut = out;
      g.stopReason = e.message.stop_reason || g.stopReason;
      g.serviceTier = e.message.usage.service_tier || g.serviceTier;
      g.speed = e.message.usage.speed || g.speed;
      g.ts = e.timestamp || g.ts;
    }
    if (e.promptId && !g.promptId) g.promptId = e.promptId;
  }
  return order.map((id) => byId.get(id));
}

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
}

function addUsageTokens(acc, u) {
  if (!u) return;
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheCreate += u.cache_creation_input_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  const cc = u.cache_creation || {};
  acc.cacheCreate1h += cc.ephemeral_1h_input_tokens || 0;
  acc.cacheCreate5m += cc.ephemeral_5m_input_tokens || 0;
  const st = u.server_tool_use || {};
  acc.webSearch += st.web_search_requests || 0;
  acc.webFetch += st.web_fetch_requests || 0;
}

function countBlocks(messages) {
  let toolCalls = 0;
  let thinking = 0;
  for (const m of messages) {
    for (const b of m.blocks) {
      if (!b) continue;
      if (b.type === "tool_use") toolCalls++;
      else if (b.type === "thinking") thinking++;
    }
  }
  return { toolCalls, thinking };
}

function responseText(messages) {
  const parts = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

// Build promptId -> [subagent assistant messages] from the subagents dir.
function loadSubagents(transcriptPath) {
  const dir = subagentsDir(transcriptPath);
  const byPrompt = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return byPrompt;
  }
  for (const f of files) {
    const entries = readJsonl(`${dir}/${f}`);
    // A subagent file is one Task invocation -> one promptId, carried on its
    // user entries (the assistant entries don't repeat it).
    const fileEntry = entries.find((e) => e && e.promptId);
    const pid = (fileEntry && fileEntry.promptId) || "__none__";
    if (!byPrompt.has(pid)) byPrompt.set(pid, []);
    const bucket = byPrompt.get(pid);
    for (const m of collectAssistants(entries)) bucket.push(m);
  }
  return byPrompt;
}

/**
 * Parse a transcript into an array of turn records (one per human prompt).
 * Returns [] if the file can't be read or has no human prompts.
 */
export function buildTurns(transcriptPath, opts = {}) {
  const entries = readJsonl(transcriptPath);
  if (!entries.length) return [];

  const assistants = collectAssistants(entries);
  const assistantById = new Map(assistants.map((a) => [a.id, a]));
  const subByPrompt = loadSubagents(transcriptPath);

  // Walk entries in order, segmenting at human prompts and attaching each
  // unique assistant message to the open turn.
  const turns = [];
  let cur = null;
  const consumed = new Set();
  for (const e of entries) {
    if (isHumanPrompt(e)) {
      cur = {
        promptEntry: e,
        promptId: e.promptId || null,
        main: [],
      };
      turns.push(cur);
    } else if (e.type === "assistant" && e.message && e.message.id && cur) {
      const id = e.message.id;
      if (!consumed.has(id) && assistantById.has(id)) {
        consumed.add(id);
        cur.main.push(assistantById.get(id));
      }
    }
  }

  return turns.map((t) => finalizeTurn(t, subByPrompt, opts)).filter(Boolean);
}

function finalizeTurn(t, subByPrompt, opts) {
  const e = t.promptEntry;
  const main = t.main;
  const subs = (t.promptId && subByPrompt.get(t.promptId)) || [];

  // Token totals (main + subagents), deduped already by message.id.
  const tokens = emptyTokens();
  let cost = zeroCost();
  for (const m of main) {
    addUsageTokens(tokens, m.usage);
    cost = addCost(cost, costOf(m.model, m.usage));
  }
  for (const m of subs) {
    addUsageTokens(tokens, m.usage);
    cost = addCost(cost, costOf(m.model, m.usage));
  }

  const last = main[main.length - 1];
  const model = (last && last.model) || (e.message && e.message.model) || "unknown";
  const ctxMax = contextMax(model);
  // Context occupancy = the full input that went into the last main request.
  const lastUsage = (last && last.usage) || {};
  const ctxTokens =
    (lastUsage.input_tokens || 0) +
    (lastUsage.cache_read_input_tokens || 0) +
    (lastUsage.cache_creation_input_tokens || 0);

  const { toolCalls, thinking } = countBlocks(main);
  const prompt = promptText(e);
  const response = responseText(main);
  const startTs = e.timestamp;
  const endTs = (last && last.ts) || startTs;
  const durationMs =
    startTs && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(startTs)) : 0;

  return {
    id: e.uuid || `${e.sessionId}:${e.promptId || startTs}`,
    sessionId: e.sessionId,
    cwd: e.cwd,
    slug: e.slug || null,
    gitBranch: e.gitBranch || null,
    cliVersion: e.version || null,
    entrypoint: e.entrypoint || null,
    ts: startTs,
    endTs,
    durationMs,
    prompt,
    promptChars: prompt.length,
    response,
    responseChars: response.length,
    model,
    serviceTier: (last && last.serviceTier) || null,
    speed: (last && last.speed) || null,
    permissionMode: e.permissionMode || "default",
    effortLevel: opts.effortLevel || null,
    usage: tokens,
    contextTokens: ctxTokens,
    contextMax: ctxMax,
    contextFillPct: ctxMax ? Math.round((ctxTokens / ctxMax) * 1000) / 10 : 0,
    counts: {
      apiCalls: main.length,
      subagentCalls: subs.length,
      toolCalls,
      thinkingBlocks: thinking,
    },
    cost: {
      input: round4(cost.input),
      output: round4(cost.output),
      cacheWrite: round4(cost.cacheWrite),
      cacheRead: round4(cost.cacheRead),
      total: round4(cost.total),
    },
    schema: 1,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
