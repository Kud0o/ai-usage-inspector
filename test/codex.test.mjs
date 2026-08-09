import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTurns } from "../src/providers/codex/transcript.mjs";

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
