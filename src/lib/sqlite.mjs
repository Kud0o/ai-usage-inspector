// Shared node:sqlite helpers for scan-based providers that read another tool's
// SQLite store (Cursor, OpenCode, ...). Zero third-party deps: uses node:sqlite,
// which ships with Node >= 22.5. The rest of the tool runs on Node >= 18, so
// every entry point degrades gracefully when node:sqlite is missing — these
// helpers return null/false rather than throwing.

/** true when the host Node is new enough to have node:sqlite (>= 22.5.0). */
export function nodeSupported() {
  const [maj, min] = String(process.versions.node).split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 5);
}

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

/** true when node:sqlite could actually be imported (Node >= 22.5). */
export async function available() {
  return !!(await sqlite());
}

/**
 * Open a SQLite file read-only. Returns a DatabaseSync handle, or null when
 * node:sqlite is unavailable or the file is missing / locked / corrupt — the
 * caller degrades to empty results.
 */
export async function openRO(file) {
  const mod = await sqlite();
  if (!mod) return null;
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(file)) return null;
    return new mod.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

/** Coerce a TEXT or BLOB column value to a string ("" when not coercible). */
export function toText(v) {
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

/** Parse a TEXT/BLOB column value as JSON, or null on any failure. */
export function parseJson(v) {
  try {
    return JSON.parse(toText(v));
  } catch {
    return null;
  }
}
