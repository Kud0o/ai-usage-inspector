import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ABORT,
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

test("unchanged usage preserves computed turn and recursive run costs by agent identity", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-run-cost-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.ndjson");
  const run = (agentId, total, subagents = []) => ({ agentId, usage: { input: 10 }, cost: { total, source: "priced" }, subagents });
  const old = { provider: "claude", sessionId: "s", id: "x", usage: { input: 100 }, cost: { total: 1, source: "priced" },
    subagents: [run("a", .2, [run("nested", .1)]), run("b", .3)] };
  await upsertSession(file, "s", [old]);
  const fresh = structuredClone(old);
  fresh.cost.total = 10;
  fresh.subagents = [run("b", 3), run("a", 2, [run("nested", 1)]), run("new", 4)];
  await upsertSession(file, "s", [fresh]);
  const saved = validRecords(file)[0];
  assert.equal(saved.cost.total, 1);
  assert.deepEqual(saved.subagents.map((r) => r.cost.total), [.3, .2, 4]);
  assert.equal(saved.subagents[1].subagents[0].cost.total, .1);
  fresh.usage.input++;
  await upsertSession(file, "s", [fresh]);
  assert.deepEqual(validRecords(file)[0].subagents, fresh.subagents);
});

test("relabeling an unchanged turn amount also preserves its runs' recorded costs", async (t) => {
  const file = usageFile(t);
  const cost = { input: 1, output: 0, cacheWrite: 0, cacheRead: 0, total: 1, source: "priced" };
  const old = { provider: "claude", sessionId: "s", id: "x", usage: { input: 10 }, cost,
    subagents: [{ agentId: "a", usage: { input: 5 }, cost: { total: .2, source: "priced" } }] };
  await upsertSession(file, "s", [old]);
  const fresh = structuredClone(old);
  fresh.cost.source = "estimated";
  fresh.subagents[0].cost.total = 2;
  await upsertSession(file, "s", [fresh]);
  assert.equal(validRecords(file)[0].cost.source, "estimated");
  assert.equal(validRecords(file)[0].subagents[0].cost.total, .2);
});

test("an unmarked early fork never displaces the richer shared turn in either read order or collapse", async (t) => {
  const { collapseStoredCopies } = await import("../src/lib/store.mjs");
  const { buildTurns } = await import("../src/providers/claude/transcript.mjs");
  const file = usageFile(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const stamp = (seconds) => `2026-07-01T10:00:${seconds}.000Z`;
  const prompt = (sessionId, n, seconds) => ({ type: "user", sessionId, uuid: id(n), promptId: "p" + n,
    timestamp: stamp(seconds), message: { content: "prompt" } });
  const assistant = (input) => ({ type: "assistant", timestamp: stamp("01"),
    message: { id: "m", model: "claude-sonnet-4-5", content: [{ type: "text", text: "answer" }], usage: { input_tokens: input } } });
  const write = (target, rows) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rows.map(JSON.stringify).join("\n") + "\n");
  };
  const originalFile = path.join(path.dirname(file), "O.jsonl");
  const branchFile = path.join(path.dirname(file), "B.jsonl");
  write(originalFile, [prompt("O", 1, "00"), assistant(10), prompt("O", 3, "40")]);
  write(branchFile, [{ type: "system", timestamp: stamp("20") }, prompt("B", 1, "00"), assistant(10), prompt("B", 2, "30")]);
  write(path.join(path.dirname(file), "O", "subagents", "agent-a.jsonl"), [
    { type: "user", promptId: "p1", isSidechain: true, timestamp: stamp("02"), message: { content: "work" } }, assistant(90),
  ]);
  const original = buildTurns(originalFile), branch = buildTurns(branchFile);
  assert.equal(original[0].subagents.length, 1);
  assert.equal(branch[0].copied, undefined, "a fork within sixty seconds is unmarked");
  for (const batches of [[original, branch], [branch, original]]) {
    fs.writeFileSync(file, "");
    for (const batch of batches) await upsertSession(file, batch[0].sessionId, batch);
    const shared = validRecords(file).filter((r) => r.id === id(1));
    assert.equal(shared.length, 1);
    assert.equal(shared[0].usage.input, 100);
    write(file, batches.flat());
    await collapseStoredCopies(file);
    assert.equal(validRecords(file).filter((r) => r.id === id(1)).length, 1);
    assert.equal(validRecords(file).find((r) => r.id === id(1)).usage.input, 100);
  }
});

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

