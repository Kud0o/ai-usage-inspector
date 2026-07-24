import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The OpenCode provider reads SQLite via node:sqlite (Node >= 22.5). Skip the
// whole file on older Node so the suite stays green there, exactly as the
// provider degrades at runtime.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const needsSqlite = { skip: DatabaseSync ? false : "node:sqlite unavailable (Node < 22.5)" };

// Build a throwaway <dir>/opencode/opencode.db and point XDG_DATA_HOME at <dir>
// so the provider resolves it. Returns the temp dir (caller restores env).
function makeDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-opencode-"));
  const dbDir = path.join(dir, "opencode");
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "opencode.db"));
  db.exec(`
    CREATE TABLE session (id TEXT, directory TEXT, model TEXT, title TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE session_input (session_id TEXT, prompt TEXT, time_created INTEGER);
  `);
  for (const s of rows.sessions || []) db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    s.id, s.directory, s.model, s.title, s.cost, s.tokens_input, s.tokens_output,
    s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated);
  for (const m of rows.messages || []) db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(m.id, m.session_id, m.time_created, JSON.stringify(m.data));
  for (const p of rows.parts || []) db.prepare("INSERT INTO part VALUES (?,?,?,?)").run(p.message_id, p.session_id, p.time_created, JSON.stringify(p.data));
  db.close();
  return dir;
}

// Import the provider fresh with XDG_DATA_HOME pointed at `dir`.
async function withDataDir(dir, fn) {
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try {
    const mod = await import(`../src/providers/opencode/index.mjs?t=${Date.now()}${Math.random()}`);
    return await fn(mod);
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
}

const asst = (m, cost, tok) => ({ role: "assistant", modelID: m, cost, tokens: tok });
const textPart = (mid, sid, ts, t) => ({ message_id: mid, session_id: sid, time_created: ts, data: { type: "text", text: t } });

test("OpenCode parses per-message turns with exact tokens and cost", needsSqlite, async () => {
  const t0 = Date.parse("2026-07-23T10:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesA", directory: "K:/repo", model: '{"id":"claude-x"}', title: "A", cost: 0.05,
      tokens_input: 2000, tokens_output: 400, tokens_reasoning: 100, tokens_cache_read: 600, tokens_cache_write: 40,
      time_created: t0, time_updated: t0 + 60000 }],
    messages: [
      { id: "u1", session_id: "sesA", time_created: t0 + 1000, data: { role: "user" } },
      { id: "a1", session_id: "sesA", time_created: t0 + 2000, data: asst("claude-sonnet-4", 0.02, { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 20 } }) },
      { id: "u2", session_id: "sesA", time_created: t0 + 40000, data: { role: "user" } },
      { id: "a2", session_id: "sesA", time_created: t0 + 41000, data: asst("claude-sonnet-4", 0.03, { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 20 } }) },
    ],
    parts: [
      textPart("u1", "sesA", t0 + 1000, "first prompt"),
      textPart("a1", "sesA", t0 + 2000, "first answer"),
      { message_id: "a1", session_id: "sesA", time_created: t0 + 2500, data: { type: "tool", tool: "read" } },
      textPart("u2", "sesA", t0 + 40000, "second prompt"),
      textPart("a2", "sesA", t0 + 41000, "second answer"),
    ],
  });
  try {
    await withDataDir(dir, async (m) => {
      assert.equal(m.detect(), true);
      const disc = await m.discoverTranscripts({ sinceMs: 0 });
      assert.equal(disc.length, 1);
      const turns = await m.buildTurns(disc[0].transcriptPath, disc[0].opts);
      assert.equal(turns.length, 2);
      assert.deepEqual(turns.map((t) => [t.prompt, t.response, t.model]), [
        ["first prompt", "first answer", "claude-sonnet-4"],
        ["second prompt", "second answer", "claude-sonnet-4"],
      ]);
      assert.equal(turns[0].provider, "opencode");
      assert.equal(turns[0].cwd, "K:/repo");
      assert.equal(turns[0].cost.total, 0.02);
      assert.equal(turns[0].counts.toolCalls, 1);
      assert.deepEqual(turns[0].usage, { input: 1000, output: 200, reasoning: 50, cacheCreate: 20, cacheRead: 300, cacheCreate1h: 0, cacheCreate5m: 0, webSearch: 0, webFetch: 0 });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode falls back to a session-level record when messages lack usage", needsSqlite, async () => {
  const t0 = Date.parse("2026-07-23T09:00:00Z");
  const dir = makeDb({
    // model stored as a JSON string (as OpenCode really does) -> must be cleaned to the id
    sessions: [{ id: "sesB", directory: "K:/legacy", model: '{"id":"gemini-3-pro","providerID":"opencode"}', title: "Legacy chat", cost: 0.12,
      tokens_input: 5000, tokens_output: 800, tokens_reasoning: 0, tokens_cache_read: 1200, tokens_cache_write: 0,
      time_created: t0, time_updated: t0 + 50000 }],
    // no messages / parts at all
  });
  try {
    await withDataDir(dir, async (m) => {
      const disc = await m.discoverTranscripts({ sinceMs: 0 });
      const turns = await m.buildTurns(disc[0].transcriptPath, disc[0].opts);
      assert.equal(turns.length, 1);
      const r = turns[0];
      assert.equal(r.id, "sesB:0");
      assert.equal(r.model, "gemini-3-pro");
      assert.equal(r.prompt, "Legacy chat");
      assert.equal(r.cost.total, 0.12);
      assert.equal(r.usage.input, 5000);
      assert.equal(r.usage.cacheRead, 1200);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode plugin install/uninstall is idempotent and marker-scoped", needsSqlite, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-opencode-home-"));
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const m = await import(`../src/providers/opencode/index.mjs?t=${Date.now()}h`);
    const pluginFile = path.join(home, ".config", "opencode", "plugins", "ai-usage-inspector.js");

    const r1 = m.install({ appPath: path.join(home, "app") });
    assert.equal(r1.action, "added");
    assert.equal(fs.existsSync(pluginFile), true);
    const body = fs.readFileSync(pluginFile, "utf8");
    assert.match(body, /session\.idle/);
    assert.match(body, /--provider/);
    assert.match(body, /ai-usage-inspector/);

    assert.equal(m.install({ appPath: path.join(home, "app") }).action, "exists");

    const u = m.uninstall();
    assert.equal(u.removed, 1);
    assert.equal(fs.existsSync(pluginFile), false);
    assert.equal(m.uninstall().removed, 0);
  } finally {
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
