import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRemoteRates, costOf, contextMax, modelInfo, RATES_REVISION } from "../src/providers/claude/pricing.mjs";
import {
  parseModelsMarkdown,
  parsePricingMarkdown,
  readCachedRates,
  readCachedWindows,
  refreshPricing,
} from "../src/providers/claude/remote-pricing.mjs";
import { upsertSession } from "../src/lib/store.mjs";

// Rows as Anthropic's pricing page renders them, including the footnote marker
// and the batch table below that must not override the first table.
const PRICING_PAGE = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |

| Model | Batch input | Batch output |
| :---- | :---------- | :----------- |
| Claude Fable 5.1 | $5 / MTok | $25 / MTok |
`;

// The models overview runs one model per column.
const MODELS_PAGE = `
| Feature | Claude Fable 5.1 | Claude Opus 5 | Claude Sonnet 5 | Claude Haiku 4.5 |
| :------ | :--------------- | :------------ | :-------------- | :--------------- |
| Claude API ID | \`claude-fable-5-1\` | \`claude-opus-5\` | \`claude-sonnet-5\` | \`claude-haiku-4-5-20251001\` |
| [Context window](https://platform.claude.com/docs/en/build-with-claude/context-windows) | 1M tokens | 1M tokens | 1M tokens | 200K tokens |
| Max output | 128K tokens | 128K tokens | 128K tokens | 64K tokens |
`;

const M = 1_000_000;

test("the built-in table knows the current models, their 1M windows and Fable 5.1's cache price", () => {
  assert.equal(contextMax("claude-opus-5"), M);
  assert.equal(contextMax("claude-sonnet-5"), M);
  assert.equal(contextMax("claude-fable-5-1"), M);
  assert.equal(contextMax("claude-mythos-5-1"), M);
  assert.equal(modelInfo("claude-sonnet-5").input, 2);
  assert.equal(modelInfo("claude-sonnet-5").output, 10);
  assert.equal(modelInfo("claude-opus-5").estimated, undefined, "no longer a guess");
  // A million cache-read tokens: 0.025x input on Fable 5.1, the usual 0.1x elsewhere.
  assert.equal(costOf("claude-fable-5-1", { cache_read_input_tokens: M }).cacheRead, 0.25);
  assert.equal(costOf("claude-opus-5", { cache_read_input_tokens: M }).cacheRead, 0.5);
});

test("a cost names the rate revision it was worked out under, and the correction its model had", () => {
  const fable = costOf("claude-fable-5-1", { input_tokens: 10 });
  assert.equal(fable.rates, RATES_REVISION);
  assert.equal(fable.supersedes, 2);
  const haiku = costOf("claude-haiku-4-5-20251001", { input_tokens: 10 });
  assert.equal(haiku.rates, RATES_REVISION);
  assert.equal(haiku.supersedes, undefined, "a model whose rates were always right corrects nothing");
});

test("the pricing page yields every price column, and a later table cannot override the first", () => {
  const rates = parsePricingMarkdown(PRICING_PAGE);
  assert.deepEqual(rates["claude-fable-5-1"], { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 });
  assert.deepEqual(rates["claude-sonnet-5"], { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 });
});

test("the models page yields each model's window, keyed without a date snapshot", () => {
  assert.deepEqual(parseModelsMarkdown(MODELS_PAGE), {
    "claude-fable-5-1": M,
    "claude-opus-5": M,
    "claude-sonnet-5": M,
    "claude-haiku-4-5": 200_000,
  });
  assert.deepEqual(parseModelsMarkdown("| Context window | 1M tokens |"), {}, "a window with no id row is not attributed");
});

test("a model released after this version gets its window and rates from the docs", () => {
  assert.equal(modelInfo("claude-opus-7").estimated, true, "unknown before anything is fetched");
  applyRemoteRates({ "claude-opus-7": { input: 6, output: 30 } }, { "claude-opus-7": M });
  assert.equal(contextMax("claude-opus-7"), M);
  assert.equal(modelInfo("claude-opus-7").input, 6);
  assert.equal(modelInfo("claude-opus-7").estimated, undefined);

  // A window with no price yet: still a guessed rate, but no longer a guessed window.
  applyRemoteRates(null, { "claude-sonnet-7": M });
  assert.equal(contextMax("claude-sonnet-7"), M);
  assert.equal(modelInfo("claude-sonnet-7").estimated, true);
});

