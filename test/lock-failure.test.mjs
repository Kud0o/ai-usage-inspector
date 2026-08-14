import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LockTimeoutError, upsertSession, addTombstones, tombstonePath } from "../src/lib/store.mjs";

function tmpFile(t, name = "usage.ndjson") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-lockfail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}
const rec = (id) => ({ provider: "claude", sessionId: "s1", id, usage: { input: 1 }, cost: { total: 1, source: "priced" } });

test("a held lock makes upsertSession throw, not report a phantom write", async (t) => {
  const file = tmpFile(t);
  // A fresh lock owned by someone else (not stale, so it is never stolen).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, "99999:another-live-process");

  await assert.rejects(
    () => upsertSession(file, "s1", [rec("s1:0")]),
    (err) => err instanceof LockTimeoutError && err.code === "ELOCKTIMEOUT",
  );
  // Nothing was written — the throw is what tells the caller to retry.
  assert.equal(fs.existsSync(file), false);
});

test("a legitimate zero still returns 0 rather than throwing", async (t) => {
  const file = tmpFile(t);
  const record = rec("s1:0");
  assert.equal(await upsertSession(file, "s1", [record]), 1);
  // Tombstoned -> nothing accepted, but the write itself succeeded.
  await addTombstones(tombstonePath(file), [record]);
  assert.equal(await upsertSession(file, "s1", [record]), 0);
});

test("the worker leaves a spool entry for retry when the write fails", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-lockspool-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, `event-${Date.now()}-1-abc-a0.event`),
    JSON.stringify({ schema: 1, provider: "claude", cwd: dir, raw: "{}", truncated: false, createdAt: Date.now(), attempts: 0, aiUsageDir: null }) + "\n",
  );
  const worker = await import("../src/worker.mjs");
  const result = await worker.drainSpool({
    dir,
    handle: async () => {
      throw new LockTimeoutError("usage.ndjson");
    },
  });
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  // Re-queued (attempt bumped) rather than dropped.
  const left = fs.readdirSync(dir).filter((f) => f.endsWith(".event"));
  assert.equal(left.length, 1, "event must survive for a later attempt");
  assert.match(left[0], /-a1\.event$/);
});

// A scan whose discovery is healthy but whose write fails must NOT advance the
// mark — otherwise the next window starts past turns that were never stored.
async function rescanWithFakeProvider(t, buildTurns) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-lockmark-"));
  const previous = process.env.AI_USAGE_SCAN_STATE_FILE;
  t.after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AI_USAGE_SCAN_STATE_FILE;
    else process.env.AI_USAGE_SCAN_STATE_FILE = previous;
  });
  const stateFile = path.join(stateDir, "scan-state.json");
  process.env.AI_USAGE_SCAN_STATE_FILE = stateFile;

  const { rescan } = await import("../src/worker.mjs");
  const { readScanState } = await import("../src/lib/scan-state.mjs");
  await rescan(
    {
      id: "cursor",
      discoverTranscripts: async () => [{ transcriptPath: { composerId: "c1" }, opts: { cwd: stateDir } }],
      buildTurns,
    },
    {},
  );
  return readScanState(stateFile).providers.cursor || {};
}

test("rescan does NOT advance the mark when the write fails", async (t) => {
  const entry = await rescanWithFakeProvider(t, async () => {
    throw new LockTimeoutError("usage.ndjson");
  });
  assert.equal(entry.lastScanCompleted, false);
  assert.equal(entry.lastSuccessfulScanMs, undefined, "mark must not advance past unwritten work");
});

test("rescan DOES advance the mark on a clean scan", async (t) => {
  const entry = await rescanWithFakeProvider(t, async () => []); // healthy, nothing to store
  assert.equal(entry.lastScanCompleted, true);
  assert.equal(entry.lastScanStatus, "ok");
  assert.ok(entry.lastSuccessfulScanMs > 0, "a clean scan must advance the mark");
});
