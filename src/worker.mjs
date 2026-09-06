#!/usr/bin/env node
// Detached spool consumer. Failures remain retriable without delaying hook.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingest, ingestTranscript } from "./lib/ingest.mjs";
import { globalConfigPath } from "./lib/config.mjs";
import { getProvider, detectInstalled } from "./providers/index.mjs";
import { scanWindow, recordScanResult, claimScan, readScanState } from "./lib/scan-state.mjs";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_WORK_STALE_MS = 15 * 60 * 1000;
const DEFAULT_TEMP_STALE_MS = 60 * 60 * 1000;
const ATTEMPT_RE = /-a(\d+)\.(event|work)$/;

export function defaultSpoolDir() {
  return process.env.AI_USAGE_SPOOL_DIR
    || path.join(os.homedir(), ".ai-usage-inspector", "spool");
}

function ageMs(file, now) {
  try {
    const stat = fs.statSync(file);
    return now - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

function attemptOf(file) {
  const match = path.basename(file).match(ATTEMPT_RE);
  return match ? Number(match[1]) : 0;
}

function withAttempt(file, attempt, state) {
  const base = file.replace(ATTEMPT_RE, "");
  return `${base}-a${attempt}.${state}`;
}

function safeUnlink(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function safeRename(from, to) {
  try {
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

function readEnvelope(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schema !== 1 || typeof value.provider !== "string" || typeof value.raw !== "string") {
    throw new Error("invalid spool envelope");
  }
  return value;
}

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

/**
 * Rescan a scan-based provider (Cursor / OpenCode). The window comes from the
 * durable high-water mark rather than a fixed 24h look-back, so an outage longer
 * than a day no longer silently drops history. The mark is advanced ONLY when
 * the scan both reported a healthy store and ingested every transcript it found
 * — a locked DB, an unsupported schema, or a single failed ingest leaves the
 * mark where it was so the next run picks the work back up.
 */
export async function rescan(provider, norm) {
  const { sinceMs, scanStartedAtMs } = scanWindow(provider.id);
  const effectiveSince = Number.isFinite(norm.sinceMs) ? norm.sinceMs : sinceMs;

  let status = "ok";
  let detail = null;
  let completed = false;
  try {
    let found = [];
    if (typeof provider.discoverTranscriptsStatus === "function") {
      const result = await provider.discoverTranscriptsStatus({ sinceMs: effectiveSince });
      found = result.transcripts || [];
      status = result.status || "ok";
      detail = result.detail || null;
    } else {
      found = await provider.discoverTranscripts({ sinceMs: effectiveSince });
    }
    let allIngested = true;
    for (const transcript of found) {
      try {
        await ingestTranscript(provider, transcript);
      } catch (err) {
        allIngested = false;
        if (err && err.scanStatus) {
          status = err.scanStatus;
          detail = err.message || detail;
        }
      }
    }
    completed = allIngested && status === "ok";
  } catch (err) {
    status = (err && err.scanStatus) || status;
    detail = (err && err.message) || detail;
    completed = false;
  }
  try {
    await recordScanResult(provider.id, { scanStartedAtMs, status, detail, completed });
  } catch {}
}

export async function processEnvelope(envelope) {
  const provider = getProvider(envelope.provider);
  if (!provider) return { permanent: true };

  const previousCwd = process.cwd();
  const previousUsageDir = process.env.AI_USAGE_DIR;
  try {
    if (typeof envelope.cwd === "string" && envelope.cwd) {
      try { process.chdir(envelope.cwd); } catch {}
    }
    if (typeof envelope.aiUsageDir === "string" && envelope.aiUsageDir) {
      process.env.AI_USAGE_DIR = envelope.aiUsageDir;
    } else {
      delete process.env.AI_USAGE_DIR;
    }

    const norm = provider.normalizePayload(envelope.raw);
    if (norm && norm.rescan && typeof provider.discoverTranscripts === "function") {
      await rescan(provider, norm);
    } else {
      await ingest(provider, envelope.raw);
    }
    return { permanent: false };
  } finally {
    restoreEnv("AI_USAGE_DIR", previousUsageDir);
    try { process.chdir(previousCwd); } catch {}
  }
}

function recoverOrphans(dir, { now, workStaleMs, maxAgeMs, tempStaleMs }) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    const age = ageMs(file, now);
    if (name.endsWith(".tmp")) {
      if (age > tempStaleMs) safeUnlink(file);
      continue;
    }
    if (name.endsWith(".work")) {
      if (age > maxAgeMs) safeUnlink(file);
      else if (age > workStaleMs) safeRename(file, withAttempt(file, attemptOf(file), "event"));
      continue;
    }
    if (name.endsWith(".event") && age > maxAgeMs) safeUnlink(file);
  }
}

export async function drainSpool({
  dir = defaultSpoolDir(),
  handle = processEnvelope,
  now = Date.now(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  workStaleMs = DEFAULT_WORK_STALE_MS,
  tempStaleMs = DEFAULT_TEMP_STALE_MS,
} = {}) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return { processed: 0, failed: 0 }; }
  recoverOrphans(dir, { now, workStaleMs, maxAgeMs, tempStaleMs });

  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".event")).sort(); } catch {}
  let processed = 0;
  let failed = 0;

  for (const name of names) {
    const pending = path.join(dir, name);
    const previousAttempt = attemptOf(pending);
    if (previousAttempt >= maxAttempts || ageMs(pending, now) > maxAgeMs) {
      safeUnlink(pending);
      continue;
    }

    const attempt = previousAttempt + 1;
    const claimed = withAttempt(pending, attempt, "work");
    const claimedAt = new Date();
    try { fs.utimesSync(pending, claimedAt, claimedAt); } catch {}
    if (!safeRename(pending, claimed)) continue;
    try { fs.utimesSync(claimed, claimedAt, claimedAt); } catch {}

    let envelope;
    try {
      envelope = readEnvelope(claimed);
      envelope.attempts = attempt;
    } catch {
      failed += 1;
      safeUnlink(claimed);
      continue;
    }

    try {
      const result = await handle(envelope);
      processed += 1;
      safeUnlink(claimed);
      if (result && result.permanent) continue;
    } catch {
      failed += 1;
      if (attempt >= maxAttempts || ageMs(claimed, now) > maxAgeMs) {
        safeUnlink(claimed);
      } else {
        safeRename(claimed, withAttempt(claimed, attempt, "event"));
      }
    }
  }
  return { processed, failed };
}

