import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runLauncher } from "../src/record.mjs";
import { drainSpool, rescan, sweepProviders, shouldSweepNow, msSinceLastScan } from "../src/worker.mjs";
import { REPAIR_EPOCH, claimScan, recordInstall, recordScanResult, repairDue } from "../src/lib/scan-state.mjs";
import { buildTurns } from "../src/providers/claude/transcript.mjs";

// Point scan bookkeeping at a throwaway file: these tests must never touch the
// real ~/.ai-usage-inspector/scan-state.json.
function withScanState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-state-"));
  const saved = process.env.AI_USAGE_SCAN_STATE_FILE;
  process.env.AI_USAGE_SCAN_STATE_FILE = path.join(dir, "scan-state.json");
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_SCAN_STATE_FILE;
    else process.env.AI_USAGE_SCAN_STATE_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}


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

// The failure this exists for: a delegated CLI run (e.g. "codex exec" behind a
// delegate skill) writes its transcript but fires no Stop hook, so its cost stays
// invisible until something scans. The next hook from any agent has to pull it in.
test("sweepProviders scans a provider that has never been scanned", async (t) => {
  withScanState(t);
  const seen = [];
  const providers = [
    { id: "codex", discoverTranscripts: () => [] },
    { id: "cursor", discoverTranscripts: () => [] },
  ];
  const swept = await sweepProviders({
    providers,
    scan: async (p) => { seen.push(p.id); },
  });
  assert.deepEqual(swept, ["codex", "cursor"]);
  assert.deepEqual(seen, ["codex", "cursor"], "each provider actually scanned");
});

test("a provider without discovery is left alone", async (t) => {
  withScanState(t);
  const swept = await sweepProviders({
    providers: [{ id: "hook-only" }],
    scan: async () => { throw new Error("must not scan"); },
  });
  assert.deepEqual(swept, []);
});

// A burst of turns must not re-walk every store once per turn.
test("sweepProviders throttles a provider scanned moments ago", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-sweep-"));
  const statePath = path.join(dir, "scan-state.json");
  const saved = process.env.AI_USAGE_SCAN_STATE_FILE;
  process.env.AI_USAGE_SCAN_STATE_FILE = statePath;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_SCAN_STATE_FILE;
    else process.env.AI_USAGE_SCAN_STATE_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = 1_000_000;
  fs.writeFileSync(statePath, JSON.stringify({
    schema: 1,
    providers: { codex: { lastScanAtMs: now - 5_000, lastSuccessfulScanMs: now - 5_000 } },
  }));

  const providers = [{ id: "codex", discoverTranscripts: () => [] }];
  const fresh = await sweepProviders({ now, throttleMs: 60_000, providers, scan: async () => {} });
  assert.deepEqual(fresh, [], "scanned 5s ago, so skipped");

  const later = await sweepProviders({ now: now + 120_000, throttleMs: 60_000, providers, scan: async () => {} });
  assert.deepEqual(later, ["codex"], "past the throttle, scanned again");
});

// One unreadable store must not stop the others from being imported.
test("a provider that throws does not abort the sweep", async (t) => {
  withScanState(t);
  const swept = await sweepProviders({
    providers: [
      { id: "broken", discoverTranscripts: () => [] },
      { id: "fine", discoverTranscripts: () => [] },
    ],
    scan: async (p) => { if (p.id === "broken") throw new Error("store locked"); },
  });
  assert.deepEqual(swept, ["fine"]);
});

// Two detached workers can start in the same instant. Reading the throttle and
// then acting on it is a race — both see a stale mark, both scan, both ingest.
// The claim has to be atomic, so exactly one wins.
test("concurrent sweeps do not both scan the same provider", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-claim-"));
  const saved = process.env.AI_USAGE_SCAN_STATE_FILE;
  process.env.AI_USAGE_SCAN_STATE_FILE = path.join(dir, "scan-state.json");
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_SCAN_STATE_FILE;
    else process.env.AI_USAGE_SCAN_STATE_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const providers = [{ id: "codex", discoverTranscripts: () => [] }];
  let scans = 0;
  const now = 5_000_000;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      sweepProviders({ now, throttleMs: 60_000, providers, scan: async () => { scans += 1; } })),
  );

  const winners = results.filter((r) => r.length === 1).length;
  assert.equal(scans, 1, "exactly one worker scanned");
  assert.equal(winners, 1, "and exactly one reported it swept");
});


// installedForSweep() is not exported, so drive it the way the worker does: by
// running the real module with HOME pointed at a fixture. These cover the gate
// that decides whether a machine sweeps at all.
async function workerWithHome(t, home) {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  });
  // Fresh module instance so os.homedir() is read under the fixture HOME.
  return import(`${pathToFileURL(path.join(process.cwd(), "src", "worker.mjs")).href}?home=${encodeURIComponent(home)}`);
}



// Whether a machine sweeps at all is a gate of its own, so test it directly:
// asserting through sweepProviders() under a fixture HOME proves nothing, because
// no agents are detected there and the result is [] either way.
async function gateUnderHome(t, build) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-gate-"));
  build(home);
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const w = await import(
    `${pathToFileURL(path.join(process.cwd(), "src", "worker.mjs")).href}?home=${encodeURIComponent(home)}`
  );
  return w.sweepAllowed();
}