// ---------------------------------------------------------------------------
// Transcript-scoped replacement. Codex continues a reverted thread in a new
// rollout under the same thread id, so one session can have two transcripts, and
// reading one must not delete the turns the other wrote.

function usageFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-transcripts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "usage.ndjson");
}

const codexTurn = (id, extra = {}) => ({
  provider: "codex", sessionId: "t1", id, usage: { input: 10 }, cost: { total: 1, source: "priced" }, ...extra,
});

test("two transcripts of one session keep their own turns", async (t) => {
  const file = usageFile(t);
  await upsertSession(file, "t1", [codexTurn("a1"), codexTurn("a2")], { transcriptId: "t1" });
  await upsertSession(file, "t1", [codexTurn("b1")], { transcriptId: "r2" });
  assert.deepEqual(
    validRecords(file).map((r) => `${r.transcriptId}/${r.id}`).sort(),
    ["r2/b1", "t1/a1", "t1/a2"],
  );
});

test("re-reading a transcript drops a turn that left it, and only its own", async (t) => {
  const file = usageFile(t);
  await upsertSession(file, "t1", [codexTurn("a1"), codexTurn("a2")], { transcriptId: "t1" });
  await upsertSession(file, "t1", [codexTurn("b1")], { transcriptId: "r2" });
  await upsertSession(file, "t1", [codexTurn("a1")], { transcriptId: "t1" });
  assert.deepEqual(validRecords(file).map((r) => r.id).sort(), ["a1", "b1"]);
});

// Rows written before rows named their transcript can carry ids today's parser no
// longer produces. The transcript that owns the session must still clear them.
test("the session's own transcript replaces rows stored before transcripts were named", async (t) => {
  const file = usageFile(t);
  fs.writeFileSync(file, [codexTurn("t1:0"), codexTurn("t1:1")].map((r) => JSON.stringify(r)).join("\n") + "\n");
  await upsertSession(file, "t1", [codexTurn("0190aaaa-0000-7000-8000-000000000001")], { transcriptId: "t1" });
  assert.deepEqual(validRecords(file).map((r) => r.id), ["0190aaaa-0000-7000-8000-000000000001"]);
});

test("a continuation keeps older rows, except the turn it renames", async (t) => {
  const file = usageFile(t);
  fs.writeFileSync(file, [codexTurn("original-turn"), codexTurn("t1:0")].map((r) => JSON.stringify(r)).join("\n") + "\n");
  await upsertSession(file, "t1", [codexTurn("t1:0@r2", { legacyId: "t1:0" })], { transcriptId: "r2" });
  assert.deepEqual(validRecords(file).map((r) => r.id).sort(), ["original-turn", "t1:0@r2"]);
});

test("a turn claimed by an old position-based name inherits nothing from that row", async (t) => {
  const file = usageFile(t);
  // The stored t1:0 may be the ORIGINAL file's turn: the name alone cannot say.
  fs.writeFileSync(file, JSON.stringify(codexTurn("t1:0", { prompt: "original", cost: { total: 1.23, source: "priced" } })) + "\n");
  const keepText = (r, prior) => (prior && r.prompt === undefined && prior.prompt !== undefined ? { ...r, prompt: prior.prompt } : r);
  await upsertSession(file, "t1", [
    codexTurn("t1:0@r2", { legacyId: "t1:0", cost: { total: 9.99, source: "priced" } }),
  ], { transcriptId: "r2", preserveFields: keepText });
  const [row] = validRecords(file);
  assert.equal(row.id, "t1:0@r2");
  assert.equal(row.prompt, undefined, "no text from a row that may be another turn");
  assert.equal(row.cost.total, 9.99, "and no cost from it either");
});

test("a copy with less work cannot replace another transcript's turn; one with more can", async (t) => {
  const file = usageFile(t);
  await upsertSession(file, "t1", [codexTurn("u1", { usage: { input: 500 } })], { transcriptId: "t1" });
  await upsertSession(file, "t1", [codexTurn("u1", { usage: { input: 0 } })], { transcriptId: "r2" });
  let rows = validRecords(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.input, 500);
  assert.equal(rows[0].transcriptId, "t1");

  await upsertSession(file, "t1", [codexTurn("u1", { usage: { input: 900 } })], { transcriptId: "r2" });
  rows = validRecords(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.input, 900);
  assert.equal(rows[0].transcriptId, "r2");
});