test("a cache written before cache prices were fetched keeps Fable 5.1's cache hits at 0.025x", () => {
  // Older caches carried input and output only.
  applyRemoteRates({ "claude-fable-5-1": { input: 10, output: 50 } }, null);
  assert.equal(modelInfo("claude-fable-5-1").cacheRead, 0.25);
  assert.equal(contextMax("claude-fable-5-1"), M, "and its window is not lost either");
});

function fakeFetch(pages, calls = []) {
  return async (url) => {
    calls.push(url);
    const body = pages[url];
    if (body instanceof Error) throw body;
    if (body == null) return { ok: false, status: 404, headers: { get: () => null }, text: async () => "" };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  };
}

test("a refresh caches rates with their cache prices and every model's window", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-rates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pricing-claude.json");
  const result = await refreshPricing({
    file, url: "pricing", modelsUrl: "models", ttlMs: 0,
    fetchImpl: fakeFetch({ pricing: PRICING_PAGE, models: MODELS_PAGE }),
  });
  assert.equal(result.status, "updated");
  assert.equal(readCachedRates(file)["claude-fable-5-1"].cacheRead, 0.25);
  assert.equal(readCachedWindows(file)["claude-opus-5"], M);
});

test("a models page that cannot be read never holds back a rate refresh, nor loses known windows", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-rates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pricing-claude.json");
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1, rates: { "claude-opus-5": { input: 5, output: 25 } }, windows: { "claude-opus-5": M } }));
  const result = await refreshPricing({
    file, url: "pricing", modelsUrl: "models", ttlMs: 0,
    fetchImpl: fakeFetch({ pricing: PRICING_PAGE, models: new Error("offline") }),
  });
  assert.equal(result.status, "updated");
  assert.equal(readCachedRates(file)["claude-sonnet-5"].input, 2, "rates refreshed");
  assert.equal(readCachedWindows(file)["claude-opus-5"], M, "the windows it had are kept");
});

