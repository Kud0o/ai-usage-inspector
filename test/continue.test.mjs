import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTurns } from "../src/providers/continue/transcript.mjs";

test("Continue parses token events (both field-name styles) and skips non-token events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-continue-"));
  const file = path.join(dir, "tokensGenerated.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ eventName: "tokensGenerated", model: "gpt-4o", promptTokens: 500, generatedTokens: 120, timestamp: 1730000000000 }),
    JSON.stringify({ eventName: "tokensGenerated", model: "claude-3-5-sonnet", tokens_prompt: 800, tokens_generated: 200, timestamp: "2026-07-01T10:00:00Z" }),
    JSON.stringify({ eventName: "autocomplete", accepted: true }), // no tokens -> skipped
    "not json",                                                    // -> skipped
  ].join("\n") + "\n");
  try {
    const turns = buildTurns({ file, sessionId: "tokensGenerated.jsonl" });
    assert.equal(turns.length, 2);

    assert.equal(turns[0].provider, "continue");
    assert.equal(turns[0].model, "gpt-4o");
    assert.equal(turns[0].usage.input, 500);
    assert.equal(turns[0].usage.output, 120);
    assert.equal(turns[0].cost.total, 0); // Continue records no cost
    assert.ok(turns[0].ts); // ms-epoch timestamp parsed

    assert.equal(turns[1].model, "claude-3-5-sonnet");
    assert.equal(turns[1].usage.input, 800);   // tokens_prompt alias
    assert.equal(turns[1].usage.output, 200);  // tokens_generated alias
    assert.ok(turns[1].ts); // ISO timestamp parsed
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
