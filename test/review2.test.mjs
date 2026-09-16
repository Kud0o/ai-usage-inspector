import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cleanUpCopies } from "../src/lib/copies.mjs";
import { collapseCopies, upsertSession, tombstonePath, addTombstones } from "../src/lib/store.mjs";
import { ingest, ingestTranscript } from "../src/lib/ingest.mjs";
import { claimScan, recordInstall, repairDue } from "../src/lib/scan-state.mjs";
import { workspaceFile, HOME } from "../src/lib/paths.mjs";
import * as claude from "../src/providers/claude/index.mjs";
import * as codex from "../src/providers/codex/index.mjs";

const root = path.resolve(import.meta.dirname, "..");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (n) => new Date(Date.UTC(2026, 8, 1, 10, 0, n)).toISOString();
const row = (s, n = 1, at = 0, first) => ({ provider: "claude", sessionId: s, id: uuid(n), ts: ts(at), usage: { input: 10 }, ...(first === undefined ? {} : { transcriptFirstTs: ts(first) }) });
const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n"); };
const read = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.AI_USAGE_DIR = path.join(dir, "aggregate");
  fs.mkdirSync(process.env.AI_USAGE_DIR);
  return { dir, backupDir: path.join(dir, "backups"), reportFile: path.join(dir, "report.json") };
}
function transcript(file, session, cwd, first = 0, own = false) {
  write(file, [
    { type: "system", timestamp: ts(first) },
    { type: "user", uuid: uuid(1), sessionId: session, cwd, timestamp: ts(0), promptId: "p", message: { content: "shared" } },
    { type: "assistant", timestamp: ts(1), promptId: "p", message: { id: "m", model: "claude-sonnet-4-5", usage: { input_tokens: 10 }, content: [{ type: "tool_use", id: "call", name: "Agent", input: {} }] } },
    ...(own ? [{ type: "user", uuid: uuid(2), sessionId: session, cwd, timestamp: ts(40), message: { content: "own" } }] : []),
  ]);
}

test("F1 cleanup ownership and labels are independent of all discovery orders", () => {
  const rows = [row("B"), row("A"), row("C"), row("B", 2), row("A", 2), row("C", 2)];
  const signature = (rs) => collapseCopies(rs).records.map((r) => [r.sessionId, r.id, r.branchOf]).sort();
  const expected = signature(rows);
  for (let i = 0; i < rows.length; i++) {
    const rotated = [...rows.slice(i), ...rows.slice(0, i)];
    assert.deepEqual(signature(rotated), expected);
    assert.deepEqual(signature(rotated.reverse()), expected);
  }
});

test("F1 equally recent branch parents use a deterministic final label", () => {
  const rows = [row("A", 1), row("X", 1), row("B", 2), row("X", 2), row("X", 3, 40)];
  const label = (rs) => collapseCopies(rs).records.find((r) => r.sessionId === "X").branchOf;
  assert.equal(label(rows), "A");
  assert.equal(label([...rows].reverse()), "A");
});

test("F1 tied home folders elect the same surviving store in either row order", async (t) => {
  const f = fixture(t);
  const a = path.join(f.dir, "a"), b = path.join(f.dir, "b");
  const rows = [{ ...row("S"), cwd: a }, { ...row("S"), cwd: b }];
  for (const batch of [rows, [...rows].reverse()]) {
    write(workspaceFile(a), batch);
    write(workspaceFile(b), batch);
    await cleanUpCopies(f);
    assert.equal(read(workspaceFile(a)).length, 2);
    assert.equal(read(workspaceFile(b)).length, 0);
  }
});

for (const target of ["usage", "tombstones"]) test(`F1 cleanup aborts before any removal if a ${target} lock is unavailable`, async (t) => {
  const f = fixture(t);
  const files = ["a.ndjson", "b.ndjson", "c.ndjson"].map((n) => path.join(process.env.AI_USAGE_DIR, n));
  files.forEach((file, i) => write(file, [row(String.fromCharCode(65 + i))]));
  const before = files.map((file) => fs.readFileSync(file, "utf8"));
  const lock = (target === "usage" ? files[2] : tombstonePath(files[2])) + ".lock";
  fs.writeFileSync(lock, "held");
  await assert.rejects(cleanUpCopies(f), /lock/i);
  assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
});

