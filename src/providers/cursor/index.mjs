// Cursor provider. Cursor's stop hook (~/.cursor/hooks.json) carries no token,
// model, or workspace data — it is only a trigger. All data comes from Cursor's
// SQLite stores (see store.mjs), so this provider is scan-based:
//   - the hook fires record.mjs --provider cursor, which rescans conversations
//     updated in the last 24h ({ rescan: true } directive);
//   - sync.mjs backfills full history via discoverTranscripts().
// The "transcript reference" for buildTurns is { composerId, cwd }, not a file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTurns as buildCursorTurns } from "./transcript.mjs";
import { applyRemoteRates } from "./pricing.mjs";
import { refreshPricing as refreshRemote } from "./remote-pricing.mjs";
import {
  cursorDataDir,
  globalDbPath,
  listWorkspaces,
  listComposerIds,
  readComposerMeta,
  available,
} from "./store.mjs";

export const id = "cursor";
export const displayName = "Cursor";

const HOOKS_FILE = path.join(os.homedir(), ".cursor", "hooks.json");
const MARKER = "ai-usage-inspector";

// Cursor's data lives in SQLite, read via node:sqlite (Node >= 22.5.0). The rest
// of the tool runs on Node >= 18; this is the one provider that needs newer Node.
export function nodeSupported() {
  const [maj, min] = String(process.versions.node).split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 5);
}

/** Cursor is "present" when its data dir exists. */
export function detect() {
  try {
    return fs.existsSync(cursorDataDir());
  } catch {
    return false;
  }
}

// ---- record-time ----

/**
 * The stop-hook payload has no composer/workspace info, so the hook path is a
 * bounded rescan of recently updated conversations.
 */
export function normalizePayload() {
  return { rescan: true, sinceMs: Date.now() - 24 * 60 * 60 * 1000 };
}

export async function buildTurns(composerRef, opts = {}) {
  return buildCursorTurns(composerRef, opts);
}

/**
 * All conversations across all workspaces, for sync/rescan. `sinceMs` filters
 * on the composer's lastUpdatedAt. Entries: { transcriptPath: {composerId,cwd},
 * opts: {cwd} } — transcriptPath is the provider-opaque reference.
 */
export async function discoverTranscripts({ sinceMs = 0 } = {}) {
  if (!(await available())) return []; // node:sqlite missing (Node < 22.5)
  const out = [];
  const gdb = globalDbPath();
  for (const ws of await listWorkspaces()) {
    const ids = await listComposerIds(ws.dbPath);
    for (const composerId of ids) {
      if (sinceMs > 0) {
        const composer = await readComposerMeta(gdb, composerId);
        const upd = composer && (composer.lastUpdatedAt || composer.createdAt);
        if (!(Number(upd) >= sinceMs)) continue;
      }
      out.push({
        transcriptPath: { composerId, cwd: ws.cwd },
        opts: { cwd: ws.cwd },
      });
    }
  }
  return out;
}

// ---- install-time (stop hook in ~/.cursor/hooks.json) ----

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function hookCmd(appPath) {
  // The app path contains the MARKER string (~/.ai-usage-inspector/app), which
  // is what install/uninstall match on.
  return `node "${path.join(appPath, "src", "record.mjs")}" --provider ${id}`;
}

export function install({ appPath }) {
  // Refuse loudly on old Node rather than installing a hook that reads nothing.
  if (!nodeSupported()) {
    return { file: HOOKS_FILE, action: "unsupported-node", node: process.versions.node };
  }
  const s = readJson(HOOKS_FILE);
  if (typeof s.version !== "number") s.version = 1;
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  s.hooks.stop = Array.isArray(s.hooks.stop) ? s.hooks.stop : [];
  const exists = s.hooks.stop.some(
    (h) => h && typeof h.command === "string" && h.command.includes(MARKER),
  );
  if (exists) return { file: HOOKS_FILE, action: "exists" };
  s.hooks.stop.push({ command: hookCmd(appPath) });
  writeJson(HOOKS_FILE, s);
  return { file: HOOKS_FILE, action: "added" };
}

export function uninstall() {
  const s = readJson(HOOKS_FILE);
  if (!s.hooks || !Array.isArray(s.hooks.stop)) return { file: HOOKS_FILE, removed: 0 };
  const before = s.hooks.stop.length;
  s.hooks.stop = s.hooks.stop.filter(
    (h) =>
      !(
        h &&
        typeof h.command === "string" &&
        (h.command.includes(MARKER) || h.command.includes("usage-tracker"))
      ),
  );
  const removed = before - s.hooks.stop.length;
  if (s.hooks.stop.length === 0) delete s.hooks.stop;
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  if (removed) writeJson(HOOKS_FILE, s);
  return { file: HOOKS_FILE, removed };
}

// ---- pricing refresh (cursor.com docs scrape) ----

export async function refreshPricing() {
  const r = await refreshRemote();
  if (r && r.rates) applyRemoteRates(r.rates);
  return r;
}
