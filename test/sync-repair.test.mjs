import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recordInstall, repairDue } from "../src/lib/scan-state.mjs";

const SYNC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sync.mjs");

// The dashboard runs `sync --days 7` at start, and on a --local or autoSweep:false
// machine nothing else runs automatically, so sync must honour a repair an upgrade
// asked for, and read the whole history exactly once.
test("sync reads a provider's whole history once when an upgrade owes a repair", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-synchome-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-syncproj-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  const state = path.join(home, "scan-state.json");
  const thread = "019f5143-59f3-7143-8649-4ff9f3b2f7cf";
  const day = path.join(home, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-08-01T10-00-00-${thread}.jsonl`);
  const rec = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
  fs.writeFileSync(rollout, [
    rec("2026-08-01T10:00:00.000Z", "session_meta", { id: thread, cwd: project, cli_version: "0.154.0" }),
    rec("2026-08-01T10:00:01.000Z", "event_msg", { type: "user_message", message: "an old turn" }),
    rec("2026-08-01T10:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 1 }, last_token_usage: { input_tokens: 10, output_tokens: 1 } } }),
  ].join("\n") + "\n");
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(rollout, old, old);

  const env = { ...process.env, HOME: home, USERPROFILE: home, AI_USAGE_SCAN_STATE_FILE: state, NO_COLOR: "1" };
  delete env.AI_USAGE_DIR;
  delete env.CODEX_HOME;
  const usage = path.join(project, ".ai-usage", "usage.ndjson");
  const rows = () => (fs.existsSync(usage) ? fs.readFileSync(usage, "utf8").split("\n").filter(Boolean).length : 0);
  const sync = () => {
    const r = spawnSync(process.execPath, [SYNC, "--provider", "codex", "--days", "7"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };

  sync();
  assert.equal(rows(), 0, "a 30-day-old rollout is outside a 7-day window");

  await recordInstall({ file: state, upgrading: true, providerIds: ["codex"] });
  sync();
  assert.equal(rows(), 1, "the owed repair reads the whole history");
  assert.equal(repairDue("codex", { file: state }), null, "and settles it");

  fs.rmSync(path.join(project, ".ai-usage"), { recursive: true, force: true });
  sync();
  assert.equal(rows(), 0, "only once");
});
