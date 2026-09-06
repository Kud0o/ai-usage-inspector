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

// preserveComputedCost lets NEW PROVENANCE through when the amount is unchanged,
// so a row mislabelled by an older version can be corrected without --reprice.
// The amount itself stays a fact about the day the turn ran; these pin both halves.
test("provenance is corrected when the amount is identical", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-prov-"));
  const file = path.join(dir, "usage.ndjson");
  const amount = { input: 0.01, output: 0.02, cacheWrite: 0, cacheRead: 0, total: 0.03 };
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { ...amount, source: "priced" } },
    ]);
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { ...amount, source: "estimated", estimatedRate: true } },
    ]);
    const [row] = validRecords(file);
    assert.equal(row.cost.source, "estimated", "the label was wrong and is now right");
    assert.equal(row.cost.estimatedRate, true, "and it says which half was the guess");
    assert.equal(row.cost.total, 0.03, "while the amount is untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a different amount is still refused, label and all", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-prov2-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { input: 0.01, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.01, source: "priced" } },
    ]);
    // Today's rates are higher. Re-scanning history must not restate what it cost.
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { input: 0.05, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.05, source: "estimated" } },
    ]);
    const [row] = validRecords(file);
    assert.equal(row.cost.total, 0.01, "the original amount survives");
    assert.equal(row.cost.source, "priced", "and so does the provenance that goes with it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Re-syncing must not make a row flap between labels as the rate cache warms.
test("repeated identical re-syncs leave provenance stable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-prov3-"));
  const file = path.join(dir, "usage.ndjson");
  const rec = (source) => ({
    provider: "claude", sessionId: "s1", id: "a",
    cost: { input: 0.01, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.01, source },
  });
  try {
    await upsertSession(file, "s1", [rec("priced")]);
    for (let i = 0; i < 5; i++) await upsertSession(file, "s1", [rec("priced")]);
    const rows = validRecords(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cost.source, "priced");
    assert.equal(rows[0].cost.total, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the later copy of a duplicated turn wins", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-dupe2-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", prompt: "partial", cost: { total: 1 } },
      { provider: "claude", sessionId: "s1", id: "a", prompt: "complete", cost: { total: 1 } },
    ]);
    const rows = validRecords(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prompt, "complete", "a re-parse appends the fuller record");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// sameAmount decides whether a stored cost may be relabelled. A missing or NaN
// field means we do not know the amounts match, so it must refuse.
test("a malformed cost is not treated as an equal amount", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-nan-"));
  const file = path.join(dir, "usage.ndjson");
  const good = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.01, source: "priced" };
  try {
    await upsertSession(file, "s1", [{ provider: "claude", sessionId: "s1", id: "a", cost: good }]);
    // Same numbers except total is absent — previously coerced to 0 on both sides
    // for the missing field and accepted as "identical".
    await upsertSession(file, "s1", [{
      provider: "claude", sessionId: "s1", id: "a",
      cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, source: "estimated" },
    }]);
    const [row] = validRecords(file);
    assert.equal(row.cost.source, "priced", "an unknown amount cannot license a relabel");
    assert.equal(row.cost.total, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Correction is one-way. As the rate cache warms and cools, the same amount can
// arrive from a looked-up rate one day and a fallback the next; accepting
// whichever label came last makes the ≈ marker flicker between syncs.
test("provenance never travels back from estimated to priced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-mono-"));
  const file = path.join(dir, "usage.ndjson");
  const amount = { input: 0.01, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.01 };
  const write = (source) => upsertSession(file, "s1", [
    { provider: "claude", sessionId: "s1", id: "a", cost: { ...amount, source } },
  ]);
  try {
    await write("priced");
    await write("estimated");
    assert.equal(validRecords(file)[0].cost.source, "estimated", "corrected toward caution");
    await write("priced");
    assert.equal(validRecords(file)[0].cost.source, "estimated", "and it stays there");
    await write("priced");
    assert.equal(validRecords(file)[0].cost.source, "estimated", "no flapping across syncs");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A row written when the identity fallback produced "undefined:<ts>" has no
// session to match on, so scoped replacement would leave it beside its own
// corrected row and double-count the turn.
test("a session-less legacy row is replaced, not duplicated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-orphan-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    const ts = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(file, JSON.stringify({
      provider: "claude", id: `undefined:${ts}`, ts,
      cost: { total: 1, source: "priced" },
    }) + "\n");
    await upsertSession(file, "sess-from-filename", [{
      provider: "claude", sessionId: "sess-from-filename", ts,
      id: `sess-from-filename:${ts}:0`, legacyId: `undefined:${ts}`,
      cost: { total: 1, source: "priced" },
    }]);
    const rows = validRecords(file);
    assert.equal(rows.length, 1, "the orphan is gone, not sitting beside its replacement");
    assert.equal(rows[0].sessionId, "sess-from-filename");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The orphan rule must identify ONE turn, not a shape. Matching the "undefined:"
