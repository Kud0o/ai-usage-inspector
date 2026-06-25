// Global tracker config: which projects are tracked + which field groups are
// stored. Lives at ~/.claude/usage-tracker/config.json (a sibling of app/, so a
// re-install never wipes it).
//
// IMPORTANT: this file must stay SELF-CONTAINED — it imports only node builtins
// and inlines its own `encCwd`. install.mjs copies it next to the viewer
// (app/viewer/config.mjs) so the per-project bundle, which ships viewer/ ONLY,
// can import it too. Don't add local imports here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The eight selectable field groups (all on by default).
export const FIELD_GROUPS = ["text", "tokens", "cost", "context", "timing", "skills", "counts", "meta"];

export function globalConfigPath() {
  return path.join(os.homedir(), ".claude", "usage-tracker", "config.json");
}

// Keep identical to paths.mjs `encCwd` — duplicated so this file stays importable
// from the standalone viewer bundle. ":" and path separators become "-".
export function encCwd(cwd) {
  return String(cwd || "").replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
}

export function defaultConfig() {
  const fields = {};
  for (const g of FIELD_GROUPS) fields[g] = true;
  return {
    schema: 1,
    tracking: { mode: "allowlist", grandfatherExisting: true, projects: {} },
    fields,
  };
}

// Load + normalize. Never throws; falls back to defaults, backfills any missing
// group to `true` (forward-compat for groups added later).
export function loadConfig() {
  const def = defaultConfig();
  let c;
  try {
    c = JSON.parse(fs.readFileSync(globalConfigPath(), "utf8"));
  } catch {
    return def;
  }
  if (!c || typeof c !== "object") return def;
  c.tracking = c.tracking && typeof c.tracking === "object" ? c.tracking : def.tracking;
  if (!c.tracking.mode) c.tracking.mode = "allowlist";
  if (typeof c.tracking.grandfatherExisting !== "boolean") c.tracking.grandfatherExisting = true;
  if (!c.tracking.projects || typeof c.tracking.projects !== "object") c.tracking.projects = {};
  c.fields = c.fields && typeof c.fields === "object" ? c.fields : {};
  for (const g of FIELD_GROUPS) if (typeof c.fields[g] !== "boolean") c.fields[g] = true;
  if (typeof c.schema !== "number") c.schema = 1;
  return c;
}

export function saveConfig(next) {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, file); // atomic on Windows + POSIX
}

// ---- cross-process lock (same algorithm as src/lib/store.mjs, inlined) ----
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read-modify-write the global config under an exclusive lock so the hook
// (grandfather add) and the viewer (settings POST) can't clobber each other.
// Returns the saved config, or null if the lock couldn't be taken (caller treats
// as best-effort — the next attempt self-heals).
export async function mutateConfig(fn) {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (true) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) return null;
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    const cfg = loadConfig();
    fn(cfg);
    saveConfig(cfg);
    return cfg;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.rmSync(lock, { force: true });
    } catch {}
  }
}

// Is this project tracked? `dataFileExists` lets the caller pass whether the
// workspace already has recorded data (for lazy grandfathering).
export function isTracked(cfg, cwd, dataFileExists) {
  const entry = cfg.tracking.projects[encCwd(cwd)];
  if (entry) return { tracked: entry.enabled !== false, grandfather: false };
  if (cfg.tracking.grandfatherExisting && dataFileExists) return { tracked: true, grandfather: true };
  return { tracked: false, grandfather: false };
}

// Effective stored-field flags for a project = global defaults + project override.
export function effectiveFields(cfg, cwd) {
  const entry = cfg.tracking.projects[encCwd(cwd)];
  return { ...cfg.fields, ...(entry && entry.fields ? entry.fields : {}) };
}

// Map each field group to the record keys it controls. Core keys
// (id, sessionId, cwd, workspace, ts, model, permissionMode, schema) are never
// stripped — the viewer needs them for identity, grouping, filters and axes.
const GROUP_KEYS = {
  text: ["prompt", "response"], // promptChars/responseChars are sizes, kept
  tokens: ["usage"],
  cost: ["cost"],
  context: ["contextTokens", "contextMax", "contextFillPct"],
  timing: ["durationMs", "endTs", "firstResponseMs"],
  skills: ["skills"],
  counts: ["counts"],
  meta: ["slug", "gitBranch", "cliVersion", "entrypoint", "serviceTier", "speed", "effortLevel"],
};

// Return a shallow clone of `record` with disabled groups' keys removed.
export function applyFieldSelection(record, fields) {
  const out = { ...record };
  for (const g of FIELD_GROUPS) {
    if (fields[g] === false) for (const k of GROUP_KEYS[g]) delete out[k];
  }
  return out;
}
