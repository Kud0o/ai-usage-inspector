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
// function returns empty results instead of throwing. The generic SQLite
// plumbing lives in ../../lib/sqlite.mjs and is shared with other scan-based
// providers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  available,
  openROStatus,
  parseJson,
  queryAll,
  queryGet,
  sqliteScanError,
} from "../../lib/sqlite.mjs";

export { available };

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

const GLOBAL_SCHEMA = { cursorDiskKV: ["key", "value"] };
const WORKSPACE_SCHEMA = { ItemTable: ["key", "value"] };

export async function globalStoreStatus(file = globalDbPath()) {
  const opened = await openROStatus(file, { schema: GLOBAL_SCHEMA });
  if (opened.db) {
    try { opened.db.close(); } catch {}
  }
  return { status: opened.status, detail: opened.detail || null };
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
  return (await listComposerIdsStatus(workspaceDbPath)).ids;
}

export async function listComposerIdsStatus(workspaceDbPath) {
  const opened = await openROStatus(workspaceDbPath, { schema: WORKSPACE_SCHEMA });
  if (opened.status !== "ok") return { status: opened.status, detail: opened.detail, ids: [] };
  const db = opened.db;
  try {
    const queried = await queryGet(db, "SELECT value FROM ItemTable WHERE key = ?", "composer.composerData");
    if (queried.status !== "ok") return { ...queried, ids: [] };
    const row = queried.row;
    const data = row ? parseJson(row.value) : null;
    if (!data) return { status: "ok", ids: [] };
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.allComposers)
        ? data.allComposers
        : Array.isArray(data.composers)
          ? data.composers
          : [];
    const ids = list
      .map((c) => (typeof c === "string" ? c : c && (c.composerId || c.id)))
      .filter(Boolean);
    return { status: "ok", ids };
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Composer meta ONLY (composerData:<id>) from the GLOBAL db — no bubbles.
 * Cheap timestamp/model probe for the discover/rescan filter, which would
 * otherwise pay to load every bubble of every conversation just to read
 * lastUpdatedAt. Returns the parsed composer JSON, or null.
 */
export async function readComposerMeta(globalDb, composerId) {
  const result = await readComposerMetaStatus(globalDb, composerId);
  return result.composer;
}

export async function readComposerMetaStatus(globalDb, composerId) {
  const opened = await openROStatus(globalDb, { schema: GLOBAL_SCHEMA });
  if (opened.status !== "ok") return { status: opened.status, detail: opened.detail, composer: null };
  const db = opened.db;
  try {
    const queried = await queryGet(db, "SELECT value FROM cursorDiskKV WHERE key = ?", `composerData:${composerId}`);
    if (queried.status !== "ok") return { ...queried, composer: null };
    return { status: "ok", composer: queried.row ? parseJson(queried.row.value) : null };
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * { composer, bubbles } for one composer from the GLOBAL db.
 * bubbles = [{ bubbleId, ...bubbleJson }] in rowid (insertion) order.
 */
export async function readComposer(globalDb, composerId) {
  const opened = await openROStatus(globalDb, { schema: GLOBAL_SCHEMA });
  if (opened.status !== "ok") throw sqliteScanError(opened.status, opened.detail);
  const db = opened.db;
  try {
    const metaResult = await queryGet(db, "SELECT value FROM cursorDiskKV WHERE key = ?", `composerData:${composerId}`);
    if (metaResult.status !== "ok") throw sqliteScanError(metaResult.status, metaResult.detail);
    const composer = metaResult.row ? parseJson(metaResult.row.value) : null;
    const rowsResult = await queryAll(
      db,
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid",
      `bubbleId:${composerId}:%`,
    );
    if (rowsResult.status !== "ok") throw sqliteScanError(rowsResult.status, rowsResult.detail);
    const bubbles = [];
    for (const r of rowsResult.rows) {
      const b = parseJson(r.value);
      if (!b) continue;
      const bubbleId = String(r.key).split(":")[2] || null;
      bubbles.push({ bubbleId, ...b });
    }
    return { composer, bubbles };
  } finally {
    try { db.close(); } catch {}
  }
}
