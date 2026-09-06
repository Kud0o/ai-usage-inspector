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
