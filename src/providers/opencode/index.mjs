// OpenCode provider. OpenCode (sst/opencode) is a terminal AI agent that stores
// every session in a single SQLite DB (see store.mjs) and exposes a plugin API
// with a `session.idle` event. Like Cursor, this provider is scan-based:
//   - a plugin at ~/.config/opencode/plugins/ fires record.mjs --provider
//     opencode on session.idle, which rescans sessions updated in the last 24h
//     ({ rescan: true } directive);
//   - sync.mjs backfills full history via discoverTranscripts().
// The "transcript reference" for buildTurns is { sessionId, cwd }, not a file.
//
// Cost + tokens are read straight from OpenCode's DB (it computes them itself),
// so there is no pricing scraper — the provider omits refreshPricing entirely.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeSupported } from "../../lib/sqlite.mjs";
import { buildTurns as buildOpencodeTurns } from "./transcript.mjs";
import { detect, dbPath, listSessions, available } from "./store.mjs";

export { detect, nodeSupported };
export const id = "opencode";
export const displayName = "OpenCode";

const PLUGINS_DIR = path.join(os.homedir(), ".config", "opencode", "plugins");
const PLUGIN_FILE = path.join(PLUGINS_DIR, "ai-usage-inspector.js");
const MARKER = "ai-usage-inspector";

// ---- record-time ----

/**
 * The session.idle plugin carries no session info to our command, so the hook
 * path is a bounded rescan of recently updated sessions.
 */
export function normalizePayload() {
  return { rescan: true, sinceMs: Date.now() - 24 * 60 * 60 * 1000 };
}

export async function buildTurns(ref, opts = {}) {
  return buildOpencodeTurns(ref, opts);
}

/**
 * All sessions for sync/rescan. `sinceMs` filters on the session's time_updated.
 * Entries: { transcriptPath: {sessionId, cwd}, opts:{cwd} } — transcriptPath is
 * the provider-opaque reference.
 */
export async function discoverTranscripts({ sinceMs = 0 } = {}) {
  if (!(await available())) return []; // node:sqlite missing (Node < 22.5)
  const out = [];
  for (const s of await listSessions({ sinceMs })) {
    if (!s || !s.id) continue;
    out.push({ transcriptPath: { sessionId: s.id, cwd: s.directory || null }, opts: { cwd: s.directory || null } });
  }
  return out;
}

// ---- install-time (session.idle plugin in ~/.config/opencode/plugins/) ----

// The plugin runs our recorder after each turn's session.idle event. It spawns
// DETACHED and unref'd (fire-and-forget) so the recorder outlives OpenCode when
// a one-shot `opencode run` exits immediately after idling — awaiting it would
// let OpenCode kill the child before it writes. It never blocks or throws into
// OpenCode; the MARKER in the file name + banner is what install/uninstall
// match on. Forward-slash the record path so it needs no escaping on Windows.
function pluginSource(appPath) {
  const recordPath = path.join(appPath, "src", "record.mjs").replace(/\\/g, "/");
  return `// ${MARKER} — records OpenCode token/cost usage after each turn.
// Auto-generated; delete this file (or run: ai-usage-inspector --uninstall) to stop.
import { spawn } from "node:child_process";
export const AiUsageInspector = async () => ({
  event: async ({ event }) => {
    if (!event || event.type !== "session.idle") return;
    try {
      const child = spawn("node", ["${recordPath}", "--provider", "${id}"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {}
  },
});
`;
}

export function install({ appPath }) {
  // record.mjs reads OpenCode's SQLite DB, which needs Node >= 22.5. Refuse
  // loudly rather than installing a plugin that would record nothing.
  if (!nodeSupported()) {
    return { file: PLUGIN_FILE, action: "unsupported-node", node: process.versions.node };
  }
  const existed = fs.existsSync(PLUGIN_FILE);
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  fs.writeFileSync(PLUGIN_FILE, pluginSource(appPath));
  return { file: PLUGIN_FILE, action: existed ? "exists" : "added" };
}

export function uninstall() {
  try {
    if (fs.existsSync(PLUGIN_FILE)) {
      const body = fs.readFileSync(PLUGIN_FILE, "utf8");
      if (body.includes(MARKER)) {
        fs.rmSync(PLUGIN_FILE, { force: true });
        return { file: PLUGIN_FILE, removed: 1 };
      }
    }
  } catch {}
  return { file: PLUGIN_FILE, removed: 0 };
}
