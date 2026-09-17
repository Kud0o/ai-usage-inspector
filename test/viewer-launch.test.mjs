import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { ensureBundleForTest } from "../src/lib/ingest.mjs";
import { openBrowser } from "../viewer/launch.mjs";
import { coordinateStartup, ensureRuntimeDir, refuseReason, runtimeDirUsable, runtimePaths } from "../viewer/runtime.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("simultaneous launchers serialize startup and reuse the winner", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-launchrace-"));
  const dataDir = path.join(project, ".ai-usage");
  fs.mkdirSync(dataDir);
  const paths = runtimePaths(dataDir);
  t.after(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  let starts = 0;
  const verify = async (runtime) => runtime && runtime.ready === true;
  const start = async () => {
    starts++;
    await pause(40);
    const runtime = { nonce: `winner-${starts}`, port: 4317, ready: true };
    fs.writeFileSync(paths.runtimeFile, JSON.stringify(runtime));
    return runtime;
  };
  const options = { ...paths, verify, start, staleMs: 500, waitMs: 1000, pollMs: 5 };
  const [first, second] = await Promise.all([
    coordinateStartup(options),
    coordinateStartup(options),
  ]);

  assert.equal(starts, 1, "only the exclusive-lock owner starts a server");
  assert.equal(first.runtime.nonce, second.runtime.nonce, "the contender adopts the verified winner");
  assert.equal([first.started, second.started].filter(Boolean).length, 1);
});

test("a stale startup lock cannot wedge later launchers", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-stalelock-"));
  const dataDir = path.join(project, ".ai-usage");
  fs.mkdirSync(dataDir);
  const paths = runtimePaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.lockFile, JSON.stringify({ token: "crashed" }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(paths.lockFile, old, old);
  t.after(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  let started = 0;
  const result = await coordinateStartup({
    ...paths,
    verify: async () => false,
    start: async () => { started++; return { nonce: "fresh", port: 4317 }; },
    staleMs: 10,
    waitMs: 500,
    pollMs: 5,
  });
  assert.equal(started, 1);
  assert.equal(result.runtime.nonce, "fresh");
});

function fakeChild(outcome) {
  const child = new EventEmitter();
  queueMicrotask(() => {
    if (outcome === "error") child.emit("error", new Error("not installed"));
    else child.emit("close", outcome);
  });
  return child;
}

test("browser opening observes async failure and tries the Linux fallback", async () => {
  const calls = [];
  const outcomes = [1, 0];
  const opened = await openBrowser("http://localhost:4317", {
    platform: "linux",
    spawnImpl(command) {
      calls.push(command);
      return fakeChild(outcomes.shift());
    },
  });
  assert.equal(opened, true);
  assert.deepEqual(calls, ["xdg-open", "gio"]);
});

test("browser opening reports failure when the fallback emits an error", async () => {
  const outcomes = ["error", "error"];
  const opened = await openBrowser("http://localhost:4317", {
    platform: "linux",
    spawnImpl() { return fakeChild(outcomes.shift()); },
  });
  assert.equal(opened, false);
});

// Windows and macOS give each user a private temp directory; Linux's /tmp is
// shared and world-writable. A predictable path under it is somebody else's to
// create first — they could plant a lock, or plant a runtime record naming a
// server of their own, and the launcher would verify it and open a browser on
// their page believing it was the user's dashboard.
test("the runtime root is per-user, not a shared path", () => {
  const { dir } = runtimePaths("/some/project/.ai-usage");
  const root = path.dirname(dir);
  if (process.platform === "win32") {
    assert.equal(root, path.join(os.tmpdir(), "ai-usage-inspector"), "Windows temp is already per-user");
    return;
  }
  // The exact root, not "contains the uid": a sha256 hex digest nearly always
  // contains a 0, so that check passed for uid 0 even with the old shared layout.
  const expected = [path.join(os.tmpdir(), `ai-usage-inspector-${process.getuid()}`)];
  if (process.env.XDG_RUNTIME_DIR) expected.push(path.join(process.env.XDG_RUNTIME_DIR, "ai-usage-inspector"));
  assert.ok(expected.includes(root), `expected a per-user root, got ${root}`);
});

// These checks only bite on Linux, where /tmp is shared — which is precisely
// where they would otherwise never be exercised. Driving the decision directly
// runs them on every platform.
test("a directory another user owns is refused", () => {
  const stat = { isDirectory: () => true, uid: 1000, mode: 0o700 };
  assert.equal(refuseReason(stat, { uid: 1001 }), "belongs to another user");
});

test("a world-writable directory is refused", () => {
  const stat = { isDirectory: () => true, uid: 1000, mode: 0o777 };
  assert.equal(refuseReason(stat, { uid: 1000 }), "is accessible to other users");
});

test("a symlink standing in for the directory is refused", () => {
  // lstat does not follow, so a planted symlink reports as a link, not a dir.
  const stat = { isDirectory: () => false, uid: 1000, mode: 0o777 };
  assert.equal(refuseReason(stat, { uid: 1000 }), "is not a directory");
});

test("our own private directory is accepted", () => {
  const stat = { isDirectory: () => true, uid: 1000, mode: 0o700 };
  assert.equal(refuseReason(stat, { uid: 1000 }), null);
});

// Windows has no uid and a per-user temp directory, so ownership is not checked.
test("a directory is still accepted where the platform has no uid", () => {
  const stat = { isDirectory: () => true, uid: undefined, mode: 0o700 };
  assert.equal(refuseReason(stat, { uid: null }), null);
});

test("XDG_RUNTIME_DIR is trusted only when it is a private directory of ours", () => {
  const ours = { isDirectory: () => true, uid: 1000, mode: 0o700 };
  assert.equal(runtimeDirUsable("/run/user/1000", ours, { uid: 1000 }), true);
  assert.equal(runtimeDirUsable("run/user/1000", ours, { uid: 1000 }), false, "a relative path");
  assert.equal(runtimeDirUsable("/run/user/1000", null, { uid: 1000 }), false, "a directory that is not there");
  assert.equal(runtimeDirUsable("/tmp", { isDirectory: () => true, uid: 0, mode: 0o1777 }, { uid: 1000 }), false, "shared /tmp");
  assert.equal(runtimeDirUsable("/run/user/1000", { ...ours, mode: 0o750 }, { uid: 1000 }), false, "a group can enter it");
  assert.equal(runtimeDirUsable("/run/user/1000", { ...ours, isDirectory: () => false }, { uid: 1000 }), false, "a symlink");
});

// Checking a lock's age and moving it aside are two steps. When the winner
// replaces the stale lock in between, the loser must not carry the fresh one away.
test("a fresh lock that replaced a stale one between check and claim is put back", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-aba-"));
  const dataDir = path.join(project, ".ai-usage");
  fs.mkdirSync(dataDir);
  const paths = runtimePaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.lockFile, JSON.stringify({ token: "crashed" }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(paths.lockFile, old, old);
  const realRename = fs.renameSync;
  let swapped = false;
  fs.renameSync = (from, to) => {
    if (!swapped && from === paths.lockFile) {
      swapped = true;
      fs.rmSync(paths.lockFile, { force: true });
      fs.writeFileSync(paths.lockFile, JSON.stringify({ token: "winner" }));
    }
    return realRename.call(fs, from, to);
  };
  t.after(() => {
    fs.renameSync = realRename;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  let started = 0;
  const result = await coordinateStartup({
    ...paths,
    verify: async () => false,
    start: async () => { started++; return { nonce: "second", port: 4317 }; },
    staleMs: 5_000,
    waitMs: 300,
    pollMs: 10,
  });
  assert.equal(started, 0, "no second server while the winner holds the lock");
  assert.equal(result.runtime, null);
  assert.equal(JSON.parse(fs.readFileSync(paths.lockFile, "utf8")).token, "winner", "the winner's lock is back");
});

test("a claim left by a contender that died is cleared, a live one is not", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-reap-"));
  const dataDir = path.join(project, ".ai-usage");
  fs.mkdirSync(dataDir);
  const paths = runtimePaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  t.after(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });
  const dead = `${paths.lockFile}.stale-dead`;
  const live = `${paths.lockFile}.stale-live`;
  fs.writeFileSync(dead, "{}");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(dead, old, old);
  fs.writeFileSync(live, "{}");
  fs.writeFileSync(paths.runtimeFile, JSON.stringify({ nonce: "up", port: 4317 }));

  const result = await coordinateStartup({
    ...paths,
    verify: async (runtime) => runtime.nonce === "up",
    start: async () => { throw new Error("must not start"); },
    staleMs: 5_000,
    waitMs: 300,
    pollMs: 10,
  });
  assert.equal(result.started, false);
  assert.equal(fs.existsSync(dead), false, "the dead claim is gone");
  assert.equal(fs.existsSync(live), true, "a claim still in use is left alone");
});

test("the runtime base is checked, not only the project directory", { skip: process.platform === "win32" && "ownership and modes are POSIX" }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-base-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.chmodSync(base, 0o777);
  const leaf = path.join(base, "project");
  ensureRuntimeDir(leaf);
  assert.equal(fs.statSync(base).mode & 0o777, 0o700, "an open base of ours is tightened");
  assert.equal(fs.statSync(leaf).mode & 0o777, 0o700);
});

