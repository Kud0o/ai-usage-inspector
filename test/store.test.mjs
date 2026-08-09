import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addTombstones,
  tombstonePath,
  upsertSession,
  withFileLock,
} from "../src/lib/store.mjs";

function validRecords(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

test("store uses unique temps, serializes concurrent upserts, and preserves malformed lines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-store-"));
  const file = path.join(dir, "usage.ndjson");
  const fixedTmp = `${file}.tmp`;
  const malformed = "  {not-json   ";
  fs.writeFileSync(file, `${JSON.stringify({ provider: "claude", sessionId: "old", id: "old:0" })}\n${malformed}\n`);
  fs.writeFileSync(fixedTmp, "sentinel");
  try {
    await Promise.all([
      upsertSession(file, "a", [{ provider: "claude", sessionId: "a", id: "a:0" }]),
      upsertSession(file, "b", [{ provider: "codex", sessionId: "b", id: "b:0" }]),
    ]);
    assert.equal(fs.readFileSync(fixedTmp, "utf8"), "sentinel");
    assert.equal(fs.readFileSync(file, "utf8").includes(`${malformed}\n`), true);
    assert.deepEqual(validRecords(file).map((r) => r.sessionId).sort(), ["a", "b", "old"]);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp") && name !== path.basename(fixedTmp)),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("owner-token cleanup does not unlink a replacement lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-lock-"));
  const file = path.join(dir, "guard");
  const lock = `${file}.lock`;
  try {
    await withFileLock(file, () => {
      fs.rmSync(lock, { force: true });
      fs.writeFileSync(lock, "replacement-owner");
    });
    assert.equal(fs.readFileSync(lock, "utf8"), "replacement-owner");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale owner-token lock is stolen after age check", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-stale-lock-"));
  const file = path.join(dir, "guard");
  const lock = `${file}.lock`;
  try {
    fs.writeFileSync(lock, "crashed-owner");
    const stale = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, stale, stale);
    assert.equal(await withFileLock(file, () => "acquired"), "acquired");
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("composite tombstone survives re-upsert and deduplicates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-tombstone-"));
  const file = path.join(dir, "usage.ndjson");
  const record = { provider: "codex", sessionId: "s1", id: "turn-1", schema: 2 };
  try {
    assert.equal(await upsertSession(file, "s1", [record]), 1);
    assert.equal(await addTombstones(tombstonePath(file), [record]), 1);
    assert.equal(await addTombstones(tombstonePath(file), [record]), 0);
    assert.equal(await upsertSession(file, "s1", [record]), 0);
    assert.deepEqual(validRecords(file), []);
    const saved = JSON.parse(fs.readFileSync(tombstonePath(file), "utf8"));
    assert.equal(saved.entries.length, 1);
    assert.deepEqual(
      [saved.entries[0].provider, saved.entries[0].sessionId, saved.entries[0].id],
      ["codex", "s1", "turn-1"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
