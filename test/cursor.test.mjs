import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Cursor is read out of real SQLite, so these need node:sqlite (Node >= 22.5) —
// the same gate the provider itself degrades on.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const needsSqlite = { skip: DatabaseSync ? false : "node:sqlite unavailable (Node < 22.5)" };

const ENV_KEYS = ["APPDATA", "HOME", "USERPROFILE"];

/**
 * Point Cursor's data dir at a temp tree and populate it the way Cursor does:
 *   User/globalStorage/state.vscdb          cursorDiskKV(key,value)
 *   User/workspaceStorage/<hash>/state.vscdb ItemTable(key,value)
 *   User/workspaceStorage/<hash>/workspace.json
 */
async function fixture(t, { composers = {}, workspaceValue, globalRows } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-cursor-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = root;
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const store = await import("../src/providers/cursor/store.mjs");
  const base = store.cursorDataDir();
  const wsDir = path.join(base, "User", "workspaceStorage", "hash1");
  fs.mkdirSync(path.join(base, "User", "globalStorage"), { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///k%3A/proj" }));

  const wdb = new DatabaseSync(path.join(wsDir, "state.vscdb"));
  wdb.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  wdb.prepare("INSERT INTO ItemTable VALUES (?,?)").run(
    "composer.composerData",
    workspaceValue !== undefined ? workspaceValue : JSON.stringify({ allComposers: Object.keys(composers).map((id) => ({ composerId: id })) }),
  );
  wdb.close();

  const gdb = new DatabaseSync(store.globalDbPath());
  gdb.exec(globalRows === null ? "CREATE TABLE wrong_table (a TEXT)" : "CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
  if (globalRows !== null) {
    const put = gdb.prepare("INSERT INTO cursorDiskKV VALUES (?,?)");
    for (const [id, c] of Object.entries(composers)) {
      put.run(`composerData:${id}`, JSON.stringify(c.meta));
      for (const b of c.bubbles) put.run(`bubbleId:${id}:${b.bubbleId}`, JSON.stringify(b));
    }
  }
  gdb.close();
  return { root, base };
}

const provider = () => import("../src/providers/cursor/index.mjs");

const composer = (bubbles, meta = {}) => ({
  meta: { createdAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_060_000, ...meta },
  bubbles,
});

test("exact per-bubble token usage is used and not marked estimated", needsSqlite, async (t) => {
  await fixture(t, {
    composers: {
      c1: composer([
        { bubbleId: "b1", type: 1, text: "the prompt" },
        {
          bubbleId: "b2",
          type: 2,
          text: "the answer",
          modelType: "claude-4-sonnet",
          tokenUsage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 40 },
        },
      ]),
    },
  });

  const p = await provider();
  const found = await p.discoverTranscripts({ sinceMs: 0 });
  assert.equal(found.length, 1);
  assert.equal(found[0].transcriptPath.cwd, "k:/proj", "workspace folder URI decoded");

  const turns = await p.buildTurns(found[0].transcriptPath, found[0].opts);
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.equal(turn.provider, "cursor");
  assert.equal(turn.prompt, "the prompt");
  assert.equal(turn.response, "the answer");
  assert.equal(turn.model, "claude-4-sonnet");
  assert.equal(turn.usage.input, 900);
  assert.equal(turn.usage.output, 120);
  assert.equal(turn.usage.cacheRead, 40);
  assert.equal(turn.cost.source, "priced");
  assert.equal(turn.cost.estimated, undefined, "real counts must not be flagged estimated");
});

test("missing token usage falls back to a flagged estimate", needsSqlite, async (t) => {
  const prompt = "x".repeat(400);
  await fixture(t, {
    composers: {
      c1: composer([
        { bubbleId: "b1", type: 1, text: prompt },
        { bubbleId: "b2", type: 2, text: "y".repeat(80) }, // no tokenUsage at all
      ]),
    },
  });

  const p = await provider();
  const found = await p.discoverTranscripts({ sinceMs: 0 });
  const turn = (await p.buildTurns(found[0].transcriptPath, found[0].opts))[0];
  assert.equal(turn.usage.input, 100, "~4 chars per token");
  assert.equal(turn.usage.output, 20);
  assert.equal(turn.cost.source, "estimated");
  assert.equal(turn.cost.estimated, true);
});

test("bubbles follow fullConversationHeadersOnly, not insertion order", needsSqlite, async (t) => {
  await fixture(t, {
    composers: {
      c1: composer(
        [
          // inserted out of order on purpose
          { bubbleId: "b3", type: 2, text: "second answer", tokenUsage: { inputTokens: 1, outputTokens: 1 } },
          { bubbleId: "b1", type: 1, text: "first" },
          { bubbleId: "b2", type: 2, text: "first answer", tokenUsage: { inputTokens: 1, outputTokens: 1 } },
          { bubbleId: "b0", type: 1, text: "second" },
        ],
        { fullConversationHeadersOnly: [{ bubbleId: "b1" }, { bubbleId: "b2" }, { bubbleId: "b0" }, { bubbleId: "b3" }] },
      ),
    },
  });

  const p = await provider();
  const found = await p.discoverTranscripts({ sinceMs: 0 });
  const turns = await p.buildTurns(found[0].transcriptPath, found[0].opts);
  assert.deepEqual(turns.map((x) => [x.prompt, x.response]), [
    ["first", "first answer"],
    ["second", "second answer"],
  ]);
});

test("sinceMs filters on the composer's lastUpdatedAt", needsSqlite, async (t) => {
  await fixture(t, {
    composers: {
      old: composer([{ bubbleId: "b1", type: 1, text: "old" }], { lastUpdatedAt: 1_000 }),
      fresh: composer([{ bubbleId: "b1", type: 1, text: "fresh" }], { lastUpdatedAt: 9_000_000_000_000 }),
    },
  });

  const p = await provider();
  assert.equal((await p.discoverTranscripts({ sinceMs: 0 })).length, 2);
  const recent = await p.discoverTranscripts({ sinceMs: 8_000_000_000_000 });
  assert.deepEqual(recent.map((x) => x.transcriptPath.composerId), ["fresh"]);
});

test("an unsupported global schema is reported, not silently empty", needsSqlite, async (t) => {
  await fixture(t, { composers: {}, globalRows: null }); // global DB lacks cursorDiskKV
  const p = await provider();
  const result = await p.discoverTranscriptsStatus({ sinceMs: 0 });
  assert.equal(result.status, "unsupported-schema");
  assert.match(result.detail, /cursorDiskKV/);
  assert.deepEqual(result.transcripts, []);
});

test("a workspace with unreadable composer JSON yields no transcripts but no throw", needsSqlite, async (t) => {
  await fixture(t, { composers: {}, workspaceValue: "not json at all" });
  const p = await provider();
  const result = await p.discoverTranscriptsStatus({ sinceMs: 0 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.transcripts, []);
});