// The bundle a project gets must run on its own. A sweep run from a checkout
// copies that checkout's viewer/, which carries no settings module, and every
// dashboard it wrote then died on an import before it could listen — twenty
// seconds of waiting, and nothing said why.
test("the bundle a project is given starts and serves, whatever tree wrote it", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-bundle-"));
  const paths = runtimePaths(path.join(project, ".ai-usage"));
  const previous = process.env.AI_USAGE_DIR;
  delete process.env.AI_USAGE_DIR;
  let server = null;
  // One teardown, in order: the server holds the project as its working
  // directory, and Windows refuses to remove a directory while it does.
  t.after(async () => {
    if (previous !== undefined) process.env.AI_USAGE_DIR = previous;
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    for (const dir of [project, paths.dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
  ensureBundleForTest(project);
  const bundle = path.join(project, ".ai-usage", "viewer");
  assert.ok(fs.existsSync(path.join(bundle, "config.mjs")), "the settings module travels with the bundle");

  // Start it the way the launcher does, from a copy that has no src/ beside it.
  // File output works in Windows sandboxes that refuse child-process pipes.
  const logFile = path.join(project, "bundle.log"), log = fs.openSync(logFile, "w");
  try {
    server = spawn(process.execPath, [path.join(bundle, "server.mjs"), "--no-sync", "--no-pricing-refresh"], {
      cwd: project,
      env: { ...process.env, AI_USAGE_INSTANCE: "bundle-test", PORT: "0" },
      stdio: ["ignore", log, log],
    });
  } finally { fs.closeSync(log); }
  const deadline = Date.now() + 20_000;
  let runtime = null;
  while (Date.now() < deadline && !runtime) {
    await pause(100);
    try { runtime = JSON.parse(fs.readFileSync(paths.runtimeFile, "utf8")); } catch {}
    if (server.exitCode !== null) break;
  }
  assert.ok(runtime && runtime.port, `the bundled dashboard never listened:\n${fs.readFileSync(logFile, "utf8")}`);
  const res = await fetch(`http://127.0.0.1:${runtime.port}/api/status`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).app, "ai-usage-inspector");
});
