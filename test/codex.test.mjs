import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTurns, parseRolloutName } from "../src/providers/codex/transcript.mjs";
import * as codexProvider from "../src/providers/codex/index.mjs";
import { ingestTranscript } from "../src/lib/ingest.mjs";

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("modern Codex events track real prompts and cumulative token deltas", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-parser-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout-test.jsonl");
  const rec = (timestamp, type, payload) => ({ timestamp, type, payload });
  writeJsonl(file, [
    rec("2026-07-20T10:00:00.000Z", "session_meta", { id: "session-1", cwd: "K:\\repo", cli_version: "1.0" }),
    rec("2026-07-20T10:00:00.005Z", "world_state", { full: true, state: { host_skills: { body: "- openai-docs: Official docs workflow. (file: C:/skills/openai-docs/SKILL.md)" } } }),
    rec("2026-07-20T10:00:00.010Z", "turn_context", { model: "gpt-test", effort: "high" }),
    rec("2026-07-20T10:00:00.020Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>synthetic</environment_context>" }] }),
    rec("2026-07-20T10:00:01.000Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
    rec("2026-07-20T10:00:01.100Z", "event_msg", { type: "user_message", message: "real prompt one" }),
    rec("2026-07-20T10:00:02.000Z", "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer one" }] }),
    rec("2026-07-20T10:00:02.500Z", "response_item", { type: "custom_tool_call", name: "exec", input: "Get-Content C:\\skills\\openai-docs\\SKILL.md" }),
    rec("2026-07-20T10:00:03.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 }, model_context_window: 1000 } }),
    rec("2026-07-20T10:01:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-2" }),
    rec("2026-07-20T10:01:00.100Z", "event_msg", { type: "user_message", message: "real prompt two" }),
    rec("2026-07-20T10:01:01.000Z", "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer two" }] }),
    rec("2026-07-20T10:01:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 90, output_tokens: 55, reasoning_output_tokens: 12 }, last_token_usage: { input_tokens: 150, cached_input_tokens: 50, output_tokens: 35, reasoning_output_tokens: 7 }, model_context_window: 1000 } }),
  ]);

  const turns = buildTurns(file);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => [t.id, t.prompt, t.response]), [
    ["turn-1", "real prompt one", "answer one"],
    ["turn-2", "real prompt two", "answer two"],
  ]);
  assert.equal(turns[0].effortLevel, "high");
  assert.deepEqual(turns[0].skills, ["openai-docs"]);
  assert.deepEqual(turns[0].usage, { input: 60, output: 20, reasoning: 5, cacheCreate: 0, cacheRead: 40, cacheCreate1h: 0, cacheCreate5m: 0, webSearch: 0, webFetch: 0 });
  assert.deepEqual(turns[1].usage, { input: 100, output: 35, reasoning: 7, cacheCreate: 0, cacheRead: 50, cacheCreate1h: 0, cacheCreate5m: 0, webSearch: 0, webFetch: 0 });
});

