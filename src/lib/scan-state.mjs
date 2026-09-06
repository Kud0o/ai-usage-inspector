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

/**
 * Take the right to scan a provider, or report that someone else already has.
 *
 * Sweeps run in detached workers that can start at the same moment, so reading
 * the throttle and then acting on it is a race: both read a stale mark, both
 * scan, both ingest. The check and the stamp happen together inside the same
 * locked mutation, so exactly one caller wins.
 *
 * Returns true if this caller may scan. A caller that loses simply skips.
 */
export const SCAN_LEASE_MS = 15 * 60 * 1000;

export async function claimScan(providerId, {
  file = scanStatePath(),
  throttleMs = 0,
  leaseMs = SCAN_LEASE_MS,
  now = Date.now(),
  leaseId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  return mutateJson(file, (state) => {
    const next = state && typeof state === "object" ? { ...state } : {};
    next.schema = 1;
    next.providers = next.providers && typeof next.providers === "object" ? { ...next.providers } : {};
    const previous = next.providers[providerId] && typeof next.providers[providerId] === "object"
      ? next.providers[providerId]
      : {};
    // A scan that outruns the throttle would otherwise be claimable by a second
    // worker mid-flight, which is the very overlap this exists to prevent. The
    // lease covers the scan itself and expires so a crashed worker frees it.
    const lease = Number(previous.scanLeaseUntilMs);
    if (Number.isFinite(lease) && now < lease) return { data: next, value: false };

    const last = Number(previous.lastScanAtMs);
    if (throttleMs > 0 && Number.isFinite(last) && now - last < throttleMs) {
      return { data: next, value: false };
    }
    // Stamp the attempt now so a concurrent worker sees it and stands down. The
    // successful-scan watermark is untouched; only a completed scan moves that.
    next.providers[providerId] = {
      ...previous,
      lastScanAtMs: now,
      lastScanAt: new Date(now).toISOString(),
      scanLeaseUntilMs: now + Math.max(0, leaseMs),
      scanLeaseId: leaseId,
    };
    return { data: next, value: leaseId };
  });
}

export async function recordScanResult(providerId, {
  file = scanStatePath(),
  scanStartedAtMs,
  leaseId = null,
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
    const holdsLease = leaseId != null && previous.scanLeaseId === leaseId;
    const releasing = holdsLease || previous.scanLeaseId == null;
    const entry = {
      ...previous,
      scanLeaseUntilMs: releasing ? undefined : previous.scanLeaseUntilMs,
      scanLeaseId: releasing ? undefined : previous.scanLeaseId,
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
