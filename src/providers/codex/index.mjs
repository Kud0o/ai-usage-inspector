// OpenAI Codex CLI provider. Codex exposes a Stop hook (configured in
// ~/.codex/config.toml) that, like Claude Code's, runs a command and passes JSON
// on stdin including transcript_path / cwd / session_id / model — but NOT token
// usage. So we read the referenced rollout JSONL for tokens (see transcript.mjs).
//
// Implements the same provider interface as the Claude provider.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../../lib/paths.mjs";
import { buildTurns as buildCodexTurns } from "./transcript.mjs";

export const id = "codex";
export const displayName = "OpenAI Codex";

const CONFIG_FILE = path.join(HOME, ".codex", "config.toml");
// Begin/end fences let uninstall remove exactly our block and never touch the
// user's own TOML.
const FENCE_BEGIN = "# >>> ai-usage-inspector (codex) >>>";
const FENCE_END = "# <<< ai-usage-inspector (codex) <<<";

/** Codex is "present" if its home dir exists. */
export function detect() {
  try {
    return fs.existsSync(path.join(HOME, ".codex"));
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
    },
  };
}

export function buildTurns(transcriptPath, opts = {}) {
  return buildCodexTurns(transcriptPath, opts);
}

// ---- install-time (Stop hook in ~/.codex/config.toml) ----

function hookBlock(appPath) {
  // Single-quoted TOML literal string keeps Windows backslashes intact.
  const command = `node "${path.join(appPath, "src", "record.mjs")}" --provider ${id}`;
  return [
    FENCE_BEGIN,
    "[[hooks.Stop]]",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = '${command}'`,
    FENCE_END,
    "",
  ].join("\n");
}

export function install({ appPath }) {
  let text = "";
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {}
  if (text.includes(FENCE_BEGIN)) return { file: CONFIG_FILE, action: "exists" };
  const sep = text && !text.endsWith("\n") ? "\n\n" : text ? "\n" : "";
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, text + sep + hookBlock(appPath));
  return { file: CONFIG_FILE, action: "added" };
}

export function uninstall() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return { file: CONFIG_FILE, removed: 0 };
  }
  // Remove each fenced block (begin..end inclusive, plus a trailing blank line).
  const re = new RegExp(
    `\\n?${escapeRe(FENCE_BEGIN)}[\\s\\S]*?${escapeRe(FENCE_END)}\\n?`,
    "g",
  );
  const next = text.replace(re, "\n");
  const removed = next === text ? 0 : 1;
  if (removed) fs.writeFileSync(CONFIG_FILE, next.replace(/\n{3,}/g, "\n\n"));
  return { file: CONFIG_FILE, removed };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// OpenAI has no machine-readable pricing source; rates are the built-in table.
export async function refreshPricing() {
  return { status: "no-source" };
}
