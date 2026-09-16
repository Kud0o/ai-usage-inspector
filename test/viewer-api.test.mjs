import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { runtimePaths } from "../viewer/runtime.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "viewer", "server.mjs");
const LONG_PROMPT = `${"lead ".repeat(80)}BURIEDNEEDLE tail`; // the needle sits well past the 280-char preview
const RECORDS = [
  {
    provider: "claude", sessionId: "s1", id: "s1:0", ts: "2026-08-10T10:00:00.000Z",
    prompt: LONG_PROMPT, promptChars: LONG_PROMPT.length, response: "answered", responseChars: 8,
    model: "claude-sonnet-4-5", usage: { input: 10, output: 2 }, cost: { total: 1, source: "priced" },
    sessionName: "Named constellation", sessionTitle: "Generated orbit", branchOf: "original-session",
    counts: { subagentCalls: 2 },
    subagents: [{ agentId: "a1", agentType: "planner", description: "Plan changes", cost: { total: 0.2 },
      subagents: [{ agentId: "a2", agentType: "reviewer", description: "Nested lighthouse inspection", cost: { total: 0.1 } }] }],
  },
  {
    provider: "codex", sessionId: "s2", id: "s2:0", ts: "2026-08-10T11:00:00.000Z",
    prompt: "short one", promptChars: 9, response: "ok", responseChars: 2,
    model: "gpt-test", usage: { input: 5, output: 1 }, cost: { total: 2, source: "priced" },
    spawnedAgents: ["s9"],
  },
  // The Claude turn's id again, in another session: a Codex subagent thread
  // repeats its parent's turn ids.
  {
    provider: "codex", sessionId: "s9", id: "s1:0", ts: "2026-08-10T12:00:00.000Z",
    prompt: "same id, another session", promptChars: 24, response: "", responseChars: 0,
    model: "gpt-test", usage: { input: 1, output: 1 }, cost: { total: 0.5, source: "priced" },
    parentSessionId: "s2", agent: { kind: "spawned", nickname: "Quartz", path: "/root/review", role: "reviewer", depth: 1 },
  },
];

