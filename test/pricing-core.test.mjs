import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseModelsDev, readCachedRates, CACHE_SCHEMA } from "../src/providers/codex/remote-pricing.mjs";
import { applyRemoteRates, costOf as codexCostOf } from "../src/providers/codex/pricing.mjs";
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

// The 10% cache-rate guess is made inside the remote PARSER, not in
// applyRemoteRates. A test that calls applyRemoteRates directly will therefore
// pass while production still labels the guess "priced" — so drive the real
// parser path here.
test("a model with no published cache rate is priced as an estimate", () => {
  const rates = parseModelsDev({
    openai: {
      models: {
        "has-cache-rate": { cost: { input: 2, output: 10, cache_read: 0.25 } },
        "no-cache-rate": { cost: { input: 2, output: 10 } },
      },
    },
  });
  assert.equal(rates["has-cache-rate"].cachedGuessed, false);
  assert.equal(rates["no-cache-rate"].cachedGuessed, true, "the parser records that it guessed");

  applyRemoteRates(rates);

  const known = codexCostOf("has-cache-rate", { input: 0, cached: 1_000_000, output: 0 });
  assert.equal(known.source, "priced");
  assert.equal(known.cacheRead, 0.25);

  const guessed = codexCostOf("no-cache-rate", { input: 0, cached: 1_000_000, output: 0 });
  assert.equal(guessed.source, "estimated", "the cache rate was invented, so the cost is an estimate");
  assert.equal(guessed.estimatedRate, true);
  assert.equal(guessed.cacheRead, 0.2, "still charged at the 10% guess");
});

// A turn that never touched the cache is unaffected by a guessed cache rate.
test("a guessed cache rate does not taint a turn with no cached tokens", () => {
  applyRemoteRates(parseModelsDev({
    openai: { models: { "no-cache-rate-2": { cost: { input: 2, output: 10 } } } },
  }));
  const c = codexCostOf("no-cache-rate-2", { input: 1_000_000, cached: 0, output: 0 });
  assert.equal(c.source, "priced", "nothing about this number was guessed");
  assert.equal(c.estimatedRate, undefined);
});

// Caches written before the file recorded WHICH rates were guessed cannot be
// interpreted: a published rate that happens to be a tenth of the input rate is
// indistinguishable from this tool's own synthesis. Such a file is treated as
// absent so the built-in table prices until the next refresh.
test("a pre-v2 pricing cache is ignored rather than guessed at", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pricing-codex.json");
  const rates = { "some-model": { input: 5, cachedInput: 0.5, output: 30 } };

  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), rates }));
  assert.equal(readCachedRates(file), null, "no schema: unusable, not reinterpreted");

  fs.writeFileSync(file, JSON.stringify({ schema: 1, fetchedAt: Date.now(), rates }));
  assert.equal(readCachedRates(file), null, "schema 1 predates the marker");

  fs.writeFileSync(file, JSON.stringify({
    schema: CACHE_SCHEMA, fetchedAt: Date.now(),
    rates: { "some-model": { input: 5, cachedInput: 0.5, output: 30, cachedGuessed: false } },
  }));
  const current = readCachedRates(file);
  assert.equal(current["some-model"].cachedGuessed, false, "a current cache says what it knows");
});
