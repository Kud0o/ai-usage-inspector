import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FIRST_SCAN_WINDOW_MS,
  SCAN_OVERLAP_MS,
  readScanState,
  recordScanResult,
  scanWindow,
} from "../src/lib/scan-state.mjs";

function tmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-scanstate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "scan-state.json");
}

test("first scan falls back to the 24h window", (t) => {
  const file = tmpState(t);
  const now = Date.parse("2026-08-10T12:00:00Z");
  const { sinceMs } = scanWindow("cursor", { file, now });
  assert.equal(sinceMs, now - FIRST_SCAN_WINDOW_MS);
});

test("a completed scan advances the mark; the next window uses it with overlap", async (t) => {
  const file = tmpState(t);
  const startedAt = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("cursor", { file, scanStartedAtMs: startedAt, status: "ok", completed: true });

  // A week later the window reaches back to the mark, NOT just 24h — this is the
  // outage case the fixed window used to lose.
  const now = startedAt + 7 * 24 * 60 * 60 * 1000;
  const { sinceMs } = scanWindow("cursor", { file, now });
  assert.equal(sinceMs, startedAt - SCAN_OVERLAP_MS);
  assert.ok(sinceMs < now - FIRST_SCAN_WINDOW_MS, "must look back further than 24h");
});

test("a failed or partial scan does NOT advance the mark", async (t) => {
  const file = tmpState(t);
  const good = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("opencode", { file, scanStartedAtMs: good, status: "ok", completed: true });

  // healthy store but an ingest failed -> not completed
  await recordScanResult("opencode", { file, scanStartedAtMs: good + 60_000, status: "ok", completed: false });
  // scan ran to the end but the store was locked
  await recordScanResult("opencode", { file, scanStartedAtMs: good + 120_000, status: "locked", completed: true, detail: "database is locked" });

  const state = readScanState(file);
  const entry = state.providers.opencode;
  assert.equal(entry.lastSuccessfulScanMs, good, "mark must stay at the last clean scan");
  assert.equal(entry.lastScanStatus, "locked");
  assert.equal(entry.lastScanDetail, "database is locked");
  assert.equal(scanWindow("opencode", { file, now: good + 999_999 }).sinceMs, good - SCAN_OVERLAP_MS);
});

test("the mark never moves backwards", async (t) => {
  const file = tmpState(t);
  const later = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("cursor", { file, scanStartedAtMs: later, status: "ok", completed: true });
  await recordScanResult("cursor", { file, scanStartedAtMs: later - 60 * 60 * 1000, status: "ok", completed: true });
  assert.equal(readScanState(file).providers.cursor.lastSuccessfulScanMs, later);
});

test("providers keep independent marks", async (t) => {
  const file = tmpState(t);
  const a = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("cursor", { file, scanStartedAtMs: a, status: "ok", completed: true });
  const state = readScanState(file);
  assert.ok(state.providers.cursor);
  assert.equal(state.providers.opencode, undefined);
  assert.equal(scanWindow("opencode", { file, now: a }).sinceMs, a - FIRST_SCAN_WINDOW_MS);
});
