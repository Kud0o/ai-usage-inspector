import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runLauncher } from "../src/record.mjs";
import { drainSpool, sweepProviders, shouldSweepNow } from "../src/worker.mjs";

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

  setLastScan(now - 1000);
  assert.equal(shouldSweepNow({ now }), true, "quiet spool sweeps");

  fs.writeFileSync(path.join(spool, "pending.event"), "{}");
  assert.equal(shouldSweepNow({ now, starvationMs: 60_000 }), false, "a busy spool defers");

  setLastScan(now - 120_000);
  assert.equal(shouldSweepNow({ now, starvationMs: 60_000 }), true, "starved long enough, sweep anyway");
});
