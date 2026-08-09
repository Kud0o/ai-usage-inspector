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
import { available, openRO, parseJson } from "../../lib/sqlite.mjs";

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

/** Sessions updated at/after `sinceMs` (ms epoch), oldest first. Raw rows. */
export async function listSessions({ sinceMs = 0 } = {}) {
  const db = await openRO(dbPath());
  if (!db) return [];
  try {
    // time_* columns are ms epoch integers.
    const rows = db
      .prepare(
        "SELECT * FROM session WHERE COALESCE(time_updated, time_created, 0) >= ? ORDER BY COALESCE(time_updated, time_created, 0), rowid",
      )
      .all(Number(sinceMs) || 0);
    return rows;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * Everything needed to reconstruct one session's turns:
 *   { session, messages:[{id,ts,data}], partsByMsg:Map<msgId,[data]>, inputs:[{prompt,ts}] }
 * `data` fields are parsed JSON (or null). Empty/degraded on any failure.
 */
export async function readSession(sessionId) {
  const empty = { session: null, messages: [], partsByMsg: new Map(), inputs: [] };
  const db = await openRO(dbPath());
  if (!db) return empty;
  try {
    const session = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) || null;

    const msgRows = safeAll(
      db,
      "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY COALESCE(time_created, 0), rowid",
      sessionId,
    );
    const messages = msgRows.map((r) => ({ id: r.id, ts: Number(r.time_created) || 0, data: parseJson(r.data) }));

    const partsByMsg = new Map();
    for (const r of safeAll(
      db,
      "SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY COALESCE(time_created, 0), rowid",
      sessionId,
    )) {
      const list = partsByMsg.get(r.message_id) || [];
      list.push(parseJson(r.data));
      partsByMsg.set(r.message_id, list);
    }

    const inputs = safeAll(
      db,
      "SELECT prompt, time_created FROM session_input WHERE session_id = ? ORDER BY COALESCE(time_created, 0), rowid",
      sessionId,
    ).map((r) => ({ prompt: r.prompt || "", ts: Number(r.time_created) || 0 }));

    return { session, messages, partsByMsg, inputs };
  } catch {
    return empty;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// Run a query that may reference a table/column an older OpenCode build lacks;
// return [] instead of throwing so the provider degrades gracefully.
function safeAll(db, sql, ...args) {
  try {
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}

/** OpenCode is "present" when its data dir (or db) exists. */
export function detect() {
  try {
    return fs.existsSync(dbPath()) || fs.existsSync(opencodeDataDir());
  } catch {
    return false;
  }
}