test("Codex hook install migrates legacy TOML without deleting unrelated settings", { concurrency: false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-hook-"));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    fs.writeFileSync(path.join(dir, "config.toml"), [
      'model = "gpt-test"',
      "# >>> ai-usage-inspector (codex) >>>",
      "[[hooks.Stop]]",
      "[[hooks.Stop.hooks]]",
      'type = "command"',
      `command = 'node "${path.join(dir, "old", "ai-usage-inspector", "record.mjs")}" --provider codex'`,
      "[windows]",
      'sandbox = "unelevated"',
      "# <<< ai-usage-inspector (codex) <<<",
      "",
    ].join("\n"));
    const provider = await import(`../src/providers/codex/index.mjs?test=${Date.now()}`);
    const result = provider.install({ appPath: path.join(dir, "app") });
    assert.equal(result.action, "added");
    assert.equal(result.migrated, 1);
    const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(config, /model = "gpt-test"/);
    assert.match(config, /\[windows\]/);
    assert.match(config, /sandbox = "unelevated"/);
    assert.doesNotMatch(config, /ai-usage-inspector|hooks\.Stop|--provider codex/);
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.Stop.length, 1);
    assert.match(hooks.hooks.Stop[0].hooks[0].command, /--provider codex$/);

    const removed = provider.uninstall();
    assert.equal(removed.removed, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8")).hooks, undefined);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #1. `thread/revert` continues a thread in a new rollout under the same
// thread id: rollout-<ts>-<thread>_<rollout>.jsonl. Both files parse to the same
// session, and reading the second used to delete every turn of the first.

const THREAD = "019f5143-59f3-7143-8649-4ff9f3b2f7cf";
const ROLLOUT = "01a0718c-2b3c-7d4e-8f50-6a7b8c9d0e1f";

test("rollout filenames are read the way Codex writes them", () => {
  assert.deepEqual(parseRolloutName(`rollout-2026-09-05T08-45-15-${THREAD}.jsonl`), { threadId: THREAD, rolloutId: THREAD });
  assert.deepEqual(parseRolloutName(`rollout-2026-09-05T20-30-42-${THREAD}_${ROLLOUT}.jsonl`), { threadId: THREAD, rolloutId: ROLLOUT });
  assert.equal(parseRolloutName("rollout-test.jsonl"), null);
  assert.equal(parseRolloutName(`rollout-2026-09-05T20-30-42-${THREAD}_not-a-rollout-id.jsonl`), null);
  assert.equal(codexProvider.transcriptId(`/x/rollout-2026-09-05T20-30-42-${THREAD}_${ROLLOUT}.jsonl`), ROLLOUT);
  assert.equal(codexProvider.transcriptId("/x/rollout-test.jsonl"), "rollout-test", "a name Codex did not write still names its own file");
});

// The reporter's pair: the original file with two turns reaching 5,000 in / 500
// out, and the continuation with one turn whose counter runs from 300 to 800 in.
function writeRevertPair(dir, { turnId = null } = {}) {
  const rec = (timestamp, type, payload) => ({ timestamp, type, payload });
  const tokens = (input, output) => ({
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 },
      last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 },
      model_context_window: 100000,
    },
  });
  const meta = (ts) => [
    rec(ts, "session_meta", { id: THREAD, cwd: dir, cli_version: "0.154.0" }),
    rec(ts, "turn_context", { model: "gpt-test" }),
  ];
  const original = path.join(dir, `rollout-2026-09-05T08-45-15-${THREAD}.jsonl`);
  const continuation = path.join(dir, `rollout-2026-09-05T20-30-42-${THREAD}_${ROLLOUT}.jsonl`);
  writeJsonl(original, [
    ...meta("2026-09-05T08:45:15.000Z"),
    rec("2026-09-05T08:46:00.000Z", "event_msg", { type: "user_message", message: "before the revert, one" }),
    rec("2026-09-05T08:46:05.000Z", "event_msg", tokens(2000, 200)),
    rec("2026-09-05T08:47:00.000Z", "event_msg", { type: "user_message", message: "before the revert, two" }),
    rec("2026-09-05T08:47:05.000Z", "event_msg", tokens(5000, 500)),
  ]);
  writeJsonl(continuation, [
    ...meta("2026-09-05T20:30:42.000Z"),
    ...(turnId ? [rec("2026-09-05T20:30:59.000Z", "event_msg", { type: "task_started", turn_id: turnId })] : []),
    rec("2026-09-05T20:31:00.000Z", "event_msg", { type: "user_message", message: "after the revert" }),
    rec("2026-09-05T20:31:03.000Z", "event_msg", tokens(300, 30)),
    rec("2026-09-05T20:31:08.000Z", "event_msg", tokens(800, 80)),
  ]);
  return { original, continuation };
}

test("a continuation's position-based ids name its own turns; the original's are unchanged", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-revert-ids-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { original, continuation } = writeRevertPair(dir);
  assert.deepEqual(buildTurns(original).map((x) => [x.id, x.legacyId]), [[`${THREAD}:0`, undefined], [`${THREAD}:1`, undefined]]);
  const [turn] = buildTurns(continuation);
  assert.deepEqual([turn.id, turn.legacyId], [`${THREAD}:0@${ROLLOUT}`, `${THREAD}:0`]);
  assert.equal(turn.sessionId, THREAD, "still the same session");
});

