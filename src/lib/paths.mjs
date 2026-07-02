// Path + filesystem-layout helpers — provider-neutral.
// Zero dependencies — node:os / node:path only.
// (Provider-specific paths — e.g. where Claude or Codex store transcripts and
// settings — live in each src/providers/<id>/index.mjs.)
import os from "node:os";
import path from "node:path";

/** Home dir of the current user. */
export const HOME = os.homedir();

// Folder created inside each tracked project to hold its records.
export const PROJECT_DIRNAME = ".ai-usage";

/**
 * Encode a cwd into a flat, filesystem-safe token used for aggregate-mode
 * filenames: ":" and path separators become "-".
 * e.g. "K:\Projects\Tracker" -> "K--Projects-Tracker".
 * (Matches Claude Code's own project-folder encoding, which the Claude provider
 * also relies on to locate transcripts.)
 */
export function encCwd(cwd) {
  return String(cwd || "").replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Where a workspace's records are written.
 * Default: inside the project itself — <cwd>/.ai-usage/usage.ndjson.
 * Set AI_USAGE_DIR to instead collect every project into one flat dir
 * (one <encoded-cwd>.ndjson per project) for a combined dashboard.
 */
export function workspaceFile(cwd) {
  const override = process.env.AI_USAGE_DIR;
  if (override) return path.join(override, `${encCwd(cwd) || "unknown"}.ndjson`);
  return path.join(cwd, PROJECT_DIRNAME, "usage.ndjson");
}

/** A short, human label for a workspace (last path segment of the cwd). */
export function workspaceLabel(cwd) {
  const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || cwd || "unknown";
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