function request(port, pathname, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port, path: pathname, method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// One server for the whole file; --no-sync/--no-pricing-refresh keep it off the
// network and stop autoSync from pulling this machine's real history into the
// fixture directory.
let dir;
let child;
let port;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-viewerapi-"));
  fs.writeFileSync(path.join(dir, "p.ndjson"), RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  port = 4500 + Math.floor(Math.random() * 400);
  child = spawn(process.execPath, [SERVER, "--port", String(port), "--no-sync", "--no-pricing-refresh"], {
    env: { ...process.env, AI_USAGE_DIR: dir },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      await request(port, "/api/config");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("viewer did not start");
});

test.after(() => {
  try { child.kill(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test("/api/events ships previews, never the full stored text", async () => {
  const res = await request(port, "/api/events");
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 3);
  const long = res.json.find((e) => e.id === "s1:0" && e.provider === "claude");
  assert.equal("prompt" in long, false, "full prompt must not ride along in the list");
  assert.equal(long.promptPreview.length, 280);
  assert.equal(long.promptChars, LONG_PROMPT.length, "true size still reported");
});

test("/api/events preserves session and recursive agent metadata", async () => {
  const res = await request(port, "/api/events");
  assert.equal(res.status, 200);
  for (const field of ["subagents", "sessionName", "sessionTitle", "branchOf", "parentSessionId", "agent", "spawnedAgents"]) {
    const fixture = RECORDS.find((e) => Object.hasOwn(e, field));
    assert.ok(fixture, `fixture exercises ${field}`);
    const item = res.json.find((e) => e.provider === fixture.provider && e.sessionId === fixture.sessionId && e.id === fixture.id);
    assert.deepEqual(item[field], fixture[field], `list retains ${field}`);
  }
});

for (const [field, query, provider, session, id] of [
  ["sessionName", "named constellation", "claude", "s1", "s1:0"],
  ["sessionTitle", "generated orbit", "claude", "s1", "s1:0"],
  ["nested description", "lighthouse inspection", "claude", "s1", "s1:0"],
  ["nested agentType", "reviewer", "claude", "s1", "s1:0"],
  ["agent nickname", "quartz", "codex", "s9", "s1:0"],
]) {
  test(`/api/search matches ${field}`, async () => {
    const res = await request(port, "/api/search?q=" + encodeURIComponent(query));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.keys, [JSON.stringify([provider, session, id])]);
  });
}

function viewerUi(records) {
  const nodes = new Map();
  const document = {
    addEventListener: () => {},
    querySelector: (s) => {
      if (!nodes.has(s)) nodes.set(s, { innerHTML: "", hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
      return nodes.get(s);
    },
    querySelectorAll: () => [],
  };
  const ctx = vm.createContext({ document, Intl, setTimeout, clearTimeout, fetch: async () => ({ json: async () => ({}) }) });
  const source = fs.readFileSync(path.join(path.dirname(SERVER), "public", "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("\nbind();")), ctx);
  ctx.records = structuredClone(records);
  vm.runInContext("state.all = records; state.view = records;", ctx);
  return { run: (code) => vm.runInContext(code, ctx), html: () => document.querySelector("#rows").innerHTML };
}

test("viewer session toggles close and reopen without accumulating keys", () => {
  const ui = viewerUi(RECORDS);
  ui.run('bind(); persist = () => {}; renderTable(); globalThis.key = "session:" + sessionKey(records[0]);');
  const click = '$("#rows").listeners.click({ target: { closest: () => ({ dataset: { tree: key } }) } })';
  ui.run(click);
  assert.equal(ui.run("isExpanded(key)"), false);
  ui.run(click);
  assert.equal(ui.run("isExpanded(key)"), true);
  assert.equal(ui.run("state.expanded.length"), 0);
  ui.run('key = turnTreeKey(records[0]);');
  ui.run(click);
  ui.run(click);
  assert.equal(ui.run("state.expanded.length"), 0);
});

test("viewer persistence prunes stale expansion keys and caps unique live keys", () => {
  const ui = viewerUi(Array.from({ length: 600 }, (_, i) => ({ ...RECORDS[0], id: `turn-${i}` })));
  ui.run('globalThis.saved = null; setTimeout = (fn) => { fn(); }; fetch = (url, opts) => { saved = JSON.parse(opts.body); return Promise.resolve(); }; renderTable();');
  ui.run('state.expanded = ["gone", ...records.map(turnTreeKey), turnTreeKey(records[0])]; persist();');
  assert.equal(ui.run("saved.ui.expanded.length"), 500);
  assert.equal(ui.run('saved.ui.expanded.includes("gone")'), false);
  assert.equal(ui.run("new Set(saved.ui.expanded).size"), 500);
  ui.run('state.view = []; renderTable(); persist();');
  assert.equal(ui.run("saved.ui.expanded.length"), 0);
});

test("viewer clamps the main thread share when old run costs exceed the turn", () => {
  const ui = viewerUi([{ ...RECORDS[0], cost: { total: .01 } }]);
  assert.match(ui.run("subagentSection(records[0])"), /<dt>cost<\/dt><dd>\$0\.000<\/dd>/);
});

test("viewer tree keeps branches, child sessions and runs attached without counting display rows", () => {
  const parent = { ...RECORDS[1], sessionName: "Parent" };
  const child = RECORDS[2];
  const original = { ...RECORDS[0], branchOf: undefined };
  const branch = { ...original, sessionId: "branch", id: "branch:0", branchOf: "s1", sessionName: "Branch", subagents: undefined };
  const ui = viewerUi([parent, child, original, branch]);
  ui.run("renderTable()");
  // Sessions start open, so their turns show as they always did; a branch nests in
  // its open original, while runs and spawned agents wait behind a turn's expander.
  assert.equal((ui.html().match(/class="group"/g) || []).length, 3, "two top-level sessions and the branch inside one");
  assert.doesNotMatch(ui.html(), /spawned · Quartz/, "a spawned agent waits behind its turn");
  assert.match(ui.html(), /aria-expanded="false"/);
  ui.run("state.expanded = records.map((e) => turnTreeKey(e)); renderTable()");
  const html = ui.html();
  assert.match(html, /spawned · Quartz/);
  assert.match(html, /branch · Branch/);
  assert.ok(html.indexOf('data-session="s2"') < html.indexOf("spawned · Quartz"), "child header follows spawning turn");
  assert.match(html, /\+ agents \$0\.500/);
  assert.match(html, /1 turns · \$2\.000/, "parent header excludes child session cost");
  assert.equal((html.match(/class="run-row"/g) || []).length, 1, "deeper runs stay collapsed");
  ui.run('state.expanded.push("run:" + keyOf(records[2]) + ":0"); renderTable()');
  assert.equal((ui.html().match(/class="run-row"/g) || []).length, 2);
  assert.equal(ui.run("state.view.length"), 4, "display rows never enter event totals or delete/export selection");
  ui.run("state.group = false; renderTable()");
  assert.doesNotMatch(ui.html(), /class="group"/);
  assert.match(ui.html(), /↳ agent/);
  assert.equal((ui.html().match(/class="run-row"/g) || []).length, 2, "run expansion survives grouping toggle");
});

test("viewer nests an opencode subagent session under its parent and its spawning turn", () => {
  const parent = {
    provider: "opencode", sessionId: "op", id: "op:0", ts: "2026-08-11T09:00:00.000Z",
    prompt: "map the schema", promptChars: 15, response: "done", responseChars: 4,
    model: "union-alpha", usage: { input: 4, output: 1 }, cost: { total: 2, source: "provider" },
    sessionName: "Schema map", spawnedAgents: ["oc"],
  };
  const child = {
    provider: "opencode", sessionId: "oc", id: "oc:0", ts: "2026-08-11T09:01:00.000Z",
    prompt: "read the tables", promptChars: 14, response: "ok", responseChars: 2,
    model: "union-alpha", usage: { input: 1, output: 1 }, cost: { total: 0.5, source: "provider" },
    parentSessionId: "op", agent: { kind: "subagent", nickname: "Mapper", path: null, depth: 1 },
  };
  const ui = viewerUi([parent, child]);
  ui.run("renderTable()");
  // Sessions start open: the child nests inside the parent's group rather than floating as its own.
  assert.equal((ui.html().match(/class="group"/g) || []).length, 1, "one group, child nests");
  assert.equal(ui.run("state.view.length"), 2, "event totals still see both sessions");
  ui.run("state.expanded = records.map((e) => turnTreeKey(e)); renderTable()");
  const html = ui.html();
  assert.match(html, /subagent · Mapper/);
  assert.ok(html.indexOf('data-session="op"') < html.indexOf("subagent · Mapper"), "child header follows spawning turn");
  assert.match(html, /\+ agents \$0\.500/);
  assert.match(html, /1 turns · \$2\.000/, "parent header excludes the child session cost");
  ui.run("state.group = false; renderTable()");
  assert.match(ui.html(), /↳ agent/, "ungrouped opencode child keeps its agent marker");
  assert.match(ui.html(), /title="Context window unknown">—/, "an unknown window reads as unknown, not 0%");
  assert.doesNotMatch(ui.html(), /<b class="mono">0%<\/b>/, "no 0% bar for an unmeasured turn");
});

test("viewer run cards subtract every own share, escape text, and tolerate omitted groups", () => {
  const e = { ...RECORDS[0], usage: { input: 100, output: 40, cacheCreate: 10, cacheRead: 20 }, cost: { total: 1 },
    subagents: [{ agentType: "<planner>", description: '<img src=x onerror="bad()">', background: true,
      usage: { input: 20, output: 10, cacheCreate: 2, cacheRead: 3 }, cost: { total: 0.2 },
      subagents: [{ usage: { input: 10, output: 5, cacheCreate: 1, cacheRead: 2 }, cost: { total: 0.1 } }] }] };
  const ui = viewerUi([e]);
  const html = ui.run("subagentSection(records[0])");
  assert.match(html, /<dt>input<\/dt><dd>70<\/dd>/);
  assert.match(html, /<dt>output<\/dt><dd>25<\/dd>/);
  assert.match(html, /<dt>cache write<\/dt><dd>7<\/dd>/);
  assert.match(html, /<dt>cache read<\/dt><dd>15<\/dd>/);
  assert.match(html, /\$0\.700/);
  assert.match(html, /class="run-children"/);
  assert.match(html, /&lt;planner&gt;/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /background/);
  assert.match(html, /<dt>duration<\/dt><dd>—<\/dd>/);
  ui.run("delete records[0].subagents[0].cost; delete records[0].subagents[0].usage");
  assert.match(ui.run("subagentSection(records[0])"), /<dt>cost<\/dt><dd>—<\/dd>/);
  assert.equal(ui.run('sumRuns(records[0], "cost", "total")'), null);
});

test("viewer session labels honor precedence and mark only generated titles", () => {
  const ui = viewerUi([]);
  assert.equal(ui.run('sessionLabel({ sessionName: "<name>", sessionTitle: "title", slug: "slug" })'), "&lt;name&gt;");
  assert.match(ui.run('sessionLabel({ sessionTitle: "title", slug: "slug" })'), /class="generated-title" title="generated title">title<\/em>/);
  assert.equal(ui.run('sessionLabel({ slug: "slug", sessionId: "1234567890" })'), "slug");
  assert.equal(ui.run('sessionLabel({ sessionId: "1234567890" })'), "12345678");
});

test("viewer filtered children fall back to session nesting or orphan tags within their provider", () => {
  const ui = viewerUi(RECORDS);
  ui.run("delete records[1].spawnedAgents; state.expanded = []; renderTable()");
  assert.match(ui.html(), /spawned · Quartz/, "missing spawn turn nests directly in the parent session");
  assert.match(ui.html(), /branched from original/);
  ui.run("state.view = [records[2], { ...records[1], provider: 'claude' }]; renderTable()");
  assert.match(ui.html(), /agent of s2/, "another provider's session cannot become the parent");
});

test("viewer CSV exports event rows with session name and recursive run totals", async () => {
  const ui = viewerUi(RECORDS);
  ui.run('download = (name, text) => { globalThis.csv = text; }; toast = () => {};');
  await ui.run('exportRecords("csv")');
  const lines = ui.run("csv").split("\r\n");
  assert.equal(lines.length, RECORDS.length + 1);
  const columns = lines[0].split(",");
  const values = lines[1].split(",");
  assert.equal(values[columns.indexOf("sessionName")], RECORDS[0].sessionName);
  assert.equal(Number(values[columns.indexOf("subagentRuns")]), 2);
  assert.ok(Math.abs(Number(values[columns.indexOf("subagentCost")]) - 0.3) < 1e-10);
});

test("viewer preview search includes session titles and nested runs while server search is unavailable", () => {
  const ui = viewerUi(RECORDS);
  ui.run("renderStats = () => {}; renderCharts = () => {}; persist = () => {};");
  for (const query of ["constellation", "generated orbit", "lighthouse"]) {
    ui.run(`state.filters.search = ${JSON.stringify(query)}; apply()`);
    assert.equal(ui.run("state.view.length"), 1);
    assert.equal(ui.run("state.view[0].sessionId"), "s1");
  }
});

test("/api/search matches text past the preview cut-off", async () => {
  const hit = await request(port, "/api/search?q=BURIEDNEEDLE");
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.json.keys, [JSON.stringify(["claude", "s1", "s1:0"])]);

  const previews = (await request(port, "/api/events")).json;
  const preview = previews.find((e) => e.id === "s1:0" && e.provider === "claude").promptPreview;
  assert.equal(preview.includes("BURIEDNEEDLE"), false, "needle is genuinely beyond the preview");
});

test("/api/search: empty query disables filtering, no match returns none", async () => {
  assert.equal((await request(port, "/api/search?q=")).json.keys, null);
  assert.deepEqual((await request(port, "/api/search?q=zzznotfoundzzz")).json.keys, []);
});

test("/api/export returns whole records for the requested keys", async () => {
  const res = await request(port, "/api/export", {
    method: "POST",
    body: { keys: [{ provider: "claude", sessionId: "s1", id: "s1:0" }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 1);
  assert.equal(res.json[0].prompt, LONG_PROMPT, "full text, not the preview");
  assert.equal(res.json[0].response, "answered");
});

test("/api/export with no keys returns nothing rather than everything", async () => {
  const res = await request(port, "/api/export", { method: "POST", body: { keys: [] } });
  assert.deepEqual(res.json, []);
});

test("/api/event/:id returns one full record; unknown id is 404", async () => {
  const ok = await request(port, "/api/event/s2%3A0");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.prompt, "short one");
  assert.equal((await request(port, "/api/event/nope")).status, 404);
});

test("/api/event names provider and session, so turns sharing an id each open themselves", async () => {
  const claude = await request(port, "/api/event/s1%3A0?provider=claude&session=s1");
  const codex = await request(port, "/api/event/s1%3A0?provider=codex&session=s9");
  assert.equal(claude.json.prompt, LONG_PROMPT);
  assert.equal(codex.json.prompt, "same id, another session");
  assert.equal((await request(port, "/api/event/s1%3A0?provider=codex&session=s1")).status, 404);
});

test("/api/stream is an SSE feed that fires when the data dir changes", async () => {
  const events = await new Promise((resolve, reject) => {
    const seen = [];
    const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
      assert.match(res.headers["content-type"], /text\/event-stream/);
      res.on("data", (d) => {
        if (d.toString().includes("event: change")) seen.push(1);
      });
      setTimeout(() => {
        fs.appendFileSync(path.join(dir, "p.ndjson"), JSON.stringify({ ...RECORDS[1], id: "s2:1" }) + "\n");
      }, 300);
      setTimeout(() => { req.destroy(); resolve(seen.length); }, 2500);
    });
    req.on("error", reject);
  });
  assert.ok(events >= 1, "a write to the data dir must notify connected clients");
});

test("DELETE tombstones the record so it stays gone", async () => {
  const del = await request(port, "/api/events", {
    method: "DELETE",
    body: { keys: [{ provider: "codex", sessionId: "s2", id: "s2:0" }] },
  });
  assert.equal(del.status, 200);
  assert.equal(del.json.removed, 1);
  assert.ok(fs.existsSync(path.join(dir, "tombstones.json")), "tombstone persisted for the next sync");

  const left = (await request(port, "/api/events")).json;
  assert.equal(left.some((e) => e.id === "s2:0"), false);
});

test("static index is served; unknown routes and traversal do not escape", async () => {
  const index = await request(port, "/");
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /text\/html/);
  assert.equal((await request(port, "/definitely-not-here.js")).status, 404);
  const escaped = await request(port, "/....//....//package.json");
  assert.ok(escaped.status === 403 || escaped.status === 404, `traversal must not serve a file (got ${escaped.status})`);
});

// Spawn a server with a given environment, wait for it, hand back its port.
async function spawnViewer(t, dir, env) {
  const port = 4500 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, [SERVER, "--port", String(port), "--no-sync", "--no-pricing-refresh"], {
    env: { ...process.env, AI_USAGE_DIR: dir, ...env },
    stdio: "ignore",
  });
  t.after(() => { try { proc.kill(); } catch {} });
  for (let i = 0; i < 60; i++) {
    try {
      await request(port, "/api/status");
      return port;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("viewer did not start");
}

// The launcher must tell OUR server from whatever else may hold a port, and from
// a server for a different project. A pid cannot do it: the OS reuses them.
test("/api/status identifies the instance and its data directory", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await spawnViewer(t, dir, { AI_USAGE_INSTANCE: "nonce-abc" });

  const s = (await request(port, "/api/status")).json;
  assert.equal(s.app, "ai-usage-inspector");
  assert.equal(s.nonce, "nonce-abc", "the launcher's own nonce comes back");
  assert.equal(path.resolve(s.dataDir), path.resolve(dir));
  const runtime = runtimePaths(dir).runtimeFile;
  assert.ok(fs.existsSync(runtime), "launcher coordination lives in machine-local temporary state");
  assert.equal(fs.existsSync(path.join(dir, ".viewer-runtime.json")), false, "project data stays free of runtime state");
  assert.equal(JSON.parse(fs.readFileSync(runtime, "utf8")).pid > 0, true);
});

// A server started from a terminal keeps its old behaviour: no runtime file, and
// it does not wander off while someone is watching the window.
test("a terminal-started server writes no runtime file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await spawnViewer(t, dir, {});

  const s = (await request(port, "/api/status")).json;
  assert.equal(s.nonce, null, "no instance nonce outside launcher mode");
  assert.equal(fs.existsSync(path.join(dir, ".viewer-runtime.json")), false);
  assert.equal(fs.existsSync(runtimePaths(dir).runtimeFile), false, "terminal mode has no machine-local runtime either");
});

test("a launcher status check extends the idle deadline for the opening page", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-idlerace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nonce = "nonce-idle-race";
  const port = await spawnViewer(t, dir, {
    AI_USAGE_INSTANCE: nonce,
    AI_USAGE_IDLE_EXIT_MS: "1000",
  });

  await new Promise((resolve) => setTimeout(resolve, 650));
  const verified = await request(port, "/api/status", {
    headers: { "X-AI-Usage-Launcher": nonce },
  });
  assert.equal(verified.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal((await request(port, "/api/status")).status, 200, "server survives past its original deadline");
});

// Time charts: a pointer reads a day, a drag zooms, scrolling scales, and a zoom
// becomes a filter only when asked. The window math is where a chart goes wrong
// quietly — an empty view, a window stuck past the last day — so it is pinned here.
const DAYS = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);

test("a pointer across a time chart lands on a day, never outside the range", () => {
  const ui = viewerUi(RECORDS);
  assert.equal(ui.run("dayIndexAt(30, 0)"), 0);
  assert.equal(ui.run("dayIndexAt(30, 1)"), 29);
  assert.equal(ui.run("dayIndexAt(30, 0.5)"), 15);
  assert.equal(ui.run("dayIndexAt(30, -3)"), 0);
  assert.equal(ui.run("dayIndexAt(30, 7)"), 29);
  assert.equal(ui.run("dayIndexAt(0, 0.5)"), -1);
});

test("dragging across days zooms to them, and a window over every day is no zoom", () => {
  const ui = viewerUi(RECORDS);
  ui.run(`globalThis.days = ${JSON.stringify(DAYS)};`);
  assert.deepEqual({ ...ui.run("zoomFromIndices(days, 20, 5)") }, { from: "2026-06-06", to: "2026-06-21" }, "either drag direction");
  assert.equal(ui.run("zoomFromIndices(days, 0, 29)"), null);
  const click = ui.run("zoomFromIndices(days, 10, 10)");
  assert.ok(click && click.from < click.to, "a click still opens a window at least two days wide");
  assert.equal(ui.run('zoomFromIndices(["2026-06-01", "2026-06-02"], 0, 1)'), null, "too few days to zoom");
  assert.deepEqual([...ui.run('daysInZoom(days, { from: "2026-06-03", to: "2026-06-05" })')], ["2026-06-03", "2026-06-04", "2026-06-05"]);
  assert.equal(ui.run('daysInZoom(days, { from: "2027-01-01", to: "2027-01-02" }).length'), 30, "a window the data left shows every day, not nothing");
});

test("scrolling scales about the pointer, stays inside the range, and zooms back out to nothing", () => {
  const ui = viewerUi(RECORDS);
  ui.run(`globalThis.days = ${JSON.stringify(DAYS)};`);
  const zoomIn = ui.run("zoomByFactor(days, null, 0.5, 0.9)");
  assert.ok(zoomIn, "scrolling in opens a window");
  assert.ok(zoomIn.to >= "2026-06-26", "the day under the pointer stays in view");
  const nearEnd = ui.run('zoomByFactor(days, { from: "2026-06-25", to: "2026-06-30" }, 0.8, 1)');
  assert.equal(nearEnd.to, "2026-06-30", "never past the last day");
  // Scaling out against the edge slides the window back rather than cutting it
  // short: six days scaled by 1.25 is eight days, all of them before the end.
  const outAtEdge = ui.run('zoomByFactor(days, { from: "2026-06-25", to: "2026-06-30" }, 1.25, 1)');
  assert.deepEqual({ ...outAtEdge }, { from: "2026-06-23", to: "2026-06-30" }, "the window keeps its width at the edge");
  let zoom = ui.run('({ from: "2026-06-10", to: "2026-06-14" })');
  for (let i = 0; i < 20 && zoom; i++) {
    ui.run(`globalThis.z = ${JSON.stringify(zoom)};`);
    zoom = ui.run("zoomByFactor(days, z, 1.25, 0.5)");
  }
  assert.equal(zoom, null, "scrolling out far enough returns to every day");
});

test("the day readout says what the day held, in the fields this project keeps", () => {
  const ui = viewerUi(RECORDS);
  ui.run('CHART_DAYS = { days: { "2026-06-03": { n: 4, tok: 12000, cost: 1.5, models: { "opus-5": 3, "sonnet-5": 1 } } }, allKeys: [], keys: [] };');
  const tip = ui.run('dayTooltip("2026-06-03")');
  assert.match(tip, /turns<i>4<\/i>/);
  assert.match(tip, /tokens<i>12\.0k<\/i>/);
  assert.match(tip, /cost<i>\$1\.500<\/i>/);
  assert.match(tip, /mostly<i>opus-5 \(3\)<\/i>/);
  ui.run('state.fields = { cost: false };');
  assert.doesNotMatch(ui.run('dayTooltip("2026-06-03")'), /cost/, "a field this project does not keep is not shown");
  assert.equal(ui.run('dayTooltip("1999-01-01")'), "");
});

test("a zoom is a closer look; filtering to it is a separate, explicit step", () => {
  const records = DAYS.slice(0, 10).map((day, i) => ({ ...RECORDS[0], id: `z-${i}`, ts: `${day}T12:00:00.000Z` }));
  const ui = viewerUi(records);
  ui.run('globalThis.reflect = () => {}; persist = () => {}; renderCharts = () => {};');
  ui.run('state.zoom = { from: "2026-06-03", to: "2026-06-05" }; apply();');
  assert.equal(ui.run("state.view.length"), 10, "zooming the chart leaves every turn in the view");
  ui.run('state.filters.since = state.zoom.from; state.filters.until = state.zoom.to; state.zoom = null; apply();');
  assert.equal(ui.run("state.view.length"), 3, "since and until both bound the view once asked");
});

// ---- third review: charts ----

// Chart rendering reads theme colours; the harness has no stylesheet.
const chartUi = (records) => {
  const ui = viewerUi(records);
  ui.run('globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" }); document.documentElement = {};');
  return ui;
};
const onDays = (days) => days.map((day, i) => ({ ...RECORDS[0], id: `c-${i}`, ts: `${day}T12:00:00.000Z` }));

test("a zoom the filtered data no longer reaches is dropped, so no button acts on days nobody can see", () => {
  const ui = chartUi(onDays(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]));
  ui.run('state.zoom = { from: "2026-06-03", to: "2026-06-05" }; renderCharts();');
  assert.equal(ui.run("state.zoom"), null);
  assert.deepEqual([...ui.run("CHART_DAYS.keys")], ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]);
  ui.run('state.zoom = { from: "2026-07-02", to: "2026-07-03" }; renderCharts();');
  assert.deepEqual({ ...ui.run("state.zoom") }, { from: "2026-07-02", to: "2026-07-03" }, "a zoom still in reach stands");
});

test("with tokens not kept, the cost chart carries the zoom controls", () => {
  const ui = chartUi(onDays(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]));
  ui.run('state.fields = { tokens: false }; state.zoom = { from: "2026-07-02", to: "2026-07-03" }; renderCharts();');
  const html = ui.run('document.querySelector("#charts").innerHTML');
  assert.match(html, /data-zoom="filter"/);
  assert.match(html, /data-zoom="reset"/);
  ui.run('state.fields = {}; renderCharts();');
  assert.equal((ui.run('document.querySelector("#charts").innerHTML').match(/class="chart-zoom"/g) || []).length, 1, "and only one set when both charts show");
});

test("chart overlays that set their own display still hide", () => {
  const css = fs.readFileSync(path.join(path.dirname(SERVER), "public", "styles.css"), "utf8");
  const rule = /([^{}]+)\{\s*display:\s*none;?\s*\}/g;
  const hidden = [...css.matchAll(rule)].map((m) => m[1]).join(",");
  for (const selector of [".chart-tip[hidden]", ".chart-cursor[hidden]", ".chart-brush[hidden]"]) {
    assert.ok(hidden.includes(selector), `${selector} has display: none`);
  }
});

// Chart explorer: semantic invariants and real listener paths, without a browser.
const chartHTML = (ui) => ui.run('document.querySelector("#charts").innerHTML');

test("chart scales enclose maxima with increasing zero-based ticks", () => {
  const ui = chartUi([]);
  for (const max of [0, .00004, .7, 1, 99, 123456789]) {
    const scale = ui.run(`niceScale(${max})`);
    assert.equal(scale.ticks[0], 0);
    assert.ok(scale.max >= max && scale.max > 0);
    assert.equal(scale.ticks.at(-1), scale.max);
    assert.ok(scale.ticks.length >= 3 && scale.ticks.length <= 6);
    assert.ok(scale.ticks.every((v, i, a) => i === 0 || v > a[i - 1]));
  }
});

test("chart date ticks cover endpoints once and handle empty and single dates", () => {
  const ui = chartUi([]);
  ui.run(`globalThis.days = ${JSON.stringify(DAYS)}`);
  assert.equal(ui.run('dateTicks([]).length'), 0);
  assert.equal(ui.run('dateTicks(["2026-12-31"])[0].index'), 0);
  const ticks = ui.run('dateTicks(days)');
  assert.equal(ticks.length, 4);
  assert.deepEqual(Array.from(ticks, (t) => t.index), [0, 10, 19, 29]);
  assert.equal(new Set(ticks.map((t) => t.label)).size, 4);
  assert.match(ticks[0].label, /26/);
});

test("chart calendar fills leap days and year boundaries while active mode keeps gaps", () => {
  const ui = chartUi([]);
  assert.deepEqual([...ui.run('calendarKeys(["2024-02-28", "2024-03-01"], "calendar")')], ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.deepEqual([...ui.run('calendarKeys(["2025-12-31", "2026-01-02"], "calendar")')], ["2025-12-31", "2026-01-01", "2026-01-02"]);
  assert.equal(ui.run('calendarKeys(["2024-02-28", "2024-03-01"], "active").length'), 2);
});

test("chart Monday weeks and calendar months cross years without timezone shifts", () => {
  const ui = chartUi([]);
  assert.equal(ui.run('periodKey("2026-01-01", "week")'), "2025-12-29");
  assert.equal(ui.run('periodKey("2026-01-04", "week")'), "2025-12-29");
  assert.equal(ui.run('periodKey("2026-01-05", "week")'), "2026-01-05");
  assert.equal(ui.run('periodKey("2025-12-31", "month")'), "2025-12-01");
  assert.equal(ui.run('periodKey("2026-01-01", "month")'), "2026-01-01");
  assert.equal(ui.run('periodKey(dayKey("2026-01-01T00:30:00+14:00"), "day")'), "2026-01-01");
  assert.equal(ui.run('periodKey(dayKey("2025-12-31T23:30:00-12:00"), "day")'), "2025-12-31");
  // Host-zone changes must not change calendar arithmetic or date tick labels.
  const before = process.env.TZ;
  try {
    for (const zone of ["America/Los_Angeles", "Pacific/Kiritimati", "Africa/Cairo"]) {
      process.env.TZ = zone;
      assert.equal(ui.run('periodKey("2026-03-09", "week")'), "2026-03-09");
      assert.equal(ui.run('dateTicks(["2026-01-01"])[0].label'), new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date("2026-01-01T00:00:00Z")));
    }
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});

test("chart automatic granularity stays bounded and manual choices win", () => {
  const ui = chartUi([]);
  assert.equal(ui.run('chartGrain(120, "auto")'), "day");
  assert.equal(ui.run('chartGrain(121, "auto")'), "week");
  assert.equal(ui.run('chartGrain(730, "auto")'), "week");
  assert.equal(ui.run('chartGrain(731, "auto")'), "month");
  assert.equal(ui.run('chartGrain(5000, "day")'), "day");
});

test("chart buckets retain exact totals and visible partial-period endpoints", () => {
  const ui = chartUi(onDays(["2025-12-31", "2026-01-01", "2026-01-05"]));
  ui.run('state.chartView.grain = "week"; renderCharts()');
  assert.equal(ui.run('CHART_DAYS.periods.length'), 2);
  assert.equal(ui.run('CHART_DAYS.periods[0].from'), "2025-12-31");
  assert.equal(ui.run('CHART_DAYS.periods[0].to'), "2026-01-04");
  assert.equal(ui.run('CHART_DAYS.periods.reduce((a,p)=>a+p.n,0)'), 3);
  assert.equal(ui.run('CHART_DAYS.periods.reduce((a,p)=>a+p.tok,0)'), 36);
  assert.equal(ui.run('CHART_DAYS.periods.reduce((a,p)=>a+p.cost,0)'), 3);
  ui.run('state.chartView.grain = "month"; renderCharts()');
  assert.deepEqual(Array.from(ui.run('CHART_DAYS.periods'), (p) => [p.key, p.n]), [["2025-12-01", 1], ["2026-01-01", 2]]);
});

test("chart token and provider stacks sum to the unstacked totals", () => {
  const ui = chartUi(RECORDS.map((r) => ({ ...r, usage: { input: 13, output: 7, cacheRead: 101, cacheCreate: 17 } })));
  ui.run('renderCharts()');
  for (const [kind, field] of [["tokens", "tok"], ["cost", "cost"]]) {
    const totals = ui.run(`stackSeries(chartSeries(CHART_DAYS.periods, "${kind}")).totals`);
    assert.deepEqual([...totals], Array.from(ui.run('CHART_DAYS.periods'), (p) => p[field]));
  }
  assert.equal(ui.run('stackSeries(chartSeries(CHART_DAYS.periods, "tokens")).layers[3].points[0].top'), 414);
  assert.equal(ui.run('stackSeries(chartSeries(CHART_DAYS.periods, "tokens")).layers[1].points[0].bottom'), 39);
});

test("chart legend toggles change visible layers but never stats table or filtered turns", () => {
  const ui = chartUi(RECORDS);
  ui.run('renderStats(); renderTable(); renderCharts()');
  const stats = ui.run('document.querySelector("#stats").innerHTML'), table = ui.html();
  ui.run('toggleSeries("tokens:input"); toggleSeries("cost:codex")');
  assert.equal(ui.run('state.view.length'), 3);
  assert.equal(ui.run('state.filters.since'), "");
  assert.equal(ui.run('document.querySelector("#stats").innerHTML'), stats);
  assert.equal(ui.html(), table);
  assert.match(chartHTML(ui), /data-series="tokens:input" aria-pressed="false"/);
  ui.run('renderStats(); renderTable()');
  assert.equal(ui.run('document.querySelector("#stats").innerHTML'), stats);
  assert.equal(ui.html(), table);
  ui.run('toggleSeries("tokens:input")');
  assert.match(chartHTML(ui), /data-series="tokens:input" aria-pressed="true"/);
});

test("chart disabled field groups hide series readouts and text alternatives", () => {
  const ui = chartUi(RECORDS);
  ui.run('state.fields = {tokens:false,cost:false,context:false}; renderCharts()');
  for (const kind of ["tokens", "cost", "context"]) {
    assert.equal(ui.run(`chartSeries(CHART_DAYS.periods,"${kind}").length`), 0);
    assert.doesNotMatch(chartHTML(ui), new RegExp(`data-kind="${kind}"|View ${kind} data`));
  }
  assert.doesNotMatch(ui.run('periodTooltip("2026-08-10", "tokens")'), /tokens|cost|Input|Cache/);
});

test("chart missing context is a gap and its mean weights observations not days", () => {
  const ui = chartUi([{ ...RECORDS[0], contextFillPct: 0 }, { ...RECORDS[1], contextFillPct: 90 }, { ...RECORDS[2], ts: "2026-08-12T12:00:00Z" }]);
  ui.run('renderCharts()');
  assert.deepEqual([...ui.run('chartSeries(CHART_DAYS.periods,"context")[0].values')], [45, null, null]);
  assert.match(chartHTML(ui), /No measurement|gaps mean no measurement/);
  ui.run('state.chartView.grain = "week"; renderCharts()');
  assert.equal(ui.run('chartSeries(CHART_DAYS.periods,"context")[0].values[0]'), 45);
  assert.match(chartHTML(ui), /0\u201310% of the window \u00b7 1 turns/);
});

test("chart readout compares visible series against a zero-safe period mean", () => {
  const ui = chartUi(onDays(["2026-06-01", "2026-06-03"]));
  ui.run('renderCharts()');
  assert.match(ui.run('periodTooltip("2026-06-01","tokens")'), /\+50%/);
  assert.match(ui.run('periodTooltip("2026-06-02","tokens")'), /-100%/);
  ui.run('state.chartView.hidden = TOKEN_TYPES.map(t=>`tokens:${t.key}`); renderCharts()');
  assert.match(chartHTML(ui), /All series hidden/);
  assert.doesNotMatch(ui.run('periodTooltip("2026-06-01","tokens")'), /NaN|Infinity|vs visible/);
});

test("chart pan and index windows clamp at both edges without losing width", () => {
  const ui = chartUi([]);
  ui.run(`globalThis.days = ${JSON.stringify(DAYS)}`);
  assert.deepEqual({ ...ui.run('panZoom(days,{from:days[10],to:days[14]},-100)') }, {from:DAYS[0],to:DAYS[4]});
  assert.deepEqual({ ...ui.run('panZoom(days,{from:days[10],to:days[14]},100)') }, {from:DAYS[25],to:DAYS[29]});
  assert.equal(ui.run('panZoom(days,null,1)'), null);
  assert.equal(ui.run('zoomFromIndices(days,100,120).to'), DAYS[29]);
  assert.equal(ui.run('zoomFromIndices(days,-20,-10).from'), DAYS[0]);
});

test("chart keyboard actions navigate clamp zoom pan and reset", () => {
  const ui = chartUi([]);
  assert.equal(ui.run('chartKeyAction("ArrowLeft",false,0,10).index'), 0);
  assert.equal(ui.run('chartKeyAction("ArrowRight",false,9,10).index'), 9);
  assert.equal(ui.run('chartKeyAction("ArrowRight",false,4,10).index'), 5);
  assert.equal(ui.run('chartKeyAction("ArrowLeft",true,4,10).pan'), -1);
  assert.equal(ui.run('chartKeyAction("Home",false,4,10).index'), 0);
  assert.equal(ui.run('chartKeyAction("End",false,4,10).index'), 9);
  assert.equal(ui.run('chartKeyAction("+",false,4,10).factor'), .8);
  assert.equal(ui.run('chartKeyAction("-",false,4,10).factor'), 1.25);
  assert.equal(ui.run('chartKeyAction("Escape",false,4,10).reset'), true);
  assert.equal(ui.run('chartKeyAction("Tab",false,4,10)'), null);
});

// Minimal event target, including the same listeners used by the browser.
function chartEvents(ui) {
  ui.run(`
    globalThis.parts = Object.fromEntries([".chart-tip",".chart-cursor",".chart-brush"].map(k=>[k,{hidden:true,style:{},dataset:{},setAttribute(){}}]));
    globalThis.chart = {dataset:{kind:"tokens",days:CHART_DAYS.periods.map(p=>p.key).join(",")},listeners:{},
      querySelector:s=>parts[s],addEventListener(t,fn){this.listeners[t]=fn}, getBoundingClientRect:()=>({left:0,width:100}),setPointerCapture(){}};
    globalThis.redraws=0; globalThis.focused=0;
    globalThis.savedRender=renderCharts; renderCharts=()=>{redraws++};
    document.querySelector=()=>({focus(){focused++}});
    attachChart(chart);
    globalThis.fire=(type, props={})=>chart.listeners[type]({clientX:50,button:0,preventDefault(){},...props});
  `);
}

test("chart keyboard listener updates readout without redrawing and restores focus on zoom", () => {
  const ui = chartUi(onDays(DAYS)); ui.run('renderCharts()'); chartEvents(ui);
  ui.run('fire("focus"); fire("keydown",{key:"ArrowRight"})');
  assert.match(ui.run('parts[".chart-tip"].innerHTML'), /Jun 2, 2026/);
  assert.equal(ui.run('redraws'), 0);
  ui.run('fire("keydown",{key:"+"})');
  assert.ok(ui.run('state.zoom'));
  assert.equal(ui.run('focused'), 1);
  ui.run('fire("keydown",{key:"Escape"})');
  assert.equal(ui.run('state.zoom'), null);
});

test("chart mouse drag selects full period endpoints and hover never redraws", () => {
  const ui = chartUi(onDays(DAYS)); ui.run('state.chartView.grain="week"; renderCharts()'); chartEvents(ui);
  ui.run('fire("mousemove",{clientX:30})');
  assert.equal(ui.run('redraws'), 0);
  assert.equal(ui.run('parts[".chart-cursor"].style.left'), "30%");
  ui.run('fire("mousedown",{clientX:25}); fire("mouseup",{clientX:50})');
  assert.deepEqual({ ...ui.run('state.zoom') }, {from:"2026-06-08",to:"2026-06-21"});
});

test("chart touch drags select periods and cancelled gestures clear overlays", () => {
  const ui = chartUi(onDays(DAYS)); ui.run('state.chartView.grain="week"; renderCharts()'); chartEvents(ui);
  ui.run('fire("pointerdown",{pointerType:"touch",pointerId:1,clientX:25}); fire("pointermove",{pointerType:"touch",clientX:50})');
  assert.equal(ui.run('parts[".chart-brush"].hidden'), false);
  assert.equal(ui.run('parts[".chart-cursor"].style.left'), "50%");
  ui.run('fire("pointerup",{pointerType:"touch",clientX:50})');
  assert.deepEqual({ ...ui.run('state.zoom') }, {from:"2026-06-08",to:"2026-06-21"});
  ui.run('fire("pointerdown",{pointerType:"touch",pointerId:1}); fire("pointercancel")');
  assert.equal(ui.run('parts[".chart-tip"].hidden'), true);
  assert.equal(ui.run('parts[".chart-brush"].hidden'), true);
});

test("chart filter button applies the shown dates of a clipped weekly window", () => {
  const ui = chartUi(onDays(DAYS));
  ui.run(`state.chartView.grain="week"; state.zoom={from:"2026-05-29",to:"2026-06-12"};renderCharts();
    globalThis.button={dataset:{zoom:"filter"},addEventListener(t,fn){this.click=fn}};
    document.querySelectorAll=s=>s==="#charts [data-zoom]"?[button]:[];
    reflect=()=>{}; persist=()=>{}; wireCharts(); button.click();`);
  assert.equal(ui.run('state.filters.since'), "2026-06-01");
  assert.equal(ui.run('state.filters.until'), "2026-06-12");
  assert.equal(ui.run('state.view.length'), 12);
});

test("chart overview and select listeners change only the chart view", () => {
  const ui = chartUi(onDays(DAYS));
  ui.run(`renderCharts();
    globalThis.slider={dataset:{overview:"from"},value:"10",addEventListener(t,fn){this.change=fn},focus(){}};
    globalThis.select={dataset:{chartOption:"grain"},value:"month",addEventListener(t,fn){this.change=fn},focus(){}};
    document.querySelectorAll=s=>s==="#charts [data-overview]"?[slider]:s==="#charts [data-chart-option]"?[select]:[];
    wireCharts(); slider.change(); select.change();`);
  assert.equal(ui.run('state.zoom.from'), DAYS[10]);
  assert.equal(ui.run('state.chartView.grain'), "month");
  assert.equal(ui.run('state.view.length'), 30);
  assert.equal(ui.run('state.filters.since'), "");
});

test("chart donut shares link slices and keyboard legends with escaped labels", () => {
  const ui = chartUi([]);
  const html = ui.run('donut({"<model>":3,other:1},fmtInt)');
  assert.match(html, /data-share="&lt;model&gt;"/);
  assert.match(html, /tabindex="0" data-share="&lt;model&gt;"/);
  assert.match(html, /75% of the total/);
  assert.match(ui.run('provDonut({claude:3,codex:1},fmtInt)'), /data-share="codex"/);
});

test("chart empty single-day and long views stay finite with bounded overview", () => {
  const ui = chartUi([]); ui.run('renderCharts()');
  assert.match(chartHTML(ui), /no data in range/);
  ui.run('state.view=records=[{ts:"2026-06-01T00:00:00Z",usage:{input:1}}];renderCharts()');
  assert.doesNotMatch(chartHTML(ui), /NaN|Infinity/);
  ui.run('state.view=Array.from({length:5200},(_,i)=>({ts:dateKeyAt(dateNumber("2025-01-01")+(i%320)*DAY_MS)+"T12:00:00Z",usage:{input:13,output:2},provider:i%2?"claude":"codex"}));renderCharts()');
  assert.equal(ui.run('CHART_DAYS.grain'), "week");
  assert.ok(ui.run('CHART_DAYS.periods.length') < 48);
  const overview = chartHTML(ui).match(/class="chart-overview">([\s\S]*?)<\/svg>/)[1];
  assert.ok((overview.match(/<rect/g) || []).length <= 241);
  assert.equal(ui.run('CHART_DAYS.periods.reduce((a,p)=>a+p.n,0)'), 5200);
});

test("chart styling supports reduced motion and phone reflow", () => {
  const publicDir = path.join(path.dirname(SERVER), "public");
  const css = fs.readFileSync(path.join(publicDir, "styles.css"), "utf8");
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.chart \{ touch-action: pan-y; \}/);
  assert.match(css, /\.charts \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.chart:focus-visible/);
});

test("chart linked donut focus highlights only its matching slice and clears on blur", () => {
  const ui = chartUi([]);
  ui.run(`
    globalThis.items=["a","a","b"].map(key=>({dataset:{share:key},active:false,listeners:{},addEventListener(t,fn){this.listeners[t]=fn},classList:{toggle(name,value){items.find(x=>x.classList===this).active=value}}}));
    const card={querySelectorAll:()=>items};
    document.querySelectorAll=s=>s==="#charts .card"?[card]:[];wireCharts();items[0].listeners.focus();`);
  assert.deepEqual([...ui.run('items.map(x=>x.active)')], [true,true,false]);
  ui.run('items[0].listeners.blur()');
  assert.deepEqual([...ui.run('items.map(x=>x.active)')], [false,false,false]);
});

test("chart context over capacity remains visible on an expanded scale", () => {
  const ui = chartUi([{...RECORDS[0],contextFillPct:150}]);
  ui.run('renderCharts()');
  const html=ui.run('timeChart(CHART_DAYS.periods,"context")');
  assert.match(html, /150%/);
  assert.doesNotMatch(html, /cy="-/);
});

test("round two compact axes omit padding and retain small nonzero ticks", () => {
  const ui = chartUi([]);
  for (const [value, kind, expected] of [[150e6,"tokens","150M"],[100e6,"tokens","100M"],[0,"tokens","0"],[80,"cost","$80"],[0,"cost","$0"],[.005,"cost","$0.005"]]) {
    assert.equal(ui.run(`fmtAxis(${value},"${kind}","en-US")`), expected);
  }
  assert.equal(ui.run('fmtAxis(150e6,"tokens","de-DE")'), new Intl.NumberFormat("de-DE", {notation:"compact",maximumFractionDigits:2}).format(150e6));
  assert.equal(ui.run('fmtUsd(80)'), "$80.00", "readouts keep precision");
  assert.equal(ui.run('fmtTok(150e6)'), "150.00M", "legend formatting stays precise");
});

test("round two date ticks distinguish years across grains locales and phone endpoints", () => {
  const ui = chartUi([]);
  ui.run('globalThis.dates=calendarKeys(["2025-11-20","2026-06-08"],"calendar")');
  for (const locale of ["en-US", "en-GB", "de-DE", "ar-EG"]) {
    for (const grain of ["day","week","month"]) {
      const ticks = ui.run(`dateTicks(dates,4,"${grain}","${locale}")`);
      const format = (date, options) => new Intl.DateTimeFormat(locale,{timeZone:"UTC",month:"short",...options}).format(new Date(date+"T00:00:00Z"));
      assert.equal(ticks[0].label, format("2025-11-20",{day:"numeric",year:"numeric"}));
      const boundary = ticks.find(t=>t.index===42);
      assert.ok(boundary, "Jan 1 gets a boundary tick");
      assert.equal(boundary.label, format("2026-01-01",{...(grain==="day"?{day:"numeric"}:{}),year:"numeric"}));
      assert.equal(ticks.at(-1).label, format("2026-06-08",{day:"numeric"}));
      assert.equal(ticks.at(-1).phoneLabel, format("2026-06-08",{day:"numeric",year:"numeric"}));
    }
  }
});

test("a year change near an end does not crowd the endpoint label and the next tick names the year", () => {
  const ui = chartUi([]);
  // 44 Monday weeks from Nov 17, 2025: the year changes at index 7, next to the first tick.
  ui.run('globalThis.weeks=Array.from({length:44},(_,i)=>new Date(Date.UTC(2025,10,17+7*i)).toISOString().slice(0,10))');
  const ticks = ui.run('dateTicks(weeks,4,"week","en-US")');
  const spacing = 43 / 3;
  for (const t of ticks.slice(1, -1)) assert.ok(t.index >= spacing / 2 && 43 - t.index >= spacing / 2, `tick ${t.index} crowds an end`);
  const firstNewYear = ticks.find((t) => ui.run(`weeks[${t.index}]`).startsWith("2026"));
  const format = (date, options) => new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"short",...options}).format(new Date(date+"T00:00:00Z"));
  assert.equal(firstNewYear.label, format(ui.run(`weeks[${firstNewYear.index}]`), {day:"numeric",year:"numeric"}), "a mid-year week keeps its day");
});