// prefix alone meant any write deleted every unrelated sessionless row in the file.
test("replacing one orphan leaves other orphans alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-orphan2-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    const mine = "2026-01-01T00:00:00.000Z";
    const theirs = "2026-02-02T00:00:00.000Z";
    fs.writeFileSync(file, [
      JSON.stringify({ provider: "claude", id: `undefined:${mine}`, ts: mine, cost: { total: 1 } }),
      JSON.stringify({ provider: "claude", id: `undefined:${theirs}`, ts: theirs, cost: { total: 2 } }),
    ].join("\n") + "\n");

    await upsertSession(file, "s-new", [
      { provider: "claude", sessionId: "s-new", ts: mine, id: `s-new:${mine}:0`, legacyId: `undefined:${mine}`, cost: { total: 1 } },
    ]);

    const rows = validRecords(file);
    assert.equal(rows.length, 2, "one orphan replaced, one untouched");
    assert.ok(rows.some((r) => r.id === `undefined:${theirs}`), "the unrelated orphan survives");
    assert.ok(rows.some((r) => r.id === `s-new:${mine}:0`), "the matching turn was replaced");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Automatic correction is one-way, so a row can stay estimated after the real
// rate becomes known. --reprice would fix the label but only by restating the
// amount at today's rates; --relabel is the escape hatch that does not.
test("--relabel takes new provenance and leaves the amount alone", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-relabel-"));
  const file = path.join(dir, "usage.ndjson");
  const saved = process.env.AI_USAGE_RELABEL;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_RELABEL;
    else process.env.AI_USAGE_RELABEL = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const amount = { input: 0.01, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.01 };
  const write = (source) => upsertSession(file, "s1", [
    { provider: "claude", sessionId: "s1", id: "a", cost: { ...amount, source } },
  ]);
  try {
    await write("estimated");
    await write("priced");
    assert.equal(validRecords(file)[0].cost.source, "estimated", "a normal sync will not walk it back");

    process.env.AI_USAGE_RELABEL = "1";
    await write("priced");
    const [row] = validRecords(file);
    assert.equal(row.cost.source, "priced", "asked for explicitly, the label is corrected");
    assert.equal(row.cost.total, 0.01, "and the amount is still what the turn cost");
  } finally {
    delete process.env.AI_USAGE_RELABEL;
  }
});

// --relabel must not become a back door for changing what a turn cost.
test("--relabel still refuses a different amount", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-relabel2-"));
  const file = path.join(dir, "usage.ndjson");
  const saved = process.env.AI_USAGE_RELABEL;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_RELABEL;
    else process.env.AI_USAGE_RELABEL = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { input: 0.01, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.01, source: "estimated" } },
    ]);
    process.env.AI_USAGE_RELABEL = "1";
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { input: 0.09, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.09, source: "priced" } },
    ]);
    const [row] = validRecords(file);
    assert.equal(row.cost.total, 0.01, "the amount is preserved; --reprice is the tool for that");
    assert.equal(row.cost.source, "estimated");
  } finally {
    delete process.env.AI_USAGE_RELABEL;
  }
});

// Turning a field group off means "stop recording this", not "delete what is
// already recorded". Without this, any later reparse of the session — a following
// turn, or a sweep — rewrote its rows with the group stripped, so collected
// history vanished as a side effect of a settings change.
test("a field turned off does not erase what is already stored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-fields-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", prompt: "already collected", cost: { total: 1 } },
    ]);
    // The reparse arrives stripped, as applyFieldSelection would deliver it.
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", cost: { total: 1 } },
    ], {
      preserveFields: (r, prior) => (prior && r.prompt === undefined && prior.prompt !== undefined
        ? { ...r, prompt: prior.prompt }
        : r),
    });
    assert.equal(validRecords(file)[0].prompt, "already collected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn that never had the field does not gain one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-fields2-"));
  const file = path.join(dir, "usage.ndjson");
  try {
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", prompt: "old turn", cost: { total: 1 } },
    ]);
    await upsertSession(file, "s1", [
      { provider: "claude", sessionId: "s1", id: "a", prompt: "old turn", cost: { total: 1 } },
      { provider: "claude", sessionId: "s1", id: "b", cost: { total: 1 } },
    ], {
      preserveFields: (r, prior) => (prior && r.prompt === undefined && prior.prompt !== undefined
        ? { ...r, prompt: prior.prompt }
        : r),
    });
    const rows = validRecords(file);
    assert.equal(rows.find((r) => r.id === "a").prompt, "old turn");
    assert.equal(rows.find((r) => r.id === "b").prompt, undefined, "new turn stays stripped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
