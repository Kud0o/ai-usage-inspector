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

// Session ids are only unique within a provider. Replacing on the id alone let
// one provider's upsert delete another's rows — silently, since the write itself
// succeeded. Every other identity check in this file is composite; this one was not.
test("upserting one provider's session leaves another provider's identical id alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-scope-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    await upsertSession(file, "shared-id", [
      { provider: "codex", sessionId: "shared-id", id: "cx-1", cost: { total: 1 } },
    ]);
    await upsertSession(file, "shared-id", [
      { provider: "claude", sessionId: "shared-id", id: "cl-1", cost: { total: 2 } },
    ]);

    const rows = validRecords(file);
    assert.deepEqual(
      rows.map((r) => `${r.provider}:${r.id}`).sort(),
      ["claude:cl-1", "codex:cx-1"],
      "the Codex row must survive a Claude upsert of the same session id",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-upserting the same provider's session still replaces it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-replace-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { total: 1 } },
      { provider: "claude", sessionId: "s1", id: "b", cost: { total: 1 } },
    ]);
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { total: 1 } },
    ]);
    assert.deepEqual(validRecords(file).map((r) => r.id), ["a"], "stale turn b is gone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Legacy rows predate the provider field; tombstoneKey() reads them as "claude",
// so replacement has to agree or old Claude rows become unreplaceable.
test("a provider-less legacy row is replaced by a Claude upsert", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-legacy-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    fs.writeFileSync(file, JSON.stringify({ sessionId: "s1", id: "old", cost: { total: 9 } }) + "\n");
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "new", cost: { total: 1 } },
    ]);
    assert.deepEqual(validRecords(file).map((r) => r.id), ["new"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a batch carrying the same turn twice stores it once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-dupe-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { total: 1 } },
      { provider: "claude", sessionId: "s1", id: "a", cost: { total: 1 } },
    ]);
    assert.equal(validRecords(file).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
