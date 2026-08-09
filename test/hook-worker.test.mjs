import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLauncher } from "../src/record.mjs";
import { drainSpool } from "../src/worker.mjs";

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

test("launcher returns 0 and spools malformed input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-launcher-"));
  const spool = path.join(dir, "spool");
  try {
    const status = await runLauncher({
      cwd: dir,
      input: "{broken-json",
      dir: spool,
      provider: "claude",
      spawnWorker: false,
    });
    assert.equal(status, 0);

    const files = fs.readdirSync(spool).filter((name) => name.endsWith(".event"));
    assert.equal(files.length, 1);
    const envelope = JSON.parse(fs.readFileSync(path.join(spool, files[0]), "utf8"));
    assert.equal(envelope.schema, 1);
    assert.equal(envelope.provider, "claude");
    assert.equal(envelope.cwd, dir);
    assert.equal(envelope.raw, "{broken-json");
    assert.equal(envelope.attempts, 0);

    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "x");
    assert.equal(await runLauncher({ input: "", dir: blocker, spawnWorker: false }), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker drains spooled hook into usage records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-worker-"));
  const project = path.join(dir, "project");
  const spool = path.join(dir, "spool");
  const transcript = path.join(dir, "rollout.jsonl");
  fs.mkdirSync(project, { recursive: true });
  const event = (timestamp, type, payload) => ({ timestamp, type, payload });
  writeJsonl(transcript, [
    event("2026-08-09T10:00:00.000Z", "session_meta", { id: "spooled-session", cwd: project }),
    event("2026-08-09T10:00:00.010Z", "turn_context", { model: "gpt-test", effort: "medium" }),
    event("2026-08-09T10:00:01.000Z", "event_msg", { type: "task_started", turn_id: "spooled-turn" }),
    event("2026-08-09T10:00:01.100Z", "event_msg", { type: "user_message", message: "spooled prompt" }),
    event("2026-08-09T10:00:02.000Z", "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "spooled answer" }] }),
    event("2026-08-09T10:00:03.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 }, model_context_window: 1000 } }),
  ]);
  try {
    const payload = JSON.stringify({
      session_id: "spooled-session",
      cwd: project,
      transcript_path: transcript,
      model: "gpt-test",
    });
    const launched = await runLauncher({
      input: payload,
      dir: spool,
      provider: "codex",
      spawnWorker: false,
    });
    assert.equal(launched, 0);

    const worked = await drainSpool({ dir: spool });
    assert.deepEqual(worked, { processed: 1, failed: 0 });
    assert.deepEqual(fs.readdirSync(spool), []);

    const usageFile = path.join(project, ".ai-usage", "usage.ndjson");
    const records = fs.readFileSync(usageFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, "spooled-turn");
    assert.equal(records[0].prompt, "spooled prompt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker recovers orphan and bounds poison retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-recovery-"));
  const envelope = (raw) => JSON.stringify({
    schema: 1,
    provider: "claude",
    cwd: dir,
    raw,
    createdAt: Date.now(),
    attempts: 0,
    aiUsageDir: null,
  }) + "\n";
  try {
    const orphan = path.join(dir, "orphan-a0.work");
    fs.writeFileSync(orphan, envelope("orphan"));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(orphan, old, old);
    fs.writeFileSync(path.join(dir, "malformed-a0.event"), "not-json\n");
    fs.writeFileSync(path.join(dir, "retry-a2.event"), envelope("fail"));

    const seen = [];
    const result = await drainSpool({
      dir,
      workStaleMs: 1000,
      maxAttempts: 3,
      handle: async (item) => {
        seen.push([item.raw, item.attempts]);
        if (item.raw === "fail") throw new Error("poison");
        return { permanent: false };
      },
    });

    assert.deepEqual(seen, [["orphan", 1], ["fail", 3]]);
    assert.deepEqual(result, { processed: 1, failed: 2 });
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
