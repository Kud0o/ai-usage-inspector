import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTurns } from "../src/providers/claude/transcript.mjs";

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// <dir>/<session>.jsonl  +  <dir>/<session>/subagents/*.jsonl
function session(t, name = "sess-1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, `${name}.jsonl`), subDir: path.join(dir, name, "subagents") };
}

const user = (ts, text, extra = {}) => ({
  type: "user",
  uuid: `u-${ts}`,
  sessionId: "sess-1",
  cwd: "K:\\repo",
  timestamp: ts,
  message: { content: text },
  ...extra,
});
const asst = (ts, id, blocks, usage, extra = {}) => {
  const { message: messageExtra, ...rest } = extra;
  return {
    type: "assistant",
    timestamp: ts,
    ...rest,
    message: { id, model: "claude-sonnet-4-5", content: blocks, usage, ...(messageExtra || {}) },
  };
};
const usage = (input, output, extra = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...extra,
});

test("streamed lines sharing message.id become one API call with the final usage", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "do it"),
    // Same message.id across streamed checkpoints: usage grows, blocks accumulate.
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "partial" }], usage(100, 5)),
    asst("2026-08-10T10:00:03.000Z", "m1", [{ type: "text", text: " done" }], usage(100, 42), {
      message: { stop_reason: "end_turn" },
    }),
  ]);

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.equal(turn.counts.apiCalls, 1, "one message, not one per streamed line");
  assert.equal(turn.usage.output, 42, "final usage wins, never the sum");
  assert.equal(turn.usage.input, 100);
  assert.equal(turn.response, "partial done");
  assert.equal(turn.model, "claude-sonnet-4-5");
  assert.equal(turn.cost.source, "priced");
  assert.ok(turn.cost.total > 0);
  assert.equal(turn.firstResponseMs, 1000, "TTFT measured to the FIRST streamed line");
  assert.equal(turn.durationMs, 3000);
});

test("tool results, meta entries, and sidechains are not human prompts", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "real prompt"),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "ok" }], usage(10, 1)),
    // none of these may open a turn
    user("2026-08-10T10:00:02.000Z", "meta", { isMeta: true }),
    user("2026-08-10T10:00:03.000Z", "side", { isSidechain: true }),
    { ...user("2026-08-10T10:00:04.000Z", "tool"), toolUseResult: { ok: true } },
    {
      ...user("2026-08-10T10:00:05.000Z", ""),
      message: { content: [{ type: "tool_result", content: "x" }] },
    },
  ]);

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, "real prompt");
});

test("subagent tokens attribute to the initiating prompt; subagentCalls counts files", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "spawn agents", { promptId: "p1" }),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "main" }], usage(100, 10)),
  ]);
  // Two files = two Task invocations; the first has THREE assistant messages, so a
  // flattened message count would report 4 instead of 2.
  writeJsonl(path.join(s.subDir, "a.jsonl"), [
    { type: "user", promptId: "p1", isSidechain: true, timestamp: "2026-08-10T10:00:02.000Z", message: { content: "go" } },
    asst("2026-08-10T10:00:03.000Z", "s1", [{ type: "text", text: "a" }], usage(50, 5)),
    asst("2026-08-10T10:00:04.000Z", "s2", [{ type: "text", text: "b" }], usage(50, 5)),
    asst("2026-08-10T10:00:05.000Z", "s3", [{ type: "text", text: "c" }], usage(50, 5)),
  ]);
  writeJsonl(path.join(s.subDir, "b.jsonl"), [
    { type: "user", promptId: "p1", isSidechain: true, timestamp: "2026-08-10T10:00:06.000Z", message: { content: "go" } },
    asst("2026-08-10T10:00:07.000Z", "s4", [{ type: "text", text: "d" }], usage(50, 5)),
  ]);

  const turn = buildTurns(s.file)[0];
  assert.equal(turn.counts.subagentCalls, 2, "invocations = files, not assistant messages");
  assert.equal(turn.counts.apiCalls, 1, "main-thread calls only");
  assert.equal(turn.usage.input, 100 + 4 * 50, "subagent tokens roll into the parent turn");
  assert.equal(turn.usage.output, 10 + 4 * 5);
  assert.equal(turn.response, "main", "subagent text stays out of the parent response");
});

test("skills, tool calls, and thinking blocks are counted from the turn", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "use a skill"),
    asst("2026-08-10T10:00:01.000Z", "m1", [
      { type: "thinking", thinking: "hmm" },
      { type: "tool_use", name: "Skill", input: { skill: "caveman" } },
      { type: "tool_use", name: "Read", input: { file: "x" } },
      { type: "tool_use", name: "Skill", input: { skill: "caveman" } }, // duplicate -> once
      { type: "text", text: "done" },
    ], usage(10, 2)),
  ]);

  const turn = buildTurns(s.file)[0];
  assert.deepEqual(turn.skills, ["caveman"]);
  assert.equal(turn.counts.toolCalls, 3);
  assert.equal(turn.counts.thinkingBlocks, 1);
});

test("context fill uses the last request's full input, not the token sum", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "a"),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "x" }], usage(1000, 5)),
    asst("2026-08-10T10:00:02.000Z", "m2", [{ type: "text", text: "y" }], usage(2000, 5, {
      cache_read_input_tokens: 500,
    })),
  ]);

  const turn = buildTurns(s.file)[0];
  assert.equal(turn.usage.input, 3000, "usage totals still sum every call");
  assert.equal(turn.contextTokens, 2500, "context = last call's input + cache read");
  assert.ok(turn.contextMax > 0);
});

test("a missing or empty transcript yields no turns", (t) => {
  const s = session(t);
  assert.deepEqual(buildTurns(path.join(s.dir, "nope.jsonl")), []);
  writeJsonl(s.file, []);
  assert.deepEqual(buildTurns(s.file), []);
});

test("torn trailing lines are skipped without losing earlier turns", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "keep me"),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "ok" }], usage(10, 1)),
  ]);
  fs.appendFileSync(s.file, '{"type":"assistant","message":{"id":"m2"'); // half-written line

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, "keep me");
});
