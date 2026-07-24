// Continue provider. Continue (continue.dev) is a VS Code / JetBrains AI
// extension that writes local telemetry to ~/.continue/dev_data/**/*.jsonl.
// Like the Cline family this is SCAN-ONLY (no external hook): captured by
// sync.mjs and the viewer's autoSync. Pure Node — no Node >= 22.5 requirement.
//
// Usage-only: Continue records tokens + model but not cost or prompt text.
// UNVERIFIED against a live install (see transcript.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTurns as buildContinueTurns } from "./transcript.mjs";

export const id = "continue";
export const displayName = "Continue";

export function continueDir() {
  return path.join(os.homedir(), ".continue");
}
function devDataDir() {
  return path.join(continueDir(), "dev_data");
}

/** Present when Continue's dev-data dir exists. */
export function detect() {
  try {
    return fs.existsSync(devDataDir());
  } catch {
    return false;
  }
}

// Recursively collect *.jsonl event-log files under dev_data.
function listEventFiles(sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6) walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(p).mtimeMs;
        } catch {}
        if (sinceMs > 0 && !(mtimeMs >= sinceMs)) continue;
        out.push(p);
      }
    }
  };
  walk(devDataDir(), 0);
  return out;
}

export function buildTurns(ref, opts = {}) {
  return buildContinueTurns(ref, opts);
}

/** Entries: { transcriptPath:{file,sessionId}, opts }. One entry per jsonl file. */
export function discoverTranscripts({ sinceMs = 0 } = {}) {
  const out = [];
  for (const file of listEventFiles(sinceMs)) {
    out.push({ transcriptPath: { file, sessionId: path.basename(file) }, opts: {} });
  }
  return out;
}

// No hook to register — capture is via sync.
export function install() {
  return { file: null, action: "scan-only" };
}
export function uninstall() {
  return { file: null, removed: 0 };
}