// After /compact, Claude Code writes earlier prompts again. A replay reaching the
// store must not displace the turn that holds the work.
test("within a batch, the copy carrying tokens beats a later empty copy", async (t) => {
  const file = usageFile(t);
  await upsertSession(file, "s1", [
    { provider: "claude", sessionId: "s1", id: "u1", usage: { input: 1200, output: 30 }, cost: { total: 2, source: "priced" } },
    { provider: "claude", sessionId: "s1", id: "u1", usage: { input: 0, output: 0 }, cost: { total: 0, source: "priced" } },
  ]);
  const rows = validRecords(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.input, 1200);
});

test("deleting a turn does not hide a later transcript's turn at the same position", async (t) => {
  const file = usageFile(t);
  await addTombstones(tombstonePath(file), [{ provider: "codex", sessionId: "t1", id: "t1:0" }]);
  await upsertSession(file, "t1", [codexTurn("t1:0@r2", { legacyId: "t1:0" })], { transcriptId: "r2" });
  await upsertSession(file, "t1", [codexTurn("t1:0@r3", { legacyId: "t1:0" })], { transcriptId: "r3" });
  assert.deepEqual(validRecords(file).map((r) => r.id).sort(), ["t1:0@r2", "t1:0@r3"]);
});

test("a deleted turn stays deleted when its own transcript is read again", async (t) => {
  const file = usageFile(t);
  await addTombstones(tombstonePath(file), [{ provider: "codex", sessionId: "t1", id: "t1:0@r2" }]);
  await upsertSession(file, "t1", [codexTurn("t1:0@r2", { legacyId: "t1:0" })], { transcriptId: "r2" });
  assert.deepEqual(validRecords(file), []);
});

// Cursor, OpenCode and the Cline family keep one source per session and name no
// transcript; their batches must go on replacing the whole session.
test("a batch that names no transcript still replaces the whole session", async (t) => {
  const file = usageFile(t);
  await upsertSession(file, "t1", [codexTurn("a1")], { transcriptId: "t1" });
  await upsertSession(file, "t1", [codexTurn("b1")], { transcriptId: "r2" });
  await upsertSession(file, "t1", [codexTurn("c1")]);
  assert.deepEqual(validRecords(file).map((r) => r.id), ["c1"]);
});


test("OpenCode rollup after per-turn rows aborts even with a tombstoned first turn", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-rollup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.ndjson");
  const row = (id, extra = {}) => ({ provider: "opencode", sessionId: "s", id, usage: { input: 100 }, cost: { total: 1, source: "provider" }, ...extra });
  const first = row("s:0"), survivor = row("s:1");
  await upsertSession(file, "s", [first, survivor]);
  await addTombstones(tombstonePath(file), [first]);
  await upsertSession(file, "s", [first, survivor]);
  assert.deepEqual(validRecords(file).map((r) => r.id), ["s:1"]);
  const before = fs.readFileSync(file);
  assert.equal(await upsertSession(file, "s", [row("s:0", { quality: "session-rollup" })]), ABORT);
  assert.deepEqual(fs.readFileSync(file), before, "aborted replacement is byte-for-byte unchanged");
  await upsertSession(file, "s", [first, survivor, row("s:2")]);
  assert.deepEqual(validRecords(file).map((r) => r.id), ["s:1", "s:2"], "a complete read resumes while honoring deletion");
});

test("OpenCode rollup-only sessions update and the abort is provider and session scoped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-rollup-scope-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.ndjson");
  const row = (provider, sessionId, quality, input) => ({ provider, sessionId, id: `${sessionId}:0`, quality, usage: { input } });
  await upsertSession(file, "other", [row("opencode", "other", undefined, 5)]);
  await upsertSession(file, "s", [row("claude", "s", undefined, 6)]);
  await upsertSession(file, "s", [row("opencode", "s", "session-rollup", 10)]);
  assert.equal(await upsertSession(file, "s", [row("opencode", "s", "session-rollup", 20)]), 1);
  assert.equal(validRecords(file).find((r) => r.provider === "opencode" && r.sessionId === "s").usage.input, 20);
  assert.equal(await upsertSession(file, "s", [row("claude", "s", "session-rollup", 30)]), 1);
});
