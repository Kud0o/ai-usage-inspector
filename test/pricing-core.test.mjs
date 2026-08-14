import assert from "node:assert/strict";
import test from "node:test";
import { M, addCost, zeroCost } from "../src/lib/pricing-core.mjs";

const cost = (n, extra = {}) => ({ input: n, output: n, cacheRead: n, cacheWrite: n, total: n * 4, ...extra });

test("M is the per-million-token divisor every provider prices against", () => {
  assert.equal(M, 1_000_000);
});

test("zeroCost is a fresh, fully-zeroed cost object each call", () => {
  assert.deepEqual(zeroCost(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  const a = zeroCost();
  a.total = 5;
  assert.equal(zeroCost().total, 0, "must not hand back a shared object");
});

test("addCost sums every component", () => {
  assert.deepEqual(addCost(cost(1), cost(2)), {
    input: 3, output: 3, cacheRead: 3, cacheWrite: 3, total: 12,
  });
});

test("addCost adds nothing when one side is zero", () => {
  assert.deepEqual(addCost(zeroCost(), cost(2)), {
    input: 2, output: 2, cacheRead: 2, cacheWrite: 2, total: 8,
  });
});

test("no provenance in, no provenance out", () => {
  const sum = addCost(cost(1), cost(1));
  assert.equal("source" in sum, false);
  assert.equal("estimated" in sum, false);
});

test("estimated provenance is contagious from either side", () => {
  // A turn priced partly from real counts and partly from an estimate is an
  // estimate overall — otherwise a guess gets presented as authoritative.
  assert.equal(addCost(cost(1, { source: "priced" }), cost(1, { source: "estimated" })).source, "estimated");
  assert.equal(addCost(cost(1, { source: "estimated" }), cost(1, { source: "priced" })).source, "estimated");
  assert.equal(addCost(cost(1, { source: "estimated" }), cost(1, { source: "provider" })).source, "estimated");
});

test("otherwise the right-hand source wins, and a lone source carries through", () => {
  assert.equal(addCost(cost(1, { source: "priced" }), cost(1, { source: "provider" })).source, "provider");
  assert.equal(addCost(cost(1), cost(1, { source: "priced" })).source, "priced");
  assert.equal(addCost(cost(1, { source: "priced" }), cost(1)).source, "priced");
});

test("the legacy estimated flag survives a merge from either side", () => {
  assert.equal(addCost(cost(1, { estimated: true }), cost(1)).estimated, true);
  assert.equal(addCost(cost(1), cost(1, { estimated: true })).estimated, true);
});

test("addCost does not mutate its operands", () => {
  const a = cost(1, { source: "priced" });
  const b = cost(2, { source: "estimated" });
  const before = [JSON.stringify(a), JSON.stringify(b)];
  addCost(a, b);
  assert.deepEqual([JSON.stringify(a), JSON.stringify(b)], before);
});

test("summing many messages accumulates like a turn does", () => {
  // Mirrors the Claude parser: fold each message's cost into the turn total.
  let total = zeroCost();
  for (let i = 0; i < 4; i++) total = addCost(total, cost(1, { source: "priced" }));
  assert.equal(total.total, 16);
  assert.equal(total.input, 4);
  assert.equal(total.source, "priced");
});