const writeHook = (home, rel, body) => {
  fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), body);
};

test("no global hook means no sweeping — a --local install stays put", async (t) => {
  assert.equal(await gateUnderHome(t, () => {}), false);
});

test("a global Claude hook enables sweeping", async (t) => {
  assert.equal(await gateUnderHome(t, (home) => {
    writeHook(home, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${home}/.ai-usage-inspector/app/src/record.mjs" --provider claude` }] }] },
    }));
  }), true);
});

// Cursor's global hook lives in ~/.cursor/hooks.json; leaving it out silently
// disabled sweeping for anyone who installed Cursor only.
test("a global Cursor hook also enables sweeping", async (t) => {
  assert.equal(await gateUnderHome(t, (home) => {
    writeHook(home, ".cursor/hooks.json", JSON.stringify({
      hooks: { Stop: [{ command: `node "${home}/app/src/record.mjs" --provider cursor` }] },
    }));
  }), true);
});

test("a passing mention of record.mjs is not an installation", async (t) => {
  assert.equal(await gateUnderHome(t, (home) => {
    writeHook(home, ".claude/settings.json", JSON.stringify({ note: "we used to run src/record.mjs here" }));
  }), false);
});

test("autoSweep:false turns sweeping off even with a global hook", async (t) => {
  assert.equal(await gateUnderHome(t, (home) => {
    writeHook(home, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `node "x/record.mjs" --provider claude` }] }] },
    }));
    writeHook(home, ".ai-usage-inspector/config.json", JSON.stringify({ schema: 2, autoSweep: false }));
  }), false);
});

// A busy machine never presents a quiet spool. Waiting for one forever means
// delegated work is never imported, so starvation has an escape.
test("sweeping waits for a quiet spool, but not forever", async (t) => {
  const dir = withScanState(t);
  const statePath = process.env.AI_USAGE_SCAN_STATE_FILE;
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const savedSpool = process.env.AI_USAGE_SPOOL_DIR;
  process.env.AI_USAGE_SPOOL_DIR = spool;
  t.after(() => {
    if (savedSpool === undefined) delete process.env.AI_USAGE_SPOOL_DIR;
    else process.env.AI_USAGE_SPOOL_DIR = savedSpool;
    fs.rmSync(spool, { recursive: true, force: true });
  });

  const now = 9_000_000;
  const setLastScan = (ms) => fs.writeFileSync(statePath, JSON.stringify({
    schema: 1, providers: { codex: { lastScanAtMs: ms } },
  }));

  const only = [{ id: "codex" }];
  setLastScan(now - 1000);
  assert.equal(shouldSweepNow({ now, providers: only }), true, "quiet spool sweeps");

  fs.writeFileSync(path.join(spool, "pending.event"), "{}");
  assert.equal(shouldSweepNow({ now, starvationMs: 60_000, providers: only }), false, "a busy spool defers");

  setLastScan(now - 120_000);
  assert.equal(shouldSweepNow({ now, starvationMs: 60_000, providers: only }), true, "starved long enough, sweep anyway");
});

// A lease with no owner could be released by anyone: a scan finishing after its
// lease expired and was re-taken would free the NEW holder's claim and admit a
// third overlapping scan.
test("only the lease holder can release it", async (t) => {
  withScanState(t);
  const first = await claimScan("codex", { throttleMs: 0, leaseMs: 60_000 });
  assert.ok(first, "first worker takes the lease");
  assert.equal(await claimScan("codex", { throttleMs: 0, leaseMs: 60_000 }), false, "second is refused");

  // A different worker's result must not free the held lease.
  await recordScanResult("codex", { scanStartedAtMs: Date.now(), status: "ok", completed: true, leaseId: "someone-else" });
  assert.equal(await claimScan("codex", { throttleMs: 0, leaseMs: 60_000 }), false, "still held");

  await recordScanResult("codex", { scanStartedAtMs: Date.now(), status: "ok", completed: true, leaseId: first });
  assert.ok(await claimScan("codex", { throttleMs: 0, leaseMs: 60_000 }), "the holder released it");
});

// Taking the NEWEST scan across providers let a chatty provider mask a starving
// one, so a provider whose work never arrived could wait forever.
test("starvation is measured per provider, not across them", async (t) => {
  const dir = withScanState(t);
  const statePath = process.env.AI_USAGE_SCAN_STATE_FILE;
  const now = 9_000_000;
  // codex scanned seconds ago, claude not for an hour: the machine IS starving.
  fs.writeFileSync(statePath, JSON.stringify({
    schema: 1,
    providers: { codex: { lastScanAtMs: now - 1000 }, claude: { lastScanAtMs: now - 3_600_000 } },
  }));
  const both = [{ id: "codex" }, { id: "claude" }];
  assert.equal(msSinceLastScan(now, both), 3_600_000, "reports the provider that has waited longest");
});

