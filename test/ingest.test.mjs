import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestTranscript } from "../src/lib/ingest.mjs";

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
    (err) => err && err.scanStatus === "locked",
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
    (err) => err && err.scanStatus === "locked",
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
    (err) => err && err.scanStatus === "locked",
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
