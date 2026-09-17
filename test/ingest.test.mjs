import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureBundleForTest, ingest, ingestTranscript } from "../src/lib/ingest.mjs";

const rowsIn = (dir) => {
  const file = path.join(dir, ".ai-usage", "usage.ndjson");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

test("a branch is placed by its own turn even when copied history names a disabled project", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-branch-home-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, "a"), b = path.join(dir, "b");
  fs.mkdirSync(path.join(a, ".ai-usage"), { recursive: true });
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, ".ai-usage", "config.json"), JSON.stringify({ enabled: false }));
  const transcriptPath = path.join(dir, "branch.jsonl");
  fs.writeFileSync(transcriptPath, "{}\n");
  const provider = { id: "claude", buildTurns: () => [
    { provider: "claude", sessionId: "branch", id: "x", cwd: a, copied: true },
    { provider: "claude", sessionId: "branch", id: "y", cwd: b },
  ] };
  await ingestTranscript(provider, { transcriptPath, cwd: a });
  assert.deepEqual(rowsIn(b).map((r) => r.id), ["x", "y"]);
  assert.deepEqual(rowsIn(a), []);
});

// A hook provider whose payload is the JSON it was given.
const hookProvider = (buildTurns) => ({
  id: "claude",
  normalizePayload: (raw) => ({ ...JSON.parse(raw), opts: {} }),
  buildTurns,
});

// Parsing happens outside the usage lock. A scan that reads a transcript, then
// waits on the lock while the agent appends a newer turn, would replace the
// session with its older snapshot — losing the turn that arrived in between.
test("a transcript that changes while being parsed is not written", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-stale-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(transcriptPath, "first\n");

  const provider = {
    id: "claude",
    // Stands in for the agent appending its next turn mid-parse.
    buildTurns: () => {
      fs.appendFileSync(transcriptPath, "second\n");
      return [{ provider: "claude", sessionId: "s1", id: "a", cwd: dir, cost: { total: 1 } }];
    },
  };

  await assert.rejects(
    () => ingestTranscript(provider, { transcriptPath, cwd: dir, sessionId: "s1" }),
    (err) => err && err.scanStatus === "locked" && err.transcriptMoved === true,
    "the pass is abandoned so the scan mark does not advance past the new turn",
  );
  assert.equal(fs.existsSync(path.join(dir, ".ai-usage", "usage.ndjson")), false, "nothing stale was stored");
});

test("an unchanged transcript ingests normally", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-fresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");

  const provider = {
    id: "claude",
    buildTurns: () => [{ provider: "claude", sessionId: "s1", id: "a", cwd: dir, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } }],
  };

  const written = await ingestTranscript(provider, { transcriptPath, cwd: dir, sessionId: "s1" });
  assert.equal(written, 1);
});

// The pre-write stamp still left a window: config work and the queue for the
// write lock both take time. This asserts the check that runs INSIDE the lock,
// by moving the file after parsing has finished.
test("a transcript that changes while waiting for the lock is not written", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-lockrace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(transcriptPath, "first\n");

  let parsed = false;
  const provider = {
    id: "claude",
    buildTurns: () => {
      parsed = true;
      return [{ provider: "claude", sessionId: "s1", id: "a", cwd: dir, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } }];
    },
  };

  // Land the new turn after parsing and its stamp check, in the window before
  // the write lock is taken.
  const original = fs.statSync;
  let armed = false;
  t.after(() => { fs.statSync = original; });
  fs.statSync = (...args) => {
    const out = original.apply(fs, args);
    if (parsed && !armed && String(args[0]) === transcriptPath) {
      armed = true;
      fs.appendFileSync(transcriptPath, "second\n");
    }
    return out;
  };

  await assert.rejects(
    () => ingestTranscript(provider, { transcriptPath, cwd: dir, sessionId: "s1" }),
    (err) => err && err.scanStatus === "locked" && err.transcriptMoved === true,
  );
});

// Only Claude and Codex hand over a file path. Cursor, OpenCode and the Cline
// family pass an opaque reference into their own store, so the guard was a no-op
// for them: statSync of an object returned null and the check passed always.
test("a provider's own stamp protects an opaque transcript reference", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-opaque-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let revision = 1;
  const provider = {
    id: "cursor",
    stampTranscript: () => `rev-${revision}`,
    buildTurns: () => {
      revision += 1; // the store moved while we were reading it
      return [{ provider: "cursor", sessionId: "s1", id: "a", cwd: dir, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } }];
    },
  };

  await assert.rejects(
    () => ingestTranscript(provider, { transcriptPath: { composerId: "c1", cwd: dir }, sessionId: "s1" }),
    (err) => err && err.scanStatus === "locked" && err.transcriptMoved === true,
  );
});

test("a stable opaque reference ingests normally", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-opaque2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = {
    id: "cursor",
    stampTranscript: () => "rev-1",
    buildTurns: () => [{ provider: "cursor", sessionId: "s1", id: "a", cwd: dir, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } }],
  };
  assert.equal(await ingestTranscript(provider, { transcriptPath: { composerId: "c1", cwd: dir }, sessionId: "s1" }), 1);
});

// One transcript can hold turns of two sessions. Each must replace its own rows:
// written under the first, the second session's turns were added beside their
// earlier copies on every read.
test("a transcript holding two sessions replaces each without duplicating", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-twosessions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "s1.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");
  const provider = {
    id: "claude",
    buildTurns: () => [
      { provider: "claude", sessionId: "s1", id: "a", cwd: dir, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } },
      { provider: "claude", sessionId: "s2", id: "b", cwd: dir, ts: "2026-01-01T00:01:00.000Z", cost: { total: 1 } },
    ],
  };
  await ingestTranscript(provider, { transcriptPath });
  await ingestTranscript(provider, { transcriptPath });
  const rows = fs.readFileSync(path.join(dir, ".ai-usage", "usage.ndjson"), "utf8").split("\n").filter(Boolean);
  assert.equal(rows.length, 2);
});