test("round two aggregates once and shares models without hover recomputation", () => {
  const ui = chartUi(onDays(DAYS));
  ui.run(`globalThis.calls={bucket:0,prepare:0,series:0,ticks:0,styles:0,tables:0};
    const bucket=bucketPeriods,prepare=prepareChartData,series=chartSeries,ticks=dateTicks,table=chartDataTable;
    bucketPeriods=(...a)=>{calls.bucket++;return bucket(...a)};
    prepareChartData=(...a)=>{calls.prepare++;return prepare(...a)};
    chartSeries=(...a)=>{calls.series++;return series(...a)};
    dateTicks=(...a)=>{calls.ticks++;return ticks(...a)};
    chartDataTable=(...a)=>{calls.tables++;return table(...a)};
    getComputedStyle=()=>{calls.styles++;return {getPropertyValue:()=>""}};renderCharts();
    for(let i=0;i<20;i++)periodTooltip(CHART_DAYS.periods[0].key,"tokens:input");`);
  assert.deepEqual({...ui.run('calls')},{bucket:1,prepare:1,series:3,ticks:1,styles:1,tables:0});
});

test("round two lazy data tables build on first opening from the shown model", () => {
  const ui = chartUi(RECORDS); ui.run('renderCharts()');
  for (const match of chartHTML(ui).matchAll(/<details class="chart-data"[\s\S]*?<\/details>/g)) assert.doesNotMatch(match[0], /<tbody>/);
  ui.run(`globalThis.content={innerHTML:""};globalThis.builds=0;const original=chartDataTable;
    chartDataTable=(...a)=>{builds++;return original(...a)};
    globalThis.detail={open:false,dataset:{chartTable:"tokens"},querySelector:()=>content,addEventListener(t,fn){this.toggle=fn}};
    document.querySelectorAll=s=>s==="#charts [data-chart-table]"?[detail]:[];wireCharts();detail.toggle();`);
  assert.equal(ui.run('builds'),0);
  ui.run('detail.open=true;detail.toggle();detail.toggle()');
  assert.equal(ui.run('builds'),1);
  assert.match(ui.run('content.innerHTML'),/<th>Cache read<\/th>/);
  assert.match(ui.run('content.innerHTML'),/<td>3<\/td>/);
  ui.run('state.fields.tokens=false');
  assert.equal(ui.run('chartDataTable("tokens")'),"");
});

