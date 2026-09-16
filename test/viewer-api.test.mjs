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
  const ctx = vm.createContext({ document, Intl, setTimeout, clearTimeout });
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
