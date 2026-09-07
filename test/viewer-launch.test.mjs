import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openBrowser } from "../viewer/launch.mjs";
import { coordinateStartup, runtimePaths } from "../viewer/runtime.mjs";

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
