// SQLite access + workspace enumeration for the Cursor provider.
//
// Cursor (the AI editor) stores conversations in SQLite:
//   - global DB   <CursorData>/User/globalStorage/state.vscdb
//       table cursorDiskKV(key, value):
//         composerData:<composerId>            conversation meta (JSON)
//         bubbleId:<composerId>:<bubbleId>     one message (JSON)
//   - per-workspace DB  <CursorData>/User/workspaceStorage/<hash>/state.vscdb
//       table ItemTable(key, value): key 'composer.composerData' lists that
//       workspace's composers
//   - <hash>/workspace.json maps the hash to the real project folder.
//
// Reads use node:sqlite (Node >= 22.5) in readOnly mode. The module degrades
// gracefully: on older Node (no node:sqlite) or a locked/absent DB every
// function returns empty results instead of throwing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let sqliteMod = null; // null = untried, false = unavailable, module = loaded
async function sqlite() {
  if (sqliteMod === null) {
    try {
      sqliteMod = await import("node:sqlite");
    } catch {
      sqliteMod = false;
    }
  }
  return sqliteMod || null;
}

/** true when node:sqlite exists (Node >= 22.5). */
export async function available() {
  return !!(await sqlite());
}

/** Cursor's per-OS data directory. */
export function cursorDataDir() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Cursor",
    );
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor");
  }
  return path.join(home, ".config", "Cursor");
}

export function globalDbPath() {
  return path.join(cursorDataDir(), "User", "globalStorage", "state.vscdb");
}

async function openRO(file) {
  const mod = await sqlite();
  if (!mod) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return new mod.DatabaseSync(file, { readOnly: true });
  } catch {
    return null; // locked / corrupt / permission — caller degrades
  }
}

function toText(v) {
  if (typeof v === "string") return v;
  if (v && (v instanceof Uint8Array || Buffer.isBuffer(v))) {
    try {
      return Buffer.from(v).toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

function parseJson(v) {
  try {
    return JSON.parse(toText(v));
  } catch {
    return null;
  }
}

/** "file:///k%3A/Projects/Foo" -> "k:/Projects/Foo" (Windows drive handled). */
export function folderUriToPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  try {
    let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
    // Windows: "/k:/Projects/Foo" -> "k:/Projects/Foo"
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return null;
  }
}

/** [{ hash, cwd, dbPath }] for every workspace with a resolvable folder. */
export async function listWorkspaces() {
  const root = path.join(cursorDataDir(), "User", "workspaceStorage");
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "workspace.json"), "utf8"));
    } catch {
      continue;
    }
    const cwd = folderUriToPath(meta && meta.folder);
    if (!cwd) continue;
    out.push({ hash: e.name, cwd, dbPath: path.join(dir, "state.vscdb") });
  }
  return out;
}

/**
 * Ordered composer ids for one workspace DB. Accepts the shape variants Cursor
 * has shipped: {allComposers:[{composerId}]}, {composers:[...]}, or a bare array.
 */
export async function listComposerIds(workspaceDbPath) {
  const db = await openRO(workspaceDbPath);
  if (!db) return [];
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("composer.composerData");
    const data = row ? parseJson(row.value) : null;
    if (!data) return [];
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.allComposers)
        ? data.allComposers
        : Array.isArray(data.composers)
          ? data.composers
          : [];
    return list
      .map((c) => (typeof c === "string" ? c : c && (c.composerId || c.id)))
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * { composer, bubbles } for one composer from the GLOBAL db.
 * bubbles = [{ bubbleId, ...bubbleJson }] in rowid (insertion) order.
 */
export async function readComposer(globalDb, composerId) {
  const db = await openRO(globalDb);
  if (!db) return { composer: null, bubbles: [] };
  try {
    const meta = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${composerId}`);
    const composer = meta ? parseJson(meta.value) : null;
    const rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid")
      .all(`bubbleId:${composerId}:%`);
    const bubbles = [];
    for (const r of rows) {
      const b = parseJson(r.value);
      if (!b) continue;
      const bubbleId = String(r.key).split(":")[2] || null;
      bubbles.push({ bubbleId, ...b });
    }
    return { composer, bubbles };
  } catch {
    return { composer: null, bubbles: [] };
  } finally {
    try {
      db.close();
    } catch {}
  }
}
