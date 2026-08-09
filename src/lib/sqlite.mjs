// Shared resilient node:sqlite helpers for Cursor/OpenCode. Zero deps.
import fs from "node:fs";

const BUSY_DELAYS_MS = [10, 25, 50];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** true when host Node can import node:sqlite (>= 22.5.0). */
export function nodeSupported() {
  const [maj, min] = String(process.versions.node).split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 5);
}

let sqliteMod = null;
async function sqlite() {
  if (sqliteMod === null) {
    try { sqliteMod = await import("node:sqlite"); } catch { sqliteMod = false; }
  }
  return sqliteMod || null;
}

export async function available() {
  return !!(await sqlite());
}

export function isSqliteBusy(error) {
  const code = String(error && error.code || "");
  const message = String(error && error.message || "");
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /SQLITE_(?:BUSY|LOCKED)|database(?: table)? is locked/i.test(message);
}

/** Retry only SQLITE_BUSY/locked; all other failures pass through immediately. */
export async function withSqliteRetry(fn, {
  delaysMs = BUSY_DELAYS_MS,
  sleepFn = sleep,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= delaysMs.length) throw error;
      await sleepFn(delaysMs[attempt]);
    }
  }
}

export class SqliteScanError extends Error {
  constructor(status, detail) {
    super(detail || status);
    this.name = "SqliteScanError";
    this.scanStatus = status;
  }
}

export function sqliteScanError(status, detail) {
  return new SqliteScanError(status, detail);
}

function failure(error) {
  return isSqliteBusy(error)
    ? { status: "locked", detail: String(error && error.message || "SQLite database locked") }
    : { status: "unsupported-schema", detail: String(error && error.message || "SQLite query failed") };
}

/** Query helpers preserve locked-vs-schema failure instead of returning []. */
export async function queryAll(db, sql, ...args) {
  try {
    return { status: "ok", rows: await withSqliteRetry(() => db.prepare(sql).all(...args)) };
  } catch (error) {
    return { ...failure(error), rows: [] };
  }
}

export async function queryGet(db, sql, ...args) {
  try {
    return { status: "ok", row: await withSqliteRetry(() => db.prepare(sql).get(...args)) || null };
  } catch (error) {
    return { ...failure(error), row: null };
  }
}

function quotedIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Validate required tables/columns before provider queries run. */
export async function inspectSchema(db, schema = {}) {
  for (const [table, requiredColumns] of Object.entries(schema)) {
    const tableRow = await queryGet(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      table,
    );
    if (tableRow.status !== "ok") return tableRow;
    if (!tableRow.row) return { status: "unsupported-schema", detail: `missing table: ${table}` };

    const columnsResult = await queryAll(db, `PRAGMA table_info(${quotedIdentifier(table)})`);
    if (columnsResult.status !== "ok") return columnsResult;
    const columns = new Set(columnsResult.rows.map((row) => String(row.name)));
    const missing = (requiredColumns || []).filter((column) => !columns.has(column));
    if (missing.length) {
      return { status: "unsupported-schema", detail: `missing ${table} column(s): ${missing.join(", ")}` };
    }
  }
  return { status: "ok" };
}

/** Open read-only + introspect. Status: ok|locked|unsupported-schema|missing. */
export async function openROStatus(file, { schema = {} } = {}) {
  const mod = await sqlite();
  if (!mod) return { status: "missing", db: null, detail: "node:sqlite unavailable" };
  if (!fs.existsSync(file)) return { status: "missing", db: null, detail: `missing database: ${file}` };

  let db = null;
  try {
    db = await withSqliteRetry(() => new mod.DatabaseSync(file, { readOnly: true }));
  } catch (error) {
    return { ...failure(error), db: null };
  }

  const checked = await inspectSchema(db, schema);
  if (checked.status !== "ok") {
    try { db.close(); } catch {}
    return { ...checked, db: null };
  }
  return { status: "ok", db };
}

/** Backward-compatible handle-only open. Prefer openROStatus in scan providers. */
export async function openRO(file) {
  const result = await openROStatus(file);
  return result.db;
}

export function toText(value) {
  if (typeof value === "string") return value;
  if (value && (value instanceof Uint8Array || Buffer.isBuffer(value))) {
    try { return Buffer.from(value).toString("utf8"); } catch { return ""; }
  }
  return "";
}

export function parseJson(value) {
  try { return JSON.parse(toText(value)); } catch { return null; }
}