test("round two token small multiples give each magnitude its own unoutlined plot", () => {
  const ui = chartUi([{...RECORDS[0],usage:{input:10,output:2,cacheCreate:1,cacheRead:1000000}}, {...RECORDS[1],ts:"2026-08-11T12:00:00Z",usage:{input:8,output:3,cacheCreate:2,cacheRead:800000}}]);
  ui.run('renderCharts()');
  const html=chartHTML(ui);
  assert.equal((html.match(/class="token-panel"/g)||[]).length,4);
  for(const kind of ["input","output","cacheCreate","cacheRead"]) assert.match(html,new RegExp(`data-kind="tokens:${kind}"`));
  const areas=[...html.matchAll(/<path class="token-area"[^>]+>/g)].map(m=>m[0]);
  assert.equal(areas.length,4);
  assert.ok(areas.every(area=>!area.includes("stroke=")));
  assert.match(ui.run('periodTooltip("2026-08-10","tokens:input")'),/Input<i>10/);
  assert.doesNotMatch(ui.run('periodTooltip("2026-08-10","tokens:input")'),/Cache read<i>/);
  ui.run('toggleSeries("tokens:cacheRead")');
  assert.doesNotMatch(chartHTML(ui),/data-kind="tokens:cacheRead"/);
  assert.equal(ui.run('state.view.length'),2);
  const css=fs.readFileSync(path.join(path.dirname(SERVER),"public","styles.css"),"utf8");
  assert.match(css,/\.token-panel \.chart-x span:not\(:first-child\):not\(:last-child\) \{ display: none; \}/);
  assert.match(css,/\.token-panel \.chart-tip \{ max-width: 260px; \}/);
});

