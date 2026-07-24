// OpenAI Codex CLI provider. Codex exposes a Stop hook (configured in
// ~/.codex/hooks.json) that, like Claude Code's, runs a command and passes JSON
// on stdin including transcript_path / cwd / session_id / model — but NOT token
// usage. So we read the referenced rollout JSONL for tokens (see transcript.mjs).
//
// Implements the same provider interface as the Claude provider.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../../lib/paths.mjs";
import { buildTurns as buildCodexTurns } from "./transcript.mjs";
import { applyRemoteRates } from "./pricing.mjs";
import { refreshPricing as refreshRemote } from "./remote-pricing.mjs";

export const id = "codex";
export const displayName = "OpenAI Codex";

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
const HOOKS_FILE = path.join(CODEX_HOME, "hooks.json");
const MARKER = "ai-usage-inspector";
// Begin/end fences let uninstall remove exactly our block and never touch the
// user's own TOML. New installs use hooks.json; these only remain for safely
// migrating installs made by versions <= 2.0.0.
const FENCE_BEGIN = "# >>> ai-usage-inspector (codex) >>>";
const FENCE_END = "# <<< ai-usage-inspector (codex) <<<";

/** Codex is "present" if its home dir exists. */
export function detect() {
  try {
    return fs.existsSync(CODEX_HOME);
  } catch {
    return false;
  }
}

// ---- record-time ----

/** Normalize Codex's Stop-hook stdin JSON into the canonical shape. */
export function normalizePayload(raw) {
  let payload = {};
  try {
    payload = JSON.parse(raw) || {};
  } catch {}
  return {
    sessionId: payload.session_id || payload.sessionId || null,
    cwd: payload.cwd || process.cwd(),
    transcriptPath: payload.transcript_path || payload.transcriptPath || null,
    opts: {
      model: payload.model || null,
      sessionId: payload.session_id || payload.sessionId || null,
      cwd: payload.cwd || null,
      permissionMode: payload.permission_mode || payload.permissionMode || null,
    },
  };
}

/**
 * All rollout files on disk (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl),
 * for backfill/sync. Each entry: { transcriptPath, opts } — cwd/session come
 * from the rollout's own session_meta, so opts stays empty. `sinceMs` skips
 * files not modified since then.
 */
export function discoverTranscripts({ sinceMs = 0 } = {}) {
  const root = path.join(CODEX_HOME, "sessions");
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(p, depth + 1); // sessions/YYYY/MM/DD
      } else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          if (fs.statSync(p).mtimeMs >= sinceMs) out.push({ transcriptPath: p, opts: {} });
        } catch {}
      }
    }
  };
  walk(root, 0);
  return out;
}

export function buildTurns(transcriptPath, opts = {}) {
  return buildCodexTurns(transcriptPath, opts);
}

// ---- install-time (Stop hook in ~/.codex/hooks.json) ----

function hookCmd(appPath) {
  return `node "${path.join(appPath, "src", "record.mjs")}" --provider ${id}`;
}

function isOurHook(group) {
  const text = JSON.stringify(group);
  return text.includes(MARKER) || (text.includes("record.mjs") && text.includes("--provider codex"));
}

function readHooks() {
  if (!fs.existsSync(HOOKS_FILE)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(HOOKS_FILE, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root must be a JSON object");
    }
    return value;
  } catch (e) {
    throw new Error(`cannot update invalid ${HOOKS_FILE}: ${e.message}`);
  }
}

function writeHooks(value) {
  fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
  fs.writeFileSync(HOOKS_FILE, JSON.stringify(value, null, 2) + "\n");
}

// Old versions fenced an inline TOML hook. Codex or the desktop app may append
// unrelated settings before the closing comment, so deleting the whole fenced
// range can destroy user config. Remove only our exact hook stanza and marker
// comments, leaving every unrelated line in place.
function removeLegacyConfigHook() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  const drop = new Set();
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === FENCE_BEGIN || line.trim() === FENCE_END) drop.add(i);
    if (!line.includes(MARKER) || !line.includes("--provider codex")) continue;
    drop.add(i);
    removed++;
    const expected = [
      /^type\s*=\s*["']command["']\s*$/,
      /^\[\[hooks\.Stop\.hooks\]\]\s*$/,
      /^\[\[hooks\.Stop\]\]\s*$/,
    ];
    let at = i - 1;
    for (const re of expected) {
      while (at >= 0 && !lines[at].trim()) at--;
      if (at >= 0 && re.test(lines[at].trim())) drop.add(at--);
      else break;
    }
  }
  if (drop.size) {
    const next = lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(CONFIG_FILE, next.replace(/^\n+/, "").replace(/\n*$/, "\n"));
  }
  return removed;
}

export function install({ appPath }) {
  const s = readHooks();
  s.hooks = s.hooks && typeof s.hooks === "object" && !Array.isArray(s.hooks) ? s.hooks : {};
  s.hooks.Stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
  const exists = s.hooks.Stop.some(isOurHook);
  if (!exists) {
    s.hooks.Stop.push({ hooks: [{ type: "command", command: hookCmd(appPath) }] });
    writeHooks(s);
  }
  const migrated = removeLegacyConfigHook();
  return {
    file: HOOKS_FILE,
    action: exists ? "exists" : "added",
    migrated,
    trustRequired: true,
  };
}

export function uninstall() {
  const s = readHooks();
  if (!s.hooks || !Array.isArray(s.hooks.Stop)) {
    const migrated = removeLegacyConfigHook();
    return { file: HOOKS_FILE, removed: migrated };
  }
  const before = s.hooks.Stop.length;
  s.hooks.Stop = s.hooks.Stop.filter((group) => !isOurHook(group));
  const removed = before - s.hooks.Stop.length;
  if (s.hooks.Stop.length === 0) delete s.hooks.Stop;
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  if (removed) writeHooks(s);
  const migrated = removeLegacyConfigHook();
  return { file: HOOKS_FILE, removed: removed + migrated };
}

// Dynamic OpenAI pricing via models.dev (open JSON dataset); built-in table
// is the fallback. See remote-pricing.mjs.
export async function refreshPricing() {
  const r = await refreshRemote();
  if (r && r.rates) applyRemoteRates(r.rates);
  return r;
}
