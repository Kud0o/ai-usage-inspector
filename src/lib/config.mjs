// Tracking + stored-field config.
//
// Model: each project owns its config in <project>/.ai-usage/config.json
// (the same file the viewer uses for title/port/ui). On a project's first sight
// it is SEEDED from the global defaults template at ~/.ai-usage-inspector/
// config.json, then it is authoritative for that project. Aggregate mode
// (AI_USAGE_DIR) has no per-project folder, so the global defaults govern.
//
// IMPORTANT: this file must stay SELF-CONTAINED — node builtins only, inline
// `encCwd`. install.mjs copies it next to the viewer (app/viewer/config.mjs) so
// the per-project bundle (which ships viewer/ ONLY) can import it too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The eight selectable field groups (all on by default).
export const FIELD_GROUPS = ["text", "tokens", "cost", "context", "timing", "skills", "counts", "meta"];

export function globalConfigPath() {
  return path.join(os.homedir(), ".ai-usage-inspector", "config.json");
}

// Keep identical to paths.mjs `encCwd` (duplicated to stay bundle-importable).
export function encCwd(cwd) {
  return String(cwd || "").replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
}

function defaultFields() {
  const f = {};
  for (const g of FIELD_GROUPS) f[g] = true;
  return f;
}
function loadJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// The global file is a DEFAULTS TEMPLATE only: { enabledDefault, fields }.
// Old-shape files (with tracking.projects) are ignored — only fields are read.
export function loadGlobalDefaults() {
  const c = loadJson(globalConfigPath());
  const fields = defaultFields();
  if (c.fields && typeof c.fields === "object") {
    for (const g of FIELD_GROUPS) if (typeof c.fields[g] === "boolean") fields[g] = c.fields[g];
  }
  const enabledDefault = typeof c.enabledDefault === "boolean" ? c.enabledDefault : true;
  return { schema: 2, enabledDefault, fields };
}
export function defaultGlobalConfig() {
  return { schema: 2, enabledDefault: true, fields: defaultFields() };
}

// <cwd>/.ai-usage/config.json — or null in aggregate mode (no per-project folder).
export function projectConfigPath(cwd) {
  if (process.env.AI_USAGE_DIR) return null;
  return path.join(cwd, ".ai-usage", "config.json");
}

export function isEnabled(cfg) {
  return !(cfg && cfg.tracking) || cfg.tracking.enabled !== false;
}

// Ensure a project has tracking+fields, seeding from the global defaults the
// first time (merged into any existing {title,port,ui} without clobbering).
// Returns the effective config. In aggregate mode returns the global defaults
// (no file written).
export async function ensureProjectConfig(cwd) {
  const def = loadGlobalDefaults();
  const file = projectConfigPath(cwd);
  if (!file) return { tracking: { enabled: def.enabledDefault }, fields: { ...def.fields } };

  const cur = loadJson(file);
  const complete =
    cur.tracking && typeof cur.tracking.enabled === "boolean" &&
    cur.fields && FIELD_GROUPS.every((g) => typeof cur.fields[g] === "boolean");
  if (complete) return cur;

  const next = await mutateFile(file, (c) => {
    c.tracking = c.tracking && typeof c.tracking === "object" ? c.tracking : {};
    if (typeof c.tracking.enabled !== "boolean") c.tracking.enabled = def.enabledDefault;
    c.fields = c.fields && typeof c.fields === "object" ? c.fields : {};
    for (const g of FIELD_GROUPS) if (typeof c.fields[g] !== "boolean") c.fields[g] = def.fields[g];
  });
  if (next) return next;
  // Lock unavailable — fall back to an in-memory seed so this run still works.
  return {
    ...cur,
    tracking: { enabled: typeof (cur.tracking || {}).enabled === "boolean" ? cur.tracking.enabled : def.enabledDefault, ...(cur.tracking || {}) },
    fields: { ...def.fields, ...(cur.fields || {}) },
  };
}

// ---- cross-process lock (same algorithm as src/lib/store.mjs, inlined) ----
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read-modify-write any JSON config file under an exclusive lock. Returns the
// saved object, or null if the lock couldn't be taken (caller best-effort).
export async function mutateFile(file, fn) {
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
    const obj = loadJson(file);
    fn(obj);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return obj;
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(lock, { force: true }); } catch {}
  }
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
    if (fields && fields[g] === false) for (const k of GROUP_KEYS[g]) delete out[k];
  }
  return out;
}
