// Shared helpers for providers that read a VS Code extension's task store.
// Zero third-party deps (node builtins only). Cline, Roo Code, and Kilo Code all
// persist tasks under <VSCodeUserDir>/globalStorage/<extId>/tasks/<taskId>/, and
// the same extensions also run inside VS Code forks (Cursor, Windsurf, VSCodium),
// so we scan every product variant that exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Product folder names for VS Code + the common forks that run these extensions.
const PRODUCTS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

/** Per-OS base dir that holds each product's own data folder. */
function productBase() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(home, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  return path.join(home, ".config");
}

/** Every `<product>/User` dir that exists on this machine. */
export function vscodeUserDirs() {
  const base = productBase();
  const out = [];
  for (const p of PRODUCTS) {
    const dir = path.join(base, p, "User");
    try {
      if (fs.existsSync(dir)) out.push(dir);
    } catch {}
  }
  return out;
}

/**
 * Every task dir for one extension id across all product variants.
 * Returns [{ taskId, dir, mtimeMs }] — mtimeMs is the ui_messages.json mtime
 * (falls back to the task dir mtime), used for `sinceMs` filtering.
 */
export function listExtensionTasks(extId, { sinceMs = 0 } = {}) {
  const out = [];
  for (const userDir of vscodeUserDirs()) {
    const tasksRoot = path.join(userDir, "globalStorage", extId, "tasks");
    let ents = [];
    try {
      ents = fs.readdirSync(tasksRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(tasksRoot, e.name);
      let mtimeMs = 0;
      try {
        const f = path.join(dir, "ui_messages.json");
        mtimeMs = fs.statSync(fs.existsSync(f) ? f : dir).mtimeMs;
      } catch {}
      if (sinceMs > 0 && !(mtimeMs >= sinceMs)) continue;
      out.push({ taskId: e.name, dir, mtimeMs });
    }
  }
  return out;
}

/** Parse+return JSON from a file, or null on any failure. */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
