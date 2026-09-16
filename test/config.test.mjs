import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { FIELD_GROUPS, applyFieldSelection, preserveStoredFields } from "../src/lib/config.mjs";

const allOn = () => Object.fromEntries(FIELD_GROUPS.map((g) => [g, true]));

test("disabled counts strip and restore each run by agent identity", () => {
  const old = { counts: { apiCalls: 3 }, subagents: [
    { agentId: "a", counts: { apiCalls: 2 }, subagents: [{ agentId: "b", counts: { apiCalls: 1 } }] },
  ] };
  const next = structuredClone(old);
  next.subagents[0].counts.apiCalls = 99;
  const slim = applyFieldSelection(next, { counts: false });
  assert.equal(slim.subagents[0].counts, undefined);
  assert.equal(slim.subagents[0].subagents[0].counts, undefined);
  assert.deepEqual(preserveStoredFields(slim, old, { counts: false }), old);
});
const run = (agentId, extra = {}) => ({
  agentId,
  description: "scan files",
  usage: { input: 1 },
  cost: { total: 1 },
  durationMs: 5,
  endTs: "2026-01-01T00:00:05.000Z",
  subagents: [],
  ...extra,
});

// A subagent run carries its own tokens, cost, description and timing. Turning a
// group off stripped the turn's copy while every run kept its own.
test("a field group turned off also reaches inside the subagent tree", () => {
  const fields = { ...allOn(), tokens: false, text: false };
  const record = { id: "a", usage: { input: 3 }, prompt: "p", subagents: [run("a1", { subagents: [run("a2")] })] };
  const out = applyFieldSelection(record, fields);
  assert.equal(out.usage, undefined);
  assert.equal(out.subagents[0].usage, undefined);
  assert.equal(out.subagents[0].description, undefined);
  assert.equal(out.subagents[0].subagents[0].usage, undefined, "at every depth");
  assert.equal(out.subagents[0].cost.total, 1, "groups still on are kept");
  assert.equal(record.subagents[0].usage.input, 1, "the input record is left untouched");
});

test("what a run recorded before a group was turned off is kept", () => {
  const fields = { ...allOn(), tokens: false };
  const previous = { id: "a", subagents: [run("a1", { subagents: [run("a2", { usage: { input: 9 } })] })] };
  const next = applyFieldSelection({ id: "a", subagents: [run("a1", { subagents: [run("a2")] })] }, fields);
  const out = preserveStoredFields(next, previous, fields);
  assert.equal(out.subagents[0].subagents[0].usage.input, 9);
});

test("turning the subagents group off keeps the tree already stored", () => {
  const fields = { ...allOn(), subagents: false };
  const previous = { id: "a", subagents: [run("a1")] };
  const next = applyFieldSelection({ id: "a", subagents: [run("a1"), run("a2")] }, fields);
  assert.equal(next.subagents, undefined);
  assert.deepEqual(preserveStoredFields(next, previous, fields).subagents, previous.subagents);
});
