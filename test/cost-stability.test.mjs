import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { upsertSession } from "../src/lib/store.mjs";

function tmpUsage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-reprice-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AI_USAGE_REPRICE;
  });
  return path.join(dir, "usage.ndjson");
}
const read = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const rec = (source, total) => ({
  provider: "claude",
  sessionId: "s1",
  id: "s1:0",
  usage: { input: 100 },
  cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total, source },
});

test("re-sync keeps a cost this tool computed", async (t) => {
  const file = tmpUsage(t);
  await upsertSession(file, "s1", [rec("priced", 1.23)]);
  // rates changed since; a re-scan recomputes a different number
  await upsertSession(file, "s1", [rec("priced", 9.99)]);
  assert.equal(read(file)[0].cost.total, 1.23, "historical cost must not drift");
});

test("--reprice (AI_USAGE_REPRICE=1) recomputes it", async (t) => {
  const file = tmpUsage(t);
  await upsertSession(file, "s1", [rec("priced", 1.23)]);
  process.env.AI_USAGE_REPRICE = "1";
  await upsertSession(file, "s1", [rec("priced", 9.99)]);
  assert.equal(read(file)[0].cost.total, 9.99);
});

test("an estimated cost is equally stable", async (t) => {
  const file = tmpUsage(t);
  await upsertSession(file, "s1", [rec("estimated", 0.5)]);
  await upsertSession(file, "s1", [rec("estimated", 0.7)]);
  assert.equal(read(file)[0].cost.total, 0.5);
});

test("a provider-reported cost always takes the fresh value", async (t) => {
  const file = tmpUsage(t);
  await upsertSession(file, "s1", [rec("provider", 0.01)]);
  // the tool itself corrected its own number — we are not the authority here
  await upsertSession(file, "s1", [rec("provider", 0.02)]);
  assert.equal(read(file)[0].cost.total, 0.02);
});

test("a genuinely new turn is unaffected", async (t) => {
  const file = tmpUsage(t);
  await upsertSession(file, "s1", [rec("priced", 1.23)]);
  const second = { ...rec("priced", 4.56), id: "s1:1" };
  await upsertSession(file, "s1", [rec("priced", 1.23), second]);
  const rows = read(file);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === "s1:1").cost.total, 4.56);
});