test("F1 explicit sync respects the worker scan lease and leaves repair owed", async (t) => {
  const f = fixture(t);
  const state = path.join(f.dir, "state.json");
  const home = path.join(f.dir, "home");
  const file = path.join(home, ".claude", "projects", "p", "A.jsonl");
  transcript(file, "A", f.dir);
  await recordInstall({ file: state, upgrading: true, providerIds: ["claude"] });
  const lease = await claimScan("claude", { file: state });
  const out = fs.openSync(path.join(f.dir, "sync.log"), "w");
  let result;
  try { result = spawnSync(process.execPath, [path.join(root, "src/sync.mjs"), "--provider", "claude"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), AI_USAGE_SCAN_STATE_FILE: state }, stdio: ["ignore", out, out],
  }); } finally { fs.closeSync(out); }
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(workspaceFile(f.dir)), false);
  assert.notEqual(repairDue("claude", { file: state }), null);
  assert.equal(JSON.parse(fs.readFileSync(state)).providers.claude.scanLeaseId, lease);
});

test("F3 cross-store cleanup stays collapsed after fork re-ingestion and original refresh", async (t) => {
  const f = fixture(t);
  const a = path.join(f.dir, "A.jsonl"), b = path.join(f.dir, "B.jsonl");
  const acwd = path.join(f.dir, "a"), bcwd = path.join(f.dir, "b");
  transcript(a, "A", acwd, 0); transcript(b, "B", bcwd, 120, true);
  await ingestTranscript(claude, { transcriptPath: a });
  await ingestTranscript(claude, { transcriptPath: b });
  await cleanUpCopies(f);
  await ingestTranscript(claude, { transcriptPath: b });
  await ingestTranscript(claude, { transcriptPath: a });
  const all = [workspaceFile(acwd), workspaceFile(bcwd)].flatMap(read);
  assert.equal(all.filter((r) => r.id === uuid(1)).length, 1);
  assert.equal(all.find((r) => r.id === uuid(1)).sessionId, "A");
});

test("F3 cleanup preserves an existing user-deletion tombstone", async (t) => {
  const f = fixture(t), file = path.join(process.env.AI_USAGE_DIR, "usage.ndjson");
  write(file, [row("A"), row("B"), row("B", 2, 40)]);
  await addTombstones(tombstonePath(file), [row("B")]);
  const before = JSON.parse(fs.readFileSync(tombstonePath(file), "utf8")).entries[0];
  await cleanUpCopies(f);
  assert.deepEqual(JSON.parse(fs.readFileSync(tombstonePath(file), "utf8")).entries[0], before);
});

test("F4 Codex recorded cwd wins over hook fallback", async (t) => {
  const f = fixture(t), file = path.join(f.dir, "rollout.jsonl");
  const recorded = path.join(f.dir, "recorded"), fallback = path.join(f.dir, "fallback");
  write(file, [
    { type: "session_meta", timestamp: ts(0), payload: { id: "thread", cwd: recorded } },
    { type: "event_msg", timestamp: ts(1), payload: { type: "user_message", message: "hello" } },
    { type: "event_msg", timestamp: ts(2), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } } },
  ]);
  assert.equal(codex.buildTurns(file, { cwd: fallback })[0].cwd, recorded);
});

