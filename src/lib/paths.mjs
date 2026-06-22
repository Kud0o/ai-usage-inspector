// Path + filesystem-layout helpers for the usage tracker.
// Zero dependencies — node:os / node:path only.
import os from "node:os";
import path from "node:path";

/** Home dir of the current user. */
export const HOME = os.homedir();

// Folder created inside each tracked project to hold its records.
export const PROJECT_DIRNAME = ".claude-usage";

/**
 * Encode a cwd the way Claude Code encodes project folders:
 * ":" and path separators become "-". e.g. "K:\Projects\Tracker" -> "K--Projects-Tracker"
 */
export function encCwd(cwd) {
  // Each separator char maps to one "-" (Claude's own scheme): K:\Projects -> K--Projects
  return String(cwd || "").replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Where a workspace's records are written.
 * Default: inside the project itself — <cwd>/.claude-usage/usage.ndjson.
 * Set CLAUDE_USAGE_DIR to instead collect every project into one flat dir
 * (one <encoded-cwd>.ndjson per project) for a combined dashboard.
 */
export function workspaceFile(cwd) {
  const override = process.env.CLAUDE_USAGE_DIR;
  if (override) return path.join(override, `${encCwd(cwd) || "unknown"}.ndjson`);
  return path.join(cwd, PROJECT_DIRNAME, "usage.ndjson");
}

/**
 * Directory the viewer reads *.ndjson from.
 * Default: the .claude-usage folder of `baseDir` (or the current working dir).
 * CLAUDE_USAGE_DIR overrides it (aggregate mode).
 */
export function viewerDataDir(baseDir) {
  return process.env.CLAUDE_USAGE_DIR || path.join(baseDir || process.cwd(), PROJECT_DIRNAME);
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