// How recently another sweep must have run for this one to skip a provider.
// Long enough that a burst of turns does not re-walk every store, short enough
// that a delegated run shows up while the user is still looking at it.
const SWEEP_THROTTLE_MS = 60 * 1000;

/**
 * Import work done by agents that never fired a hook.
 *
 * A delegated CLI run -- "codex exec" behind a delegate skill, say -- writes its
 * own transcript but triggers no Stop hook, so its cost stays invisible until
 * something scans. This runs after the spool is drained, in the already-detached
 * worker, so the hook path is untouched: still spool-and-exit, still offline.
 * Best-effort by design -- a provider that cannot be read leaves its watermark
 * where it was and gets retried next time.
 */
// Global hook registrations. A hook recorded here means the user installed for
// the whole machine; a --local install writes into <project>/.claude/ instead.
const GLOBAL_HOOK_FILES = [
  path.join(os.homedir(), ".claude", "settings.json"),
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json"),
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"),
  path.join(os.homedir(), ".cursor", "hooks.json"),
  path.join(os.homedir(), ".config", "opencode", "plugins", "ai-usage-inspector.js"),
];

// The hook we write, not merely a mention of the file. A comment or an unrelated
// command naming record.mjs must not be read as an installation.
const HOOK_COMMAND = /record\.mjs\S*\s+--provider\s+\w/;

/** Did the user install this tool for the machine, rather than one project? */
function hasGlobalInstall() {
  for (const file of GLOBAL_HOOK_FILES) {
    try {
      if (HOOK_COMMAND.test(fs.readFileSync(file, "utf8"))) return true;
    } catch {}
  }
  return false;
}

