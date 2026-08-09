import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { costOf } from "../src/providers/codex/pricing.mjs";
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
