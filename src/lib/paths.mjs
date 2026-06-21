// Path + filesystem-layout helpers for the usage tracker.
// Zero dependencies — node:os / node:path only.
import os from "node:os";
import path from "node:path";

/** Home dir of the current user. */
export const HOME = os.homedir();

/**
 * Shared data dir. All workspaces write here, so concurrent Claude Code
 * sessions across projects land in one place. Override with CLAUDE_USAGE_DIR.
 */
export function dataDir() {
  return (
    process.env.CLAUDE_USAGE_DIR ||
    path.join(HOME, ".claude", "usage-tracker", "data")
  );
}

/** Per-workspace ndjson files live here. */
export function workspacesDir() {
  return path.join(dataDir(), "workspaces");
}

/**
 * Encode a cwd the way Claude Code encodes project folders:
 * ":" and path separators become "-". e.g. "K:\Projects\Tracker" -> "K--Projects-Tracker"
 */
export function encCwd(cwd) {
  // Each separator char maps to one "-" (Claude's own scheme): K:\Projects -> K--Projects
  return String(cwd || "").replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
}

/** Absolute path of the workspace ndjson file for a given cwd. */
export function workspaceFile(cwd) {
  return path.join(workspacesDir(), `${encCwd(cwd) || "unknown"}.ndjson`);
}

/** A short, human label for a workspace (last path segment of the cwd). */
export function workspaceLabel(cwd) {
  const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || cwd || "unknown";
}

/** Claude Code's global + project settings files (read for effortLevel). */
export function settingsCandidates(cwd) {
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

/**
 * Derive the transcript path from cwd + sessionId when the hook payload
 * doesn't supply transcript_path.
 */
export function deriveTranscriptPath(cwd, sessionId) {
  return path.join(HOME, ".claude", "projects", encCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * Given a main transcript path (.../<sessionId>.jsonl), return the directory
 * holding that session's subagent transcripts (.../<sessionId>/subagents).
 */
export function subagentsDir(transcriptPath) {
  if (!transcriptPath) return null;
  const dir = path.dirname(transcriptPath);
  const base = path.basename(transcriptPath, ".jsonl");
  return path.join(dir, base, "subagents");
}