test("stored rows name their transcript only when the provider can say which it was", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-named-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "s1.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");
  const turnFor = (sessionId) => () => [{ provider: "claude", sessionId, id: "a", cwd: dir, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } }];
  await ingestTranscript({ id: "claude", buildTurns: turnFor("named"), transcriptId: () => "file-1" }, { transcriptPath });
  await ingestTranscript({ id: "claude", buildTurns: turnFor("unnamed") }, { transcriptPath });
  const rows = fs.readFileSync(path.join(dir, ".ai-usage", "usage.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.find((r) => r.sessionId === "named").transcriptId, "file-1");
  assert.equal(rows.find((r) => r.sessionId === "unnamed").transcriptId, undefined);
});

// Claude Code moves a desktop session into any project subfolder its own commands
// cd into, and its Stop hook reports that folder. Stored there, the whole session
// was copied into the subfolder's .ai-usage beside the original.
test("a hook reporting a subfolder stores the session where it started", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sub = path.join(root, "web");
  fs.mkdirSync(sub);
  const transcriptPath = path.join(root, "s1.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");
  const provider = hookProvider(() => [
    { provider: "claude", sessionId: "s1", id: "a", cwd: root, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } },
    { provider: "claude", sessionId: "s1", id: "b", cwd: sub, ts: "2026-01-01T00:01:00.000Z", cost: { total: 1 } },
  ]);
  await ingest(provider, JSON.stringify({ sessionId: "s1", cwd: sub, transcriptPath }));
  assert.deepEqual(rowsIn(root).map((r) => r.id), ["a", "b"]);
  assert.equal(fs.existsSync(path.join(sub, ".ai-usage")), false, "nothing is created in the subfolder");
});

test("a session resumed from another folder keeps storing where it started", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-home-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-elsewhere-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
  const transcriptPath = path.join(root, "s1.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");
  const provider = hookProvider(() => [
    { provider: "claude", sessionId: "s1", id: "a", cwd: root, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } },
    { provider: "claude", sessionId: "s1", id: "b", cwd: elsewhere, ts: "2026-01-02T00:00:00.000Z", cost: { total: 1 } },
  ]);
  await ingest(provider, JSON.stringify({ sessionId: "s1", cwd: elsewhere, transcriptPath }));
  assert.equal(rowsIn(root).length, 2);
  assert.equal(fs.existsSync(path.join(elsewhere, ".ai-usage")), false);
});

test("a session whose start folder is gone keeps recording in the hook's folder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-moved-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcriptPath = path.join(root, "s1.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");
  const gone = path.join(root, "renamed-away");
  const provider = hookProvider(() => [
    { provider: "claude", sessionId: "s1", id: "a", cwd: gone, ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } },
  ]);
  await ingest(provider, JSON.stringify({ sessionId: "s1", cwd: root, transcriptPath }));
  assert.equal(rowsIn(root).length, 1);
});

test("a sweep skips a session none of whose folders exists", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-stalehistory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcriptPath = path.join(root, "s1.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");
  const provider = {
    id: "claude",
    buildTurns: () => [{ provider: "claude", sessionId: "s1", id: "a", cwd: path.join(root, "gone"), ts: "2026-01-01T00:00:00.000Z", cost: { total: 1 } }],
  };
  assert.equal(await ingestTranscript(provider, { transcriptPath }), 0);
  assert.equal(fs.existsSync(path.join(root, "gone")), false, "no folder is created for stale history");
});

// Usage records carry prompts and responses; `git add -A` committed them into
// projects that had no ignore rule.
test("the usage folder ignores itself, and an ignore file already there is left alone", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-ignore-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ignoreFile = path.join(dir, ".ai-usage", ".gitignore");
  ensureBundleForTest(dir);
  assert.ok(fs.readFileSync(ignoreFile, "utf8").split("\n").includes("*"));
  fs.writeFileSync(ignoreFile, "usage.ndjson\n");
  ensureBundleForTest(dir);
  assert.equal(fs.readFileSync(ignoreFile, "utf8"), "usage.ndjson\n");
});

// Only a hook reads the effort setting; a sweep passes none. Its blank replaced
// what the hook had recorded on every re-read.
test("a sweep keeps the effort level a hook recorded", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-effort-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "s1.jsonl");
  fs.writeFileSync(transcriptPath, "only\n");
  const provider = {
    id: "claude",
    buildTurns: (_, opts) => [{ provider: "claude", sessionId: "s1", id: "a", cwd: dir, ts: "2026-01-01T00:00:00.000Z", effortLevel: opts.effortLevel || null, cost: { total: 1 } }],
  };
  await ingestTranscript(provider, { transcriptPath, opts: { effortLevel: "high" } });
  await ingestTranscript(provider, { transcriptPath, opts: {} });
  assert.equal(rowsIn(dir)[0].effortLevel, "high");
});


test("OpenCode deferred rollup leaves stored turns and completes the read", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-rollup-ingest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = { provider: "opencode", sessionId: "s", id: "s:1", cwd: dir, usage: { input: 100 } };
  let incoming = [record];
  const provider = { id: "opencode", buildTurns: async () => incoming };
  const ref = { transcriptPath: { sessionId: "s" }, cwd: dir, sessionId: "s" };
  await ingestTranscript(provider, ref);
  incoming = [{ ...record, id: "s:0", quality: "session-rollup" }];
  assert.equal(await ingestTranscript(provider, ref), 0, "nothing written, nothing thrown");
  assert.deepEqual(rowsIn(dir).map((r) => r.id), ["s:1"]);
});
