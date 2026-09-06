import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { costOf } from "../src/providers/codex/pricing.mjs";
import { costOf as claudeCostOf } from "../src/providers/claude/pricing.mjs";
import { costOf as cursorCostOf } from "../src/providers/cursor/pricing.mjs";
import { addCost } from "../src/lib/pricing-core.mjs";
import { kilo } from "../src/providers/clinefamily/index.mjs";

test("priced cost keeps sub-$0.0001 precision and provenance", () => {
  const cost = costOf("gpt-5.4", { input: 1, cached: 0, output: 0 });
  assert.equal(cost.input, 0.0000025);
  assert.equal(cost.total, 0.0000025);
  assert.equal(cost.source, "priced");
});

test("provider-reported Cline-family cost keeps full precision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-cost-"));
  fs.writeFileSync(path.join(dir, "ui_messages.json"), JSON.stringify([
    { ts: 1000, type: "say", say: "text", text: "prompt" },
    { ts: 1001, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1, tokensOut: 1, cost: 0.00004 }) },
  ]));
  try {
    const [record] = kilo.buildTurns({ taskId: "tiny", dir, cwd: "K:/repo" });
    assert.equal(record.cost.total, 0.00004);
    assert.equal(record.cost.source, "provider");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A rate we looked up and a rate we guessed must not look alike. Every table
// has a FALLBACK tier for models it has never heard of; costs derived from it
// are approximations and have to say so, or "$0.02" reads as a measured fact.
test("a model in the table is priced; one outside it is marked estimated", () => {
  const known = claudeCostOf("claude-opus-4-5", { input_tokens: 1_000_000 });
  assert.equal(known.source, "priced");
  assert.equal(known.input, 5);

  const unknown = claudeCostOf("claude-imaginary-9", { input_tokens: 1_000_000 });
  assert.equal(unknown.source, "estimated", "no listed rate, so the cost is a guess");
  assert.equal(unknown.input, 5, "falls back to the current Opus tier");
});

test("the estimated label survives a date-suffixed model id", () => {
  assert.equal(claudeCostOf("claude-opus-4-5-20260101", { input_tokens: 10 }).source, "priced");
  assert.equal(claudeCostOf("claude-imaginary-9-20250805", { input_tokens: 10 }).source, "estimated");
});

test("Codex prices unlisted models at the codex tier and flags them", () => {
  assert.equal(costOf("gpt-5.4", { input: 1_000_000, cached: 0, output: 0 }).source, "priced");
  const guess = costOf("o9-preview", { input: 1_000_000, cached: 0, output: 0 });
  assert.equal(guess.source, "estimated");
  assert.equal(guess.input, 1.75);
});

test("Cursor flags an unlisted model even when the tokens are exact", () => {
  const exact = cursorCostOf("gpt-5.4", { input: 1_000_000, cached: 0, output: 0 });
  assert.equal(exact.source, "priced");
  const guess = cursorCostOf("some-new-model", { input: 1_000_000, cached: 0, output: 0 });
  assert.equal(guess.source, "estimated", "exact tokens, guessed rate — still an estimate");
});

// addCost is contagious by design: one estimated leg makes the sum estimated.
test("an estimated leg makes a summed cost estimated", () => {
  const sum = addCost(
    claudeCostOf("claude-opus-4-5", { input_tokens: 100 }),
    claudeCostOf("claude-imaginary-9", { input_tokens: 100 }),
  );
  assert.equal(sum.source, "estimated");
});
