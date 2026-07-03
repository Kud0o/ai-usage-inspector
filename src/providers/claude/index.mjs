// Claude Code provider. Owns everything Claude-specific: the Stop-hook payload
// shape, where Claude stores transcripts + settings, the transcript parser, the
// pricing table, and how the hook is registered in ~/.claude/settings.json.
//
// Implements the provider interface consumed by src/lib/ingest.mjs (record time)
// and install.mjs (install time):
//   id, displayName, detect()
//   normalizePayload(rawStdin) -> { sessionId, cwd, transcriptPath, opts }
//   buildTurns(transcriptPath, opts) -> [turnRecord]
//   install({ appPath, scope, cwd }) / uninstall({ scope, cwd })
//   refreshPricing()
import fs from "node:fs";
import path from "node:path";
import { HOME, encCwd } from "../../lib/paths.mjs";
import { buildTurns as buildClaudeTurns } from "./transcript.mjs";
import { applyRemoteRates } from "./pricing.mjs";
import { refreshPricing as refreshRemote } from "./remote-pricing.mjs";

export const id = "claude";
export const displayName = "Claude Code";

// The hook entry carries this marker (via the app path + --provider flag) so we
// can find and remove exactly our hook. We also match the legacy marker on
// uninstall so an old claude-usage-tracker hook gets cleaned up.
const MARKER = "ai-usage-inspector";
const LEGACY_MARKER = "usage-tracker";

/** Claude Code is "present" if its home dir exists. */
export function detect() {
  try {
    return fs.existsSync(path.join(HOME, ".claude"));
  } catch {
    return false;
  }
}

// ---- record-time ----

/** Claude Code's global + project settings files (read for effortLevel). */
function settingsCandidates(cwd) {
  const list = [
    path.join(HOME, ".claude", "settings.json"),
    path.join(HOME, ".claude", "settings.local.json"),
  ];
  if (cwd) {
    list.push(path.join(cwd, ".claude", "settings.json"));
    list.push(path.join(cwd, ".claude", "settings.local.json"));
  }
  return list;
}

/** Where Claude Code stores a session transcript when the payload omits it. */
function deriveTranscriptPath(cwd, sessionId) {
  return path.join(HOME, ".claude", "projects", encCwd(cwd), `${sessionId}.jsonl`);
}

function readEffort(cwd) {
  let effort = null;
  for (const f of settingsCandidates(cwd)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j && typeof j.effortLevel === "string") effort = j.effortLevel;
    } catch {}
  }
  return effort;
}

/** Normalize Claude Code's Stop-hook stdin JSON into the canonical shape. */
export function normalizePayload(raw) {
  let payload = {};
  try {
    payload = JSON.parse(raw) || {};
  } catch {}
  const sessionId = payload.session_id || payload.sessionId || null;
  const cwd = payload.cwd || process.cwd();
  let transcriptPath = payload.transcript_path || payload.transcriptPath || null;
  if (!transcriptPath && sessionId) transcriptPath = deriveTranscriptPath(cwd, sessionId);
  return { sessionId, cwd, transcriptPath, opts: { effortLevel: readEffort(cwd) } };
}

export function buildTurns(transcriptPath, opts = {}) {
  return buildClaudeTurns(transcriptPath, opts);
}

/**
 * All session transcripts on disk (~/.claude/projects/<enc-cwd>/<session>.jsonl),
 * for backfill/sync. cwd is recovered from each transcript's own entries (turn
 * records carry it), so opts stays empty. `sinceMs` skips files not modified
 * since then. Subagent files live one level deeper and are loaded by the
 * parser itself — only top-level session files are returned.
 */
export function discoverTranscripts({ sinceMs = 0 } = {}) {
  const root = path.join(HOME, ".claude", "projects");
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(root, p.name);
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f.name);
      try {
        if (fs.statSync(fp).mtimeMs >= sinceMs) out.push({ transcriptPath: fp, opts: {} });
      } catch {}
    }
  }
  return out;
}

// ---- install-time (hook in ~/.claude/settings.json) ----

function settingsPath(scope, cwd) {
  return scope === "local"
    ? path.join(cwd || process.cwd(), ".claude", "settings.local.json")
    : path.join(HOME, ".claude", "settings.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function hookCmd(appPath) {
  return `node "${path.join(appPath, "src", "record.mjs")}" --provider ${id}`;
}

export function install({ appPath, scope, cwd }) {
  const file = settingsPath(scope, cwd);
  const s = readJson(file);
  s.hooks = s.hooks || {};
  s.hooks.Stop = s.hooks.Stop || [];
  if (JSON.stringify(s.hooks.Stop).includes(MARKER)) return { file, action: "exists" };
  s.hooks.Stop.push({ hooks: [{ type: "command", command: hookCmd(appPath) }] });
  writeJson(file, s);
  return { file, action: "added" };
}

export function uninstall({ scope, cwd }) {
  const file = settingsPath(scope, cwd);
  const s = readJson(file);
  if (!s.hooks || !Array.isArray(s.hooks.Stop)) return { file, removed: 0 };
  const before = s.hooks.Stop.length;
  s.hooks.Stop = s.hooks.Stop.filter(
    (g) => !JSON.stringify(g).includes(MARKER) && !JSON.stringify(g).includes(LEGACY_MARKER),
  );
  const removed = before - s.hooks.Stop.length;
  if (s.hooks.Stop.length === 0) delete s.hooks.Stop;
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeJson(file, s);
  return { file, removed };
}

// ---- pricing refresh (Claude docs scrape) ----

export async function refreshPricing() {
  const r = await refreshRemote();
  if (r && r.rates) applyRemoteRates(r.rates);
  return r;
}