test("with AI_USAGE_NO_PRICING_REFRESH set, nothing reaches the network", async () => {
  assert.equal(process.env.AI_USAGE_NO_PRICING_REFRESH, "1", "the test suite runs with it");
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch({}, calls);
  try {
    const result = await refreshPricing({ file: path.join(os.tmpdir(), "never-written.json"), ttlMs: 0 });
    assert.equal(result.status, "no-fetch");
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// Stored costs are kept while a turn's tokens are unchanged: what a turn cost at
// the time stands. A cost worked out under rates that were never the provider's
// is the exception, and only for the models a revision corrected.
test("a cost from before its model's rates were corrected is worked out again; any other is kept", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-supersede-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.ndjson");
  const read = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const turn = (id, model, cost) => ({ provider: "claude", sessionId: "s", id, ts: "2026-09-10T10:00:00.000Z", model,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: M }, cost });
  const stale = { input: 0, output: 0, cacheWrite: 0, cacheRead: 1, total: 1, source: "priced" };

  await upsertSession(file, "s", [
    turn("fable", "claude-fable-5-1", stale),
    turn("haiku", "claude-haiku-4-5", { ...stale, cacheRead: 0.2, total: 0.2 }),
  ]);
  await upsertSession(file, "s", [
    turn("fable", "claude-fable-5-1", { ...stale, cacheRead: 0.25, total: 0.25, rates: 2, supersedes: 2 }),
    turn("haiku", "claude-haiku-4-5", { ...stale, cacheRead: 0.1, total: 0.1, rates: 2 }),
  ]);
  let rows = read();
  assert.equal(rows.find((r) => r.id === "fable").cost.total, 0.25, "the 4x cache-read price is replaced");
  assert.equal(rows.find((r) => r.id === "haiku").cost.total, 0.2, "an uncorrected model's stored cost stands");

  // Corrected once, it is kept like any other cost from then on.
  await upsertSession(file, "s", [
    turn("fable", "claude-fable-5-1", { ...stale, cacheRead: 0.3, total: 0.3, rates: 2, supersedes: 2 }),
    turn("haiku", "claude-haiku-4-5", { ...stale, cacheRead: 0.1, total: 0.1, rates: 2 }),
  ]);
  rows = read();
  assert.equal(rows.find((r) => r.id === "fable").cost.total, 0.25);
});

// Claude Code deletes old transcripts, and a re-read cannot reach a row whose
// transcript is gone. Each row stores its request size, so its fill can be
// measured again exactly against the window this version knows.
test("stored rows with no transcript left are re-measured against the known window, and nothing else moves", async (t) => {
  const { repairStoredContext } = await import("../src/providers/claude/index.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-ctxfix-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.ndjson");
  const rows = [
    { provider: "claude", sessionId: "s", id: "gone", model: "claude-sonnet-5", contextTokens: 474_387, contextMax: 200_000, contextFillPct: 237.2 },
    { provider: "claude", sessionId: "s", id: "right", model: "claude-opus-5", contextTokens: 100_000, contextMax: 1_000_000, contextFillPct: 10 },
    { provider: "claude", sessionId: "s", id: "guess", model: "claude-opus-9", contextTokens: 150_000, contextMax: 200_000, contextFillPct: 75 },
    { provider: "claude", sessionId: "s", id: "impossible", model: "claude-haiku-4-5", contextTokens: 300_000, contextMax: 100_000, contextFillPct: 300 },
    { provider: "codex", sessionId: "c", id: "other", model: "gpt-5.6", contextTokens: 900_000, contextMax: 200_000, contextFillPct: 450 },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(await repairStoredContext([file]), 1);
  const after = Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  assert.deepEqual([after.gone.contextMax, after.gone.contextFillPct], [1_000_000, 47.4]);
  assert.equal(after.right.contextFillPct, 10);
  assert.equal(after.guess.contextMax, 200_000, "a guessed window is not a known one");
  assert.equal(after.impossible.contextMax, 100_000, "a request larger than the known window is left as recorded");
  assert.equal(after.other.contextFillPct, 450, "other providers are left alone");
  assert.equal(await repairStoredContext([file]), 0, "a second pass changes nothing");
});

// ---- third review ----

test("a corrected turn is taken whole, so its total always equals its main thread plus its runs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-whole-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.ndjson");
  const c = (total, stamp = {}) => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: total, total, source: "priced", ...stamp });
  const turn = (total, runTotal, stamp, runStamp) => ({
    provider: "claude", sessionId: "s", id: "t", model: "claude-fable-5-1",
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 2 * M }, cost: c(total, stamp),
    subagents: [{ agentId: "a1", model: "claude-haiku-4-5", usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: M }, cost: c(runTotal, runStamp) }],
  });
  // Stored by an older version: Fable main work at the 4x price, and a Haiku run at an older price.
  await upsertSession(file, "s", [turn(1.2, 0.2)]);
  // Read again: Fable at $0.25, Haiku at $0.10.
  await upsertSession(file, "s", [turn(0.35, 0.1, { rates: 2, supersedes: 2 }, { rates: 2 })]);
  const read = () => JSON.parse(fs.readFileSync(file, "utf8").trim());
  let row = read();
  assert.equal(row.cost.total, 0.35);
  assert.equal(row.subagents[0].cost.total, 0.1, "the run is taken with the turn, not kept at its older price");
  // And it settles: the next read keeps it.
  await upsertSession(file, "s", [turn(0.35, 0.05, { rates: 2, supersedes: 2 }, { rates: 2 })]);
  row = read();
  assert.equal(row.subagents[0].cost.total, 0.1);
});

test("--relabel never changes an amount, and leaves a correction to the next plain sync", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-relabel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.ndjson");
  const row = (total, stamp = {}) => ({ provider: "claude", sessionId: "s", id: "t", model: "claude-fable-5-1",
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: M }, cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: total, total, source: "priced", ...stamp } });
  const read = () => JSON.parse(fs.readFileSync(file, "utf8").trim());
  await upsertSession(file, "s", [row(1)]);
  process.env.AI_USAGE_RELABEL = "1";
  try {
    await upsertSession(file, "s", [row(0.25, { rates: 2, supersedes: 2 })]);
  } finally {
    delete process.env.AI_USAGE_RELABEL;
  }
  assert.equal(read().cost.total, 1, "relabel kept the amount");
  await upsertSession(file, "s", [row(0.25, { rates: 2, supersedes: 2 })]);
  assert.equal(read().cost.total, 0.25, "a plain sync still corrects it");
});