/**
 * Providers the automatic sweep may look at.
 *
 * This is the same set `sync.mjs` and the dashboard's scan-on-start already use
 * (every detected agent), so a global install sweeps no wider than before. What
 * it changes is timing: history is imported after a turn instead of only when
 * someone opens the dashboard. Set "autoSweep": false in
 * ~/.ai-usage-inspector/config.json to turn that off.
 *
 * A `--local` install means "this project only". Its worker must not go looking
 * through every other agent's history on the machine, so it does not sweep at
 * all — the project's own turns still arrive through the hook.
 */
export function sweepAllowed() {
  try {
    const raw = JSON.parse(fs.readFileSync(globalConfigPath(), "utf8"));
    if (raw && raw.autoSweep === false) return false;
  } catch {}
  return hasGlobalInstall();
}

function installedForSweep() {
  return sweepAllowed() ? detectInstalled() : [];
}

export async function sweepProviders({
  now = Date.now(),
  throttleMs = SWEEP_THROTTLE_MS,
  providers = null,
  scan = rescan,
} = {}) {
  const swept = [];
  for (const provider of providers || installedForSweep()) {
    if (typeof provider.discoverTranscripts !== "function") continue;
    // Claim before scanning: two workers starting together must not both scan.
    let mine = false;
    try { mine = await claimScan(provider.id, { throttleMs, now }); } catch { mine = false; }
    if (!mine) continue;
    try {
      await scan(provider, {});
      swept.push(provider.id);
    } catch {}
  }
  return swept;
}

/** Is another worker still holding a claimed envelope? */
function spoolBusy(dir = defaultSpoolDir()) {
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith(".work"));
  } catch {
    return false;
  }
}

/** Any envelope left to process? */
function spoolPending(dir = defaultSpoolDir()) {
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith(".event"));
  } catch {
    return false;
  }
}

// How long a machine may go without a sweep before one runs regardless of spool
// activity. A continuously busy machine never presents a quiet instant, and
// waiting for one forever means delegated work is never imported.
const SWEEP_STARVATION_MS = 15 * 60 * 1000;

/** Milliseconds since any provider was last scanned, or Infinity if never. */
function msSinceLastScan(now = Date.now()) {
  let newest = 0;
  try {
    const state = readScanState();
    for (const entry of Object.values((state && state.providers) || {})) {
      const at = Number(entry && entry.lastScanAtMs);
      if (Number.isFinite(at) && at > newest) newest = at;
    }
  } catch {}
  return newest > 0 ? now - newest : Infinity;
}

/**
 * May this worker sweep right now?
 *
 * Quiet spool: yes. Busy spool: normally no — another worker is writing the very
 * sessions a scan would parse. But a continuously busy machine never presents a
 * quiet instant, so once nothing has scanned for a long while, sweep anyway.
 * Overlapping a writer is survivable: ingestTranscript abandons a pass whose
 * transcript moved, and claimScan keeps two sweeps off the same provider.
 */
export function shouldSweepNow({ now = Date.now(), starvationMs = SWEEP_STARVATION_MS } = {}) {
  if (!spoolPending() && !spoolBusy()) return true;
  return msSinceLastScan(now) >= starvationMs;
}

async function main() {
  // One pass only enumerates the spool once, so an event that lands mid-drain is
  // left for the next worker. Loop until the spool is actually quiet — bounded,
  // because a spool that keeps refilling is another worker's job, not ours.
  for (let pass = 0; pass < 5; pass++) {
    try { await drainSpool(); } catch {}
    if (!spoolPending()) break;
  }
  // Prefer a quiet spool: another worker holding a claimed envelope is writing
  // the very sessions a scan would parse. But a busy machine never goes quiet,
  // and skipping forever means never importing delegated work — so once the
  // machine has gone long enough without any scan, sweep anyway. Overlapping a
  // writer is safe: ingestTranscript abandons a pass whose transcript moved, and
  // claimScan keeps two sweeps off the same provider.
  if (!shouldSweepNow()) return;
  try { await sweepProviders(); } catch {}
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main().catch(() => {});
