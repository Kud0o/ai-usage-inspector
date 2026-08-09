#!/usr/bin/env node
// Detached spool consumer. Failures remain retriable without delaying hook.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingest, ingestTranscript } from "./lib/ingest.mjs";
import { getProvider } from "./providers/index.mjs";
import { scanWindow, recordScanResult } from "./lib/scan-state.mjs";

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
async function rescan(provider, norm) {
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

async function main() {
  try { await drainSpool(); } catch {}
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main().catch(() => {});