test("round two context headline and series use weighted mean and period peak", () => {
  const ui=chartUi([{...RECORDS[0],ts:"2026-01-01T00:00:00Z",contextFillPct:0},{...RECORDS[1],ts:"2026-01-01T01:00:00Z",contextFillPct:90},{...RECORDS[2],ts:"2026-01-02T12:00:00Z",contextFillPct:30},{...RECORDS[0],ts:"2026-01-03T12:00:00Z"}]);
  ui.run('state.chartView.grain="week";renderCharts()');
  assert.equal(ui.run('CHART_DAYS.periods[0].ctxMax'),90);
  assert.equal(ui.run('chartModels.context.mean'),40);
  assert.equal(ui.run('chartModels.context.peak'),90);
  assert.match(chartHTML(ui),/title="Mean of recorded observations in the shown range">40%/);
  const tip=ui.run('periodTooltip("2025-12-29","context")');
  assert.match(tip,/Mean context<i>40%/);assert.match(tip,/Peak context<i>90%/);
  ui.run('state.zoom={from:"2026-01-02",to:"2026-01-03"};renderCharts()');
  assert.equal(ui.run('chartModels.context.mean'),30);
  ui.run('state.chartView.grain="day";renderCharts()');
  assert.deepEqual([...ui.run('chartModels.context.allSeries[1].values')],[30,null]);
  ui.run('toggleSeries("context:peak")');
  assert.doesNotMatch(chartHTML(ui),/data-context="context:peak"/);
});