for (const kind of ["jsonl", "meta.json"]) test(`F5 Claude discovers a parent after only its ${kind} dependency changes`, (t) => {
  const dir = path.join(HOME, ".claude", "projects", `review-${kind}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "A.jsonl");
  transcript(file, "A", dir);
  const old = new Date(Date.now() - 100000);
  fs.utimesSync(file, old, old);
  const dependency = path.join(dir, "A", "subagents", `agent-x.${kind}`);
  write(dependency, kind === "jsonl" ? [{ type: "assistant" }] : [{ toolUseId: "call" }]);
  fs.utimesSync(path.dirname(dependency), old, old);
  assert.ok(claude.discoverTranscripts({ sinceMs: Date.now() - 1000 }).some((r) => r.transcriptPath === file));
});

for (const kind of ["jsonl", "meta.json"]) for (const hook of [false, true]) test(`F5 ${hook ? "hook" : "scan"} rejects a parse when ${kind} changes under the write lock`, async (t) => {
  const f = fixture(t), file = path.join(f.dir, "A.jsonl");
  transcript(file, "A", f.dir);
  const dependency = path.join(f.dir, "A", "subagents", `agent-x.${kind}`);
  write(dependency, kind === "jsonl" ? [{ type: "assistant", promptId: "p" }] : [{ toolUseId: "call" }]);
  await ingestTranscript(claude, { transcriptPath: file });
  const output = workspaceFile(f.dir), before = fs.readFileSync(output, "utf8");
  const open = fs.openSync;
  t.after(() => { fs.openSync = open; });
  fs.openSync = (p, ...args) => { if (p === output + ".lock") fs.appendFileSync(dependency, "\n "); return open(p, ...args); };
  const run = hook ? ingest(claude, JSON.stringify({ session_id: "A", cwd: f.dir, transcript_path: file })) : ingestTranscript(claude, { transcriptPath: file });
  await assert.rejects(run, /transcript changed/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});

for (const dependency of ["directory", "jsonl", "sidecar"]) test(`F5 unreadable Claude ${dependency} retries without overwriting usage`, async (t) => {
  const f = fixture(t), file = path.join(f.dir, "A.jsonl");
  transcript(file, "A", f.dir);
  const sub = path.join(f.dir, "A", "subagents");
  const run = path.join(sub, "agent-x.jsonl"), meta = path.join(sub, "agent-x.meta.json");
  write(run, [{ promptId: "p", type: "assistant", timestamp: ts(5), message: { id: "sub", model: "claude-sonnet-4-5", usage: { input_tokens: 20 }, content: [] } }]);
  fs.writeFileSync(meta, JSON.stringify({ toolUseId: "call" }));
  await ingestTranscript(claude, { transcriptPath: file });
  const output = workspaceFile(f.dir), before = fs.readFileSync(output, "utf8");
  const method = dependency === "directory" ? "readdirSync" : "readFileSync";
  const original = fs[method], target = dependency === "directory" ? sub : dependency === "jsonl" ? run : meta;
  t.after(() => { fs[method] = original; });
  fs[method] = (p, ...args) => { if (path.resolve(String(p)) === target) throw Object.assign(new Error("denied"), { code: "EACCES" }); return original(p, ...args); };
  await assert.rejects(ingestTranscript(claude, { transcriptPath: file }), /denied|unreadable/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});

for (const dependency of ["parent", "directory", "jsonl", "sidecar"]) test(`F5 ${dependency} becoming unreadable only during parsing cannot certify incomplete usage`, async (t) => {
  const f = fixture(t), file = path.join(f.dir, "A.jsonl");
  transcript(file, "A", f.dir);
  const sub = path.join(f.dir, "A", "subagents");
  const run = path.join(sub, "agent-x.jsonl"), meta = path.join(sub, "agent-x.meta.json");
  write(run, [{ type: "assistant", promptId: "p", message: { id: "sub", model: "claude-sonnet-4-5", usage: { input_tokens: 20 }, content: [] } }]);
  fs.writeFileSync(meta, JSON.stringify({ toolUseId: "call" }));
  const method = dependency === "directory" ? "readdirSync" : "readFileSync";
  const original = fs[method], target = dependency === "parent" ? file : dependency === "directory" ? sub : dependency === "jsonl" ? run : meta;
  // The stamp lists the subagent directory but reads no file's bytes, so the
  // parse is the first read of a file and the second listing of the directory.
  const failOn = method === "readdirSync" ? 2 : 1;
  let reads = 0;
  t.after(() => { fs[method] = original; });
  fs[method] = (p, ...args) => {
    if (path.resolve(String(p)) === target && ++reads === failOn) throw Object.assign(new Error("denied during parse"), { code: "EACCES" });
    return original(p, ...args);
  };
  await assert.rejects(ingestTranscript(claude, { transcriptPath: file }), /denied/);
  assert.equal(fs.existsSync(workspaceFile(f.dir)), false);
});

test("F5 discovery picks up a settled parent whose agent run moved", (t) => {
  const dir = path.join(HOME, ".claude", "projects", "review-background");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "A.jsonl");
  transcript(file, "A", dir);
  const old = new Date(Date.now() - 100000);
  fs.utimesSync(file, old, old);
  const window = { sinceMs: Date.now() - 1000 };
  assert.equal(claude.discoverTranscripts(window).some((r) => r.transcriptPath === file), false);
  // A background run finishing writes only under the session's own folder. The
  // parent has not moved, and without it the run's usage would never be read.
  write(path.join(dir, "A", "subagents", "agent-x.jsonl"), [
    { promptId: "p", type: "assistant", message: { id: "sub", model: "claude-sonnet-4-5", usage: { input_tokens: 20 }, content: [] } },
  ]);
  assert.ok(claude.discoverTranscripts(window).some((r) => r.transcriptPath === file));
});

test("F5 discovery keeps a parent it cannot stat, so the scan retries", (t) => {
  const dir = path.join(HOME, ".claude", "projects", "review-unreadable");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "A.jsonl");
  transcript(file, "A", dir);
  const old = new Date(Date.now() - 100000);
  fs.utimesSync(file, old, old);
  const original = fs.statSync;
  t.after(() => { fs.statSync = original; });
  fs.statSync = (p, ...args) => {
    if (path.resolve(String(p)) === path.resolve(file)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(p, ...args);
  };
  assert.ok(claude.discoverTranscripts({ sinceMs: Date.now() - 1000 }).some((r) => r.transcriptPath === file));
});

test("F5 completed background usage is imported while parent bytes stay unchanged", async (t) => {
  const f = fixture(t), file = path.join(f.dir, "A.jsonl");
  transcript(file, "A", f.dir);
  const before = fs.readFileSync(file, "utf8");
  await ingestTranscript(claude, { transcriptPath: file });
  const sub = path.join(f.dir, "A", "subagents");
  write(path.join(sub, "agent-x.jsonl"), [{ type: "assistant", promptId: "p", message: { id: "sub", model: "claude-sonnet-4-5", usage: { input_tokens: 20 }, content: [] } }]);
  fs.writeFileSync(path.join(sub, "agent-x.meta.json"), JSON.stringify({ toolUseId: "call" }));
  await ingestTranscript(claude, { transcriptPath: file });
  assert.equal(read(workspaceFile(f.dir))[0].usage.input, 30);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("F5 an unreadable initial stamp cannot disable the ingestion guard", async (t) => {
  const f = fixture(t), file = path.join(f.dir, "A.jsonl");
  transcript(file, "A", f.dir);
  const original = fs.readFileSync;
  let reads = 0;
  t.after(() => { fs.readFileSync = original; });
  fs.readFileSync = (p, ...args) => {
    if (p === file && ++reads === 1) throw Object.assign(new Error("unreadable initial stamp"), { code: "EACCES" });
    return original(p, ...args);
  };
  await assert.rejects(ingestTranscript(claude, { transcriptPath: file }), /unreadable/);
  assert.equal(fs.existsSync(workspaceFile(f.dir)), false);
});

test("F5 an empty parse still checks dependency staleness", async (t) => {
  const f = fixture(t), file = path.join(f.dir, "A.jsonl");
  transcript(file, "A", f.dir);
  const changing = { ...claude, buildTurns: (p) => { fs.writeFileSync(p, ""); return claude.buildTurns(p); } };
  await assert.rejects(ingestTranscript(changing, { transcriptPath: file }), /transcript changed/);
});

test("F6 parser persists first-entry timestamp even within the copied window", (t) => {
  const f = fixture(t), file = path.join(f.dir, "B.jsonl");
  transcript(file, "B", f.dir, 20, true);
  assert.ok(claude.buildTurns(file).every((r) => r.transcriptFirstTs === ts(20)));
});

test("F6 durable first-entry evidence beats misleading continuation timing in either ingest order", async (t) => {
  const f = fixture(t);
  const sessions = { Z: [row("Z", 1, 0, 0), row("Z", 3, 50, 0)], A: [row("A", 1, 0, 20), row("A", 2, 40, 20)] };
  for (const order of [["Z", "A"], ["A", "Z"]]) {
    const file = path.join(f.dir, order.join("") + ".ndjson");
    for (let pass = 0; pass < 2; pass++) for (const s of order) await upsertSession(file, s, sessions[s], { transcriptId: s });
    assert.equal(read(file).find((r) => r.id === uuid(1)).sessionId, "Z");
    assert.equal(read(file).find((r) => r.sessionId === "A").branchResolution, "resolved");
  }
  assert.equal(collapseCopies([...sessions.A, ...sessions.Z]).records.find((r) => r.id === uuid(1)).sessionId, "Z");
});

test("F6 continuation first-entry is not session birth and missing evidence remains unresolved", async (t) => {
  const f = fixture(t), file = path.join(f.dir, "usage.ndjson");
  await upsertSession(file, "Z", [row("Z", 9, -20, -20)], { transcriptId: "early" });
  await upsertSession(file, "A", [row("A", 1, 0, 20), row("A", 2, 40, 20)], { transcriptId: "A" });
  await upsertSession(file, "Z", [row("Z", 1, 0, 60), row("Z", 3, 50, 60)], { transcriptId: "continuation" });
  assert.equal(read(file).find((r) => r.id === uuid(1)).sessionId, "Z");
  assert.equal(read(file).find((r) => r.sessionId === "A").branchResolution, "resolved");
  // Rows an older version wrote name no first entry. The session this version
  // has actually read keeps the turn — a batch skipped on timing alone is never
  // written, so the repair could not correct it later — and the pair stays marked
  // unresolved until the other transcript is read too.
  const legacy = path.join(f.dir, "legacy.ndjson");
  await upsertSession(legacy, "Z", [row("Z")]);
  await upsertSession(legacy, "A", [row("A", 1, 0, 20), row("A", 2, 40, 20)]);
  assert.deepEqual(read(legacy).filter((r) => r.id === uuid(1)).map((r) => r.sessionId), ["A"]);
  assert.equal(read(legacy).some((r) => r.branchOf), false, "nothing is called a branch on evidence this thin");
});

test("F6 two continuation-only sources keep direction explicitly unresolved", () => {
  const rows = [row("Z", 1, 0, 60), row("A", 1, 0, 20), row("A", 2, 40, 20)];
  const result = collapseCopies(rows).records;
  assert.equal(result.find((r) => r.id === uuid(1)).sessionId, "Z");
  assert.equal(result.find((r) => r.sessionId === "A").branchResolution, "unresolved");
});

test("F6 earlier source evidence never substitutes stale usage for the incoming turn", async (t) => {
  const f = fixture(t), file = path.join(f.dir, "usage.ndjson");
  write(file, [
    { ...row("Z", 1, 0, 0), transcriptId: "early" },
    { ...row("A", 1, 0, 20), usage: { input: 30 } },
    row("A", 2, 40, 20),
  ]);
  await upsertSession(file, "Z", [{ ...row("Z", 1, 0, 0), usage: { input: 40 } }], { transcriptId: "early" });
  const held = read(file).find((r) => r.id === uuid(1));
  assert.equal(held.sessionId, "Z");
  assert.equal(held.usage.input, 40);
});

test("F7 npm package allowlist covers runtime and excludes test trees", (t) => {
  const f = fixture(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  assert.ok(Array.isArray(pkg.files), "package contents must have an allowlist");
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const output = path.join(f.dir, "pack.json"), errors = path.join(f.dir, "pack.err");
  const out = fs.openSync(output, "w"), err = fs.openSync(errors, "w");
  let result;
  try { result = spawnSync(fs.existsSync(cli) ? process.execPath : "npm", [...(fs.existsSync(cli) ? [cli] : []), "pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], {
    cwd: root, env: { ...process.env, npm_config_cache: path.join(f.dir, "cache"), npm_config_userconfig: path.join(f.dir, "npmrc"), npm_config_globalconfig: path.join(f.dir, "global-npmrc"), npm_config_update_notifier: "false" }, stdio: ["ignore", out, err],
  }); } finally { fs.closeSync(out); fs.closeSync(err); }
  assert.ifError(result.error);
  assert.equal(result.status, 0, fs.readFileSync(errors, "utf8"));
  const packed = new Set(JSON.parse(fs.readFileSync(output, "utf8"))[0].files.map((r) => r.path));
  assert.ok(![...packed].some((p) => /^(test|test-support)\//.test(p)));
  const visit = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? visit(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
  for (const required of ["install.mjs", "package.json", "README.md", "LICENSE", ...visit("src"), ...visit("viewer"), ...visit("docs")]) assert.ok(packed.has(required), `missing ${required}`);
});