test("a Codex turn id is unique on its own and is never qualified", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-revert-uuid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const turnId = "01a07e02-aaaa-7bbb-8ccc-dddddddddddd";
  const [turn] = buildTurns(writeRevertPair(dir, { turnId }).continuation);
  assert.equal(turn.id, turnId);
  assert.equal(turn.legacyId, undefined);
});

test("issue #1: both rollouts of a reverted thread keep their turns, in either order, however often synced", async (t) => {
  for (const order of ["original first", "continuation first"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-issue1-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { original, continuation } = writeRevertPair(dir);
    const files = order === "original first" ? [original, continuation] : [continuation, original];
    for (let pass = 0; pass < 3; pass++) {
      for (const transcriptPath of files) await ingestTranscript(codexProvider, { transcriptPath });
    }
    const rows = fs.readFileSync(path.join(dir, ".ai-usage", "usage.ndjson"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.sessionId === THREAD);
    assert.equal(rows.length, 3, `${order}: all three turns`);
    assert.equal(rows.reduce((n, r) => n + r.usage.input + r.usage.output, 0), 6380, `${order}: 5,500 + 880 tokens`);
  }
});

test("a copy of a rollout under a name Codex did not write cannot delete the other file's turns", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-copy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { original, continuation } = writeRevertPair(dir);
  const copy = path.join(dir, "rollout-copy.jsonl");
  fs.copyFileSync(original, copy);
  for (let pass = 0; pass < 2; pass++) {
    for (const transcriptPath of [original, continuation, copy]) await ingestTranscript(codexProvider, { transcriptPath });
  }
  const rows = fs.readFileSync(path.join(dir, ".ai-usage", "usage.ndjson"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.sessionId === THREAD);
  assert.equal(rows.length, 3, "no turn deleted, no turn doubled");
  assert.equal(rows.reduce((n, r) => n + r.usage.input + r.usage.output, 0), 6380);
});

test("archived rollouts are discovered too", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-archived-"));
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const live = path.join(home, "sessions", "2026", "09", "01", `rollout-2026-09-01T10-00-00-${THREAD}.jsonl`);
  const archived = path.join(home, "archived_sessions", `rollout-2026-07-10T21-13-33-${ROLLOUT}.jsonl`);
  writeJsonl(live, [{ timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: THREAD } }]);
  writeJsonl(archived, [{ timestamp: "2026-07-10T21:13:33.000Z", type: "session_meta", payload: { id: ROLLOUT } }]);
  const provider = await import(`../src/providers/codex/index.mjs?archived=${Date.now()}`);
  assert.deepEqual(
    provider.discoverTranscripts({ sinceMs: 0 }).map((f) => path.basename(f.transcriptPath)).sort(),
    [path.basename(archived), path.basename(live)].sort(),
  );
});

test("when one rollout exists twice, the fuller copy is the one read", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-codex-twocopies-"));
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const name = `rollout-2026-09-01T10-00-00-${THREAD}.jsonl`;
  const live = path.join(home, "sessions", "2026", "09", "01", name);
  const archived = path.join(home, "archived_sessions", name);
  const meta = { timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: THREAD } };
  const prompt = (n) => ({ timestamp: `2026-09-01T10:0${n}:00.000Z`, type: "event_msg", payload: { type: "user_message", message: `turn ${n}` } });
  writeJsonl(live, [meta, prompt(1), prompt(2)]);
  writeJsonl(archived, [meta, prompt(1)]);
  // The smaller copy is the newer file, so only size can pick the right one.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(archived, later, later);
  const provider = await import(`../src/providers/codex/index.mjs?twocopies=${Date.now()}`);
  assert.deepEqual(provider.discoverTranscripts({ sinceMs: 0 }).map((f) => f.transcriptPath), [live]);
});