test("round two validates chart preferences and bounds stored series IDs", () => {
  const ui=chartUi([]);
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(validateChartView(null))')),{axis:"calendar",grain:"auto",hidden:[]});
  const value=ui.run('validateChartView({axis:"fake",grain:"year",hidden:["tokens:input","tokens:input","tokens:reasoning","context:peak","cost:codex","__proto__",{},"cost:<bad>"]})');
  assert.equal(value.axis,"calendar");assert.equal(value.grain,"auto");
  assert.deepEqual([...value.hidden],["tokens:input","context:peak","cost:codex"]);
  assert.equal(ui.run('validateChartView({hidden:Array.from({length:100},(_,i)=>"cost:p"+i)}).hidden.length'),64);
});

test("round two saves and restores chart preferences through config ui", async () => {
  const ui=chartUi(RECORDS);
  ui.run(`globalThis.saved=null;setTimeout=fn=>{fn()};fetch=(url,opts)=>{saved=JSON.parse(opts.body);return Promise.resolve()};
    state.chartView={axis:"active",grain:"month",hidden:[]};toggleSeries("tokens:cacheRead");`);
  const stored=JSON.parse(ui.run('JSON.stringify(saved.ui.chartView)'));
  assert.deepEqual(stored,{axis:"active",grain:"month",hidden:["tokens:cacheRead"]});
  ui.run('state.chartView={};applySettingsVisibility=()=>{};fetch=async()=>({json:async()=>saved})');
  await ui.run('loadConfig()');
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(state.chartView)')),stored);
  assert.equal(ui.run('state.view.length'),3);
});

