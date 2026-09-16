import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addTombstones,
  collapseCopies,
  collapseStoredCopies,
  tombstonePath,
  upsertSession,
} from "../src/lib/store.mjs";

// `/branch` and `--fork-session` copy earlier turns into a new session and keep
// each message's uuid. Stored under both sessions, the same work was counted twice.

// Claude turn ids are message uuids; name them readably here and map back.
const uuids = new Map();
const names = new Map();
const u = (name) => {
  if (!uuids.has(name)) {
    const id = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`;
    uuids.set(name, id);
    names.set(id, name);
  }
  return uuids.get(name);
};

const turn = (sessionId, name, ts) => ({
  provider: "claude",
  sessionId,
  id: u(name),
  ts,
  usage: { input: 10, output: 1 },
  cost: { total: 1, source: "priced" },
});

function rows(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function held(file, provider = "claude") {
  const out = {};
  for (const r of rows(file)) if (r.provider === provider) (out[r.sessionId] ||= []).push(names.get(r.id) || r.id);
  for (const ids of Object.values(out)) ids.sort();
  return out;
}

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-branch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "usage.ndjson");
}

async function readAll(file, sessions, order, rounds = 2) {
  for (let i = 0; i < rounds; i++) {
    for (const s of order) await upsertSession(file, s, sessions[s], { transcriptId: s });
  }
}

const branchOf = (file, sessionId) => [...new Set(rows(file).filter((r) => r.sessionId === sessionId).map((r) => r.branchOf))];

// Homes: the original holds nothing but the turns the branch copied; the branch
// then went on on its own.
test("a branch's copied turns stay with the session they came from, in either read order", async (t) => {
  const sessions = {
    O: [turn("O", "t1", "2026-07-18T10:00:00.000Z"), turn("O", "t2", "2026-07-18T11:00:00.000Z")],
    B: [turn("B", "t1", "2026-07-18T10:00:00.000Z"), turn("B", "t2", "2026-07-18T11:00:00.000Z"), turn("B", "b3", "2026-07-21T12:55:00.000Z")],
  };
  for (const order of [["O", "B"], ["B", "O"]]) {
    const file = tempFile(t);
    // A later read of the branch must not be needed to remove copies or name its parent.
    for (let pass = 0; pass < 2; pass++) {
      await readAll(file, sessions, order, 1);
      assert.deepEqual(held(file), { O: ["t1", "t2"], B: ["b3"] }, order.join(" then "));
      assert.deepEqual(branchOf(file, "B"), ["O"]);
      assert.deepEqual(branchOf(file, "O"), [undefined]);
    }
  }
});

// ScentCompination: branched after a compaction, so the branch copied only the
// original's tail.
test("a branch made after a compaction leaves the original whole", async (t) => {
  const sessions = {
    O: [
      turn("O", "x1", "2026-06-21T21:51:00.000Z"),
      turn("O", "x2", "2026-07-01T10:00:00.000Z"),
      turn("O", "s1", "2026-07-20T22:21:00.000Z"),
      turn("O", "s2", "2026-07-20T22:33:00.000Z"),
    ],
    B: [
      turn("B", "s1", "2026-07-20T22:21:00.000Z"),
      turn("B", "s2", "2026-07-20T22:33:00.000Z"),
      turn("B", "b1", "2026-07-20T23:18:00.000Z"),
    ],
  };
  for (const order of [["O", "B"], ["B", "O"]]) {
    const file = tempFile(t);
    await readAll(file, sessions, order);
    assert.deepEqual(held(file), { O: ["s1", "s2", "x1", "x2"], B: ["b1"] }, order.join(" then "));
    assert.deepEqual(branchOf(file, "B"), ["O"]);
  }
});

// Ruqyah: two branches from one session at different points, each continuing
// later than the original did.
const ruqyah = () => {
  const shared = ["2026-06-13T23:45:00.000Z", "2026-06-13T23:50:00.000Z", "2026-06-13T23:55:00.000Z", "2026-06-14T00:00:00.000Z", "2026-06-14T00:05:00.000Z", "2026-06-14T00:10:00.000Z", "2026-06-14T00:15:00.000Z"];
  const upTo = (s, n) => shared.slice(0, n).map((ts, i) => turn(s, `t${i + 1}`, ts));
  return {
    F: [...upTo("F", 7), turn("F", "f8", "2026-06-14T00:20:00.000Z"), turn("F", "f9", "2026-06-15T12:21:00.000Z")],
    A: [...upTo("A", 7), turn("A", "a8", "2026-06-14T04:59:00.000Z")],
    E: [...upTo("E", 2), turn("E", "e3", "2026-06-14T00:29:00.000Z")],
  };
};

test("two branches of one session each count only their own turns, whatever the read order", async (t) => {
  const sessions = ruqyah();
  for (const order of [["F", "A", "E"], ["E", "A", "F"], ["A", "E", "F"]]) {
    const file = tempFile(t);
    await readAll(file, sessions, order);
    assert.deepEqual(held(file), { F: ["f8", "f9", "t1", "t2", "t3", "t4", "t5", "t6", "t7"], A: ["a8"], E: ["e3"] }, order.join(" then "));
    assert.deepEqual(branchOf(file, "A"), ["F"]);
    assert.deepEqual(branchOf(file, "E"), ["F"]);
  }
});

// A fork that went on before its original did: the turns' timing alone reads it
// backwards. The parser's mark on the turns a branch copied settles it.
test("a branch that went on before its original did still leaves the turns with the original", async (t) => {
  const copy = (s, name, ts) => ({ ...turn(s, name, ts), copied: true });
  const sessions = {
    O: [turn("O", "t1", "2026-09-15T12:30:00.000Z"), turn("O", "t2", "2026-09-15T12:35:00.000Z"), turn("O", "o3", "2026-09-15T12:50:00.000Z")],
    B: [copy("B", "t1", "2026-09-15T12:30:00.000Z"), copy("B", "t2", "2026-09-15T12:35:00.000Z"), turn("B", "b3", "2026-09-15T12:42:00.000Z")],
  };
  for (const order of [["O", "B"], ["B", "O"]]) {
    const file = tempFile(t);
    await readAll(file, sessions, order);
    assert.deepEqual(held(file), { O: ["o3", "t1", "t2"], B: ["b3"] }, order.join(" then "));
    assert.deepEqual(branchOf(file, "B"), ["O"]);
    assert.deepEqual(branchOf(file, "O"), [undefined]);
  }
  const { records } = collapseCopies([...sessions.B, ...sessions.O]);
  assert.deepEqual(records.filter((r) => r.sessionId === "B").map((r) => `${names.get(r.id)}<${r.branchOf}`), ["b3<O"], "stored rows settle the same way");
});

test("a turn deleted under the original does not return through a branch", async (t) => {
  const file = tempFile(t);
  const original = [turn("O", "t1", "2026-07-18T10:00:00.000Z"), turn("O", "t2", "2026-07-18T11:00:00.000Z")];
  await upsertSession(file, "O", original, { transcriptId: "O" });
  await addTombstones(tombstonePath(file), [original[0]]);
  await upsertSession(file, "O", original, { transcriptId: "O" });
  await upsertSession(file, "B", [
    turn("B", "t1", "2026-07-18T10:00:00.000Z"),
    turn("B", "t2", "2026-07-18T11:00:00.000Z"),
    turn("B", "b3", "2026-07-21T12:55:00.000Z"),
  ], { transcriptId: "B" });
  assert.deepEqual(held(file), { O: ["t2"], B: ["b3"] });
  assert.deepEqual(branchOf(file, "B"), ["O"]);
});

// Codex child threads repeat turn ids of their parent too, but whether those are
// copies is not settled, so other providers keep every row.
test("only Claude sessions are collapsed", async (t) => {
  const file = tempFile(t);
  const codex = (s, name, ts) => ({ ...turn(s, name, ts), provider: "codex" });
  await upsertSession(file, "P", [codex("P", "t1", "2026-07-18T10:00:00.000Z")], { transcriptId: "P" });
  await upsertSession(file, "C", [codex("C", "t1", "2026-07-18T10:00:00.000Z"), codex("C", "c2", "2026-07-18T12:00:00.000Z")], { transcriptId: "C" });
  assert.deepEqual(held(file, "codex"), { P: ["t1"], C: ["c2", "t1"] });
});

// Fallback ids are built from the session, so two sessions sharing one cannot be
// a branch and its original.
test("turns whose ids are not message uuids are never taken for copies", async (t) => {
  const file = tempFile(t);
  const plain = (s) => ({ ...turn(s, "x", "2026-07-18T10:00:00.000Z"), id: "a" });
  await upsertSession(file, "S1", [plain("S1")], { transcriptId: "S1" });
  await upsertSession(file, "S2", [plain("S2")], { transcriptId: "S2" });
  assert.deepEqual(held(file), { S1: ["a"], S2: ["a"] });
});

// Transcripts Claude Code has deleted are never read again, so copies older
// versions stored under both sessions are settled from the stored rows alone.
test("copies already stored under two sessions collapse to the original, once", async (t) => {
  const file = tempFile(t);
  const stored = [
    turn("O", "t1", "2026-07-18T10:00:00.000Z"),
    turn("O", "t2", "2026-07-18T11:00:00.000Z"),
    turn("B", "t1", "2026-07-18T10:00:00.000Z"),
    turn("B", "t2", "2026-07-18T11:00:00.000Z"),
    turn("B", "b3", "2026-07-21T12:55:00.000Z"),
    { ...turn("O", "t1", "2026-07-18T10:00:00.000Z"), provider: "codex" },
  ];
  fs.writeFileSync(file, stored.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(await collapseStoredCopies(file), 2);
  assert.deepEqual(
    rows(file).filter((r) => r.provider === "claude").map((r) => `${r.sessionId}:${names.get(r.id)}:${r.branchOf || "-"}`),
    ["O:t1:-", "O:t2:-", "B:b3:O"],
  );
  assert.equal(rows(file).filter((r) => r.provider === "codex").length, 1, "other providers are left alone");
  const before = fs.readFileSync(file, "utf8");
  assert.equal(await collapseStoredCopies(file), 0);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a second pass changes nothing");
});

test("stored copies of two branches collapse to the session both came from", () => {
  const sessions = ruqyah();
  const { records, removed } = collapseCopies([...sessions.A, ...sessions.E, ...sessions.F]);
  assert.equal(removed, 9);
  const out = {};
  for (const r of records) (out[r.sessionId] ||= []).push(`${names.get(r.id)}${r.branchOf ? `<${r.branchOf}` : ""}`);
  assert.deepEqual(out.F.sort(), ["f8", "f9", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  assert.deepEqual(out.A, ["a8<F"]);
  assert.deepEqual(out.E, ["e3<F"]);
});

// Upgrading from 2.5.0: the store is full of rows written before any transcript
// carried its first entry. A branch that went on before its original reads
// backwards on timing alone, and a batch skipped on that reading is never
// written, so the repair's own later passes cannot put it back.
test("a session read by this version keeps its turns from rows written before first entries were stored", async (t) => {
  const first = { O: "2026-07-18T09:59:00.000Z", B: "2026-07-21T12:50:00.000Z" };
  const parsed = (s, name, ts) => ({ ...turn(s, name, ts), transcriptFirstTs: first[s] });
  const sessions = {
    // The branch went on first, so timing alone would call it the original.
    O: [parsed("O", "t1", "2026-07-18T10:00:00.000Z"), parsed("O", "t9", "2026-07-25T10:00:00.000Z")],
    B: [parsed("B", "t1", "2026-07-18T10:00:00.000Z"), parsed("B", "b3", "2026-07-21T12:55:00.000Z")],
  };
  for (const order of [["O", "B"], ["B", "O"]]) {
    const file = tempFile(t);
    const legacy = [turn("O", "t1", "2026-07-18T10:00:00.000Z"), turn("O", "t9", "2026-07-25T10:00:00.000Z"),
      turn("B", "t1", "2026-07-18T10:00:00.000Z"), turn("B", "b3", "2026-07-21T12:55:00.000Z")];
    fs.writeFileSync(file, legacy.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await readAll(file, sessions, order, 1);
    assert.deepEqual(held(file), { O: ["t1", "t9"], B: ["b3"] }, `${order.join(" then ")}: one repair pass settles it`);
    assert.deepEqual(branchOf(file, "B"), ["O"]);
  }
});
