// Durable high-water marks + scan health for scan-based providers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mutateJson } from "./store.mjs";

export const FIRST_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SCAN_OVERLAP_MS = 5 * 60 * 1000;
export const SCAN_STATUSES = new Set(["ok", "locked", "unsupported-schema", "missing"]);

export function scanStatePath() {
  return process.env.AI_USAGE_SCAN_STATE_FILE
    || path.join(os.homedir(), ".ai-usage-inspector", "scan-state.json");
}

export function readScanState(file = scanStatePath()) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" ? state : { schema: 1, providers: {} };
  } catch {
    return { schema: 1, providers: {} };
  }
}

export function scanWindow(providerId, { file = scanStatePath(), now = Date.now() } = {}) {
  const state = readScanState(file);
  const provider = state.providers && state.providers[providerId];
  const mark = Number(provider && provider.lastSuccessfulScanMs);
  return {
    scanStartedAtMs: now,
    sinceMs: Number.isFinite(mark) && mark > 0
      ? Math.max(0, mark - SCAN_OVERLAP_MS)
      : Math.max(0, now - FIRST_SCAN_WINDOW_MS),
  };
}

export async function recordScanResult(providerId, {
  file = scanStatePath(),
  scanStartedAtMs,
  status = "ok",
  completed = false,
  detail = null,
  recordedAtMs = Date.now(),
} = {}) {
  const cleanStatus = SCAN_STATUSES.has(status) ? status : "unsupported-schema";
  return mutateJson(file, (state) => {
    const next = state && typeof state === "object" ? { ...state } : {};
    next.schema = 1;
    next.providers = next.providers && typeof next.providers === "object"
      ? { ...next.providers }
      : {};
    const previous = next.providers[providerId] && typeof next.providers[providerId] === "object"
      ? next.providers[providerId]
      : {};
    const entry = {
      ...previous,
      lastScanAt: new Date(recordedAtMs).toISOString(),
      lastScanAtMs: recordedAtMs,
      lastScanStatus: cleanStatus,
      lastScanCompleted: completed === true,
    };
    if (detail) entry.lastScanDetail = String(detail).slice(0, 500);
    else delete entry.lastScanDetail;
    const started = Number(scanStartedAtMs);
    if (completed === true && cleanStatus === "ok" && Number.isFinite(started) && started > 0) {
      entry.lastSuccessfulScanMs = Math.max(Number(previous.lastSuccessfulScanMs) || 0, started);
      entry.lastSuccessfulScanAt = new Date(entry.lastSuccessfulScanMs).toISOString();
    }
    next.providers[providerId] = entry;
    return next;
  }, { schema: 1, providers: {} });
}