test("round two chart option changes persist and help keeps shortcuts disclosed", () => {
  const ui=chartUi(onDays(DAYS));
  ui.run(`renderCharts();globalThis.saves=0;persist=()=>{saves++};
    globalThis.select={dataset:{chartOption:"axis"},value:"active",addEventListener(t,fn){this.change=fn},focus(){}};
    document.querySelectorAll=s=>s==="#charts [data-chart-option]"?[select]:[];wireCharts();select.change();`);
  assert.equal(ui.run('saves'),1);
  const hint=ui.run('zoomBar(CHART_DAYS.allKeys,CHART_DAYS.keys)');
  assert.match(hint,/<span class="hint">Drag to zoom · hover or tap to read<\/span>/);
  assert.match(hint,/<details class="chart-help"><summary>Keyboard &amp; help<\/summary>/);
  assert.match(hint,/Shift\+←\/→ to pan/);
});

test("round two served chart strings have no lost question-mark separators", async () => {
  const res=await request(port,"/app.js");assert.equal(res.status,200);
  const chartSource=res.text.slice(res.text.indexOf("// ---------- charts"),res.text.indexOf("// ---------- table"));
  const staticText=[...chartSource.matchAll(/>([^<>\n]*)</g)].map(m=>m[1].replace(/\$\{[^}]*\}/g,"")).join("\n");
  assert.doesNotMatch(staticText,/[\p{L}%] \? \p{L}/u);
  assert.match(res.text,/Context fill % · recorded observations only/);
  for (const file of ["app.js","styles.css","index.html"]) {
    const text=fs.readFileSync(path.join(path.dirname(SERVER),"public",file),"utf8");
    assert.doesNotMatch(text,/\uFFFD/);
  }
});

test("round two restores the original Plex font links", async () => {
  const res=await request(port,"/");
  for(const line of ['<link rel="preconnect" href="https://fonts.googleapis.com" />','<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />','<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />']) assert.ok(res.text.includes(line));
});