test("a fetched price without cache prices keeps the model's own cache ratio, whatever its input", () => {
  applyRemoteRates({ "claude-mythos-5-1": { input: 8, output: 40 } }, null);
  assert.equal(modelInfo("claude-mythos-5-1").cacheRead, 0.2, "0.025x of 8, not the generic 0.1x");
  applyRemoteRates({ "claude-mythos-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 } }, null);
});

test("a refresh bringing only a window keeps the fetched price it had, and one bringing only a price keeps the window", () => {
  applyRemoteRates({ "claude-opus-10": { input: 6, output: 30 } }, { "claude-opus-10": M });
  applyRemoteRates(null, { "claude-opus-10": M });
  assert.equal(modelInfo("claude-opus-10").input, 6);
  assert.equal(modelInfo("claude-opus-10").estimated, undefined);
  applyRemoteRates({ "claude-opus-10": { input: 7, output: 35 } }, null);
  assert.equal(contextMax("claude-opus-10"), M);
});

test("a known price is not a known window, and a known window is not a known price", async (t) => {
  const { knownContextMax } = await import("../src/providers/claude/pricing.mjs");
  const { buildTurns } = await import("../src/providers/claude/transcript.mjs");
  applyRemoteRates({ "claude-haiku-9": { input: 1, output: 5 } }, null);
  assert.equal(knownContextMax("claude-haiku-9"), null, "priced, but its window is still a guess");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-window-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", sessionId: "s", cwd: dir, timestamp: "2026-09-16T10:00:00.000Z", message: { content: "go" } },
    { type: "assistant", timestamp: "2026-09-16T10:00:01.000Z", message: { id: "m1", model: "claude-haiku-9", content: [], usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 499_000, cache_creation_input_tokens: 0 } } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n");
  assert.equal(buildTurns(file)[0].contextFillPct, 50, "a guessed window is still outgrown to 1M");

  applyRemoteRates(null, { "claude-sonnet-10": M });
  assert.equal(knownContextMax("claude-sonnet-10"), M, "a fetched window is known although its price is not");
  assert.equal(modelInfo("claude-sonnet-10").estimated, true);
});

test("a rate page that fails backs off instead of fetching both pages on every sync, and keeps windows that did arrive", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-backoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pricing-claude.json");
  const calls = [];
  const fetchImpl = fakeFetch({ pricing: null, models: MODELS_PAGE }, calls);
  const first = await refreshPricing({ file, url: "pricing", modelsUrl: "models", now: 1_000_000_000, fetchImpl });
  assert.equal(first.status, "http-404");
  assert.equal(readCachedWindows(file)["claude-opus-5"], M, "windows kept with no rates cached yet");
  const second = await refreshPricing({ file, url: "pricing", modelsUrl: "models", now: 1_000_000_000 + 60_000, fetchImpl });
  assert.equal(second.status, "backoff");
  assert.equal(calls.length, 2, "the second sync opened no socket");
  const later = await refreshPricing({ file, url: "pricing", modelsUrl: "models", now: 1_000_000_000 + 2 * 60 * 60 * 1000, fetchImpl });
  assert.notEqual(later.status, "backoff", "and tries again once the back-off has passed");
  const dashboard = await refreshPricing({ file, url: "pricing", modelsUrl: "models", ttlMs: 0, now: 1_000_000_000 + 2 * 60 * 60 * 1000 + 1, fetchImpl });
  assert.notEqual(dashboard.status, "backoff", "the dashboard, asking with ttlMs 0, is never held back");
});

test("windows are never matched to the columns of a table above them", () => {
  const md = [
    "| Feature | A | B |",
    "| :-- | :-- | :-- |",
    "| Claude API ID | `claude-opus-5` | `claude-haiku-4-5` |",
    "| Feature | B | A |",
    "| :-- | :-- | :-- |",
    "| Context window | 200K tokens | 1M tokens |",
  ].join("\n");
  assert.deepEqual(parseModelsMarkdown(md), {});
  assert.deepEqual(parseModelsMarkdown("| Claude API ID | `claude-opus-5` | `claude-haiku-4-5` |\n| Context window | 1M tokens |"), {}, "nor to a row with a different column count");
});

test("every provider's refresher stays off the network when told to", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("offline"); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-offline-"));
  try {
    const codex = await import("../src/providers/codex/remote-pricing.mjs");
    const cursor = await import("../src/providers/cursor/remote-pricing.mjs");
    await codex.refreshPricing({ file: path.join(dir, "c.json"), ttlMs: 0 });
    await cursor.refreshPricing({ file: path.join(dir, "k.json"), ttlMs: 0 });
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(calls, []);
});
