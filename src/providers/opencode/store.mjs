// SQLite access for the OpenCode provider.
//
// OpenCode (the terminal AI agent, sst/opencode) stores everything in a single
// SQLite DB at <dataDir>/opencode.db. Relevant tables:
//   session        one row per conversation, with AUTHORITATIVE rollups:
//                    cost REAL, tokens_input, tokens_output, tokens_reasoning,
//                    tokens_cache_read, tokens_cache_write, model, agent,
//                    directory, title, time_created, time_updated, project_id
//   message        per-message rows: id, session_id, time_created, data (JSON)
//   part           message parts (text / tool): message_id, session_id, data (JSON)
//   session_input  user prompts: session_id, prompt, time_created
// (session_message is the newer event-sourced ordering table; `message` is the
// classic per-message store and is what we read.)
//
// Reads use the shared node:sqlite helpers (Node >= 22.5) in readOnly mode and
// degrade to empty results on old Node / a locked or absent DB.
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

/** OpenCode's data dir. XDG on every OS (it uses ~/.local/share even on Windows). */
export function opencodeDataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode");
}

export function dbPath() {
  return path.join(opencodeDataDir(), "opencode.db");
}

const SESSION_SCAN_SCHEMA = {
  session: ["id", "directory", "time_created", "time_updated"],
};

const SESSION_DETAIL_SCHEMA = {
  session: ["id", "directory", "model", "title", "cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write", "time_created", "time_updated"],
  message: ["id", "session_id", "time_created", "data"],
  part: ["message_id", "session_id", "time_created", "data"],
  session_input: ["session_id", "prompt", "time_created"],
};

/** Sessions updated at/after `sinceMs` (ms epoch), oldest first. Raw rows. */
export async function scanSessions({ sinceMs = 0 } = {}) {
  const opened = await openROStatus(dbPath(), { schema: SESSION_SCAN_SCHEMA });
  if (opened.status !== "ok") return { ...opened, rows: [] };
  const db = opened.db;
  try {
    const result = await queryAll(
      db,
      "SELECT * FROM session WHERE COALESCE(time_updated, time_created, 0) >= ? ORDER BY COALESCE(time_updated, time_created, 0), rowid",
      Number(sinceMs) || 0,
    );
    return { ...result, rows: result.rows || [] };
  } finally {
    try { db.close(); } catch {}
  }
}

export async function listSessions(options = {}) {
  return (await scanSessions(options)).rows;
}

/**
 * Everything needed to reconstruct one session's turns:
 *   { session, messages:[{id,ts,data}], partsByMsg:Map<msgId,[data]>, inputs:[{prompt,ts}] }
 * `data` fields are parsed JSON (or null). Empty/degraded on any failure.
 */
export async function readSessionStatus(sessionId) {
  const empty = { session: null, messages: [], partsByMsg: new Map(), inputs: [] };
  const opened = await openROStatus(dbPath(), { schema: SESSION_DETAIL_SCHEMA });
  if (opened.status !== "ok") return { ...opened, value: empty };
  const db = opened.db;
  try {
    const sessionResult = await queryGet(db, "SELECT * FROM session WHERE id = ?", sessionId);
    if (sessionResult.status !== "ok") return { ...sessionResult, value: empty };
    const session = sessionResult.row;

    const msgResult = await queryAll(
      db,
      "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY COALESCE(time_created, 0), rowid",
      sessionId,
    );
    if (msgResult.status !== "ok") return { ...msgResult, value: empty };
    const messages = msgResult.rows.map((r) => ({ id: r.id, ts: Number(r.time_created) || 0, data: parseJson(r.data) }));

    const partsByMsg = new Map();
    const partsResult = await queryAll(
      db,
      "SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY COALESCE(time_created, 0), rowid",
      sessionId,
    );
    if (partsResult.status !== "ok") return { ...partsResult, value: empty };
    for (const r of partsResult.rows) {
      const list = partsByMsg.get(r.message_id) || [];
      list.push(parseJson(r.data));
      partsByMsg.set(r.message_id, list);
    }

    const inputsResult = await queryAll(
      db,
      "SELECT prompt, time_created FROM session_input WHERE session_id = ? ORDER BY COALESCE(time_created, 0), rowid",
      sessionId,
    );
    if (inputsResult.status !== "ok") return { ...inputsResult, value: empty };
    const inputs = inputsResult.rows.map((r) => ({ prompt: r.prompt || "", ts: Number(r.time_created) || 0 }));

    return { status: "ok", value: { session, messages, partsByMsg, inputs } };
  } finally {
    try { db.close(); } catch {}
  }
}

export async function readSession(sessionId) {
  const result = await readSessionStatus(sessionId);
  if (result.status !== "ok") throw sqliteScanError(result.status, result.detail);
  return result.value;
}

/** OpenCode is "present" when its data dir (or db) exists. */
export function detect() {
  try {
    return fs.existsSync(dbPath()) || fs.existsSync(opencodeDataDir());
  } catch {
    return false;
  }
}