// A repair reads a provider's whole history once. A transcript that moved while
// being read belongs to a live session its hook reads again, so it must not keep
// the repair owed for ever; any other failure must.
test("a repair survives a transcript that moved, but not one that failed", async (t) => {
  withScanState(t);
  await recordInstall({ upgrading: true, providerIds: ["moving", "broken"] });
  const moved = () => {
    const err = new Error("transcript changed while being parsed");
    err.scanStatus = "locked";
    err.transcriptMoved = true;
    throw err;
  };
  await rescan({ id: "moving", discoverTranscripts: () => [{ transcriptPath: "x" }], buildTurns: moved }, {});
  await rescan({ id: "broken", discoverTranscripts: () => [{ transcriptPath: "x" }], buildTurns: () => { throw new Error("boom"); } }, {});
  assert.equal(repairDue("moving"), null);
  assert.equal(repairDue("broken"), REPAIR_EPOCH);
});

function claudeRepair(t) {
  const dir = withScanState(t);
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const sub = path.join(project, "web");
  fs.mkdirSync(home);
  fs.mkdirSync(sub, { recursive: true });
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedUsage = process.env.AI_USAGE_DIR;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.AI_USAGE_DIR;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    if (savedUsage === undefined) delete process.env.AI_USAGE_DIR; else process.env.AI_USAGE_DIR = savedUsage;
  });
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const id = "22222222-3333-4444-8555-666666666666";
  const transcriptPath = path.join(home, `${sessionId}.jsonl`);
  writeJsonl(transcriptPath, [
    { type: "user", uuid: id, sessionId, cwd: project, timestamp: "2026-08-01T10:00:00.000Z", message: { role: "user", content: "build it" } },
    { type: "assistant", uuid: "a1", sessionId, cwd: project, timestamp: "2026-08-01T10:00:05.000Z", message: { id: "m1", role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cd web && npm run build" } }], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "user", uuid: "r1", sessionId, cwd: sub, timestamp: "2026-08-01T10:00:09.000Z", toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  ]);
  const copyFile = path.join(sub, ".ai-usage", "usage.ndjson");
  writeJsonl(copyFile, [{ provider: "claude", sessionId, id, cwd: project, ts: "2026-08-01T10:00:00.000Z" }]);
  const rows = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const ownTurns = () => rows(path.join(project, ".ai-usage", "usage.ndjson")).map((r) => [r.provider, r.sessionId, r.id]);
  return {
    provider: { id: "claude", discoverTranscripts: () => [{ transcriptPath }], buildTurns },
    backupDir: path.join(home, ".ai-usage-inspector", "backups"),
    copyFile, rows, ownTurns, expected: [["claude", sessionId, id]],
  };
}

test("a Claude repair scan removes a copy left in another folder", async (t) => {
  const fixture = claudeRepair(t);
  await recordInstall({ upgrading: true, providerIds: ["claude"] });
  await rescan(fixture.provider, {});
  assert.deepEqual(fixture.ownTurns(), fixture.expected, "the session is whole in its own store");
  assert.deepEqual(fixture.rows(fixture.copyFile), [], "the copy is gone");
  const backups = fs.readdirSync(fixture.backupDir, { withFileTypes: true });
  assert.equal(backups.length, 1);
  assert.ok(backups[0].isDirectory(), "the copy was backed up first");
  assert.equal(repairDue("claude"), null);
});

test("a Claude repair scan whose backup fails stays owed and ingests nothing", async (t) => {
  const fixture = claudeRepair(t);
  // A file blocks backup-directory creation on Windows and POSIX, regardless of permissions.
  fs.mkdirSync(path.dirname(fixture.backupDir), { recursive: true });
  fs.writeFileSync(fixture.backupDir, "blocked");
  const copy = fs.readFileSync(fixture.copyFile);
  await recordInstall({ upgrading: true, providerIds: ["claude"] });
  let parsed = 0;
  await rescan({ ...fixture.provider, buildTurns: (...args) => { parsed++; return fixture.provider.buildTurns(...args); } }, {});
  assert.equal(parsed, 0, "backup failure must precede even the repair read");
  assert.deepEqual(fs.readFileSync(fixture.copyFile), copy, "a failed backup leaves the copy intact");
  assert.equal(repairDue("claude"), REPAIR_EPOCH);
});

test("a Claude repair backs up candidate bytes before reading any transcript", async (t) => {
  const fixture = claudeRepair(t);
  const before = fs.readFileSync(fixture.copyFile, "utf8");
  let backedUp = false;
  await recordInstall({ upgrading: true, providerIds: ["claude"] });
  await rescan({ ...fixture.provider, buildTurns: (...args) => {
    const dirs = fs.existsSync(fixture.backupDir) ? fs.readdirSync(fixture.backupDir) : [];
    for (const dir of dirs) {
      const manifest = JSON.parse(fs.readFileSync(path.join(fixture.backupDir, dir, "manifest.json")));
      backedUp ||= manifest.files.some((f) => f.source === fixture.copyFile && fs.readFileSync(f.backup, "utf8") === before);
    }
    return fixture.provider.buildTurns(...args);
  } }, {});
  assert.equal(backedUp, true);
});
