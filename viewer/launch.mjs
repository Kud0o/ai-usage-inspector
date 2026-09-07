#!/usr/bin/env node
// Opens this project's dashboard from a double-clicked file.
//
// The file the user clicks is a tiny platform shim (.cmd / .command / .sh) that
// runs this. Everything real happens here so the shims stay trivial and the
// logic stays one cross-platform thing:
//
//   1. Is a server for THIS project already up? Reuse it — a second click opens
//      another tab, without racing another launcher into starting a second server.
//   2. Otherwise start one detached, with no console window, and wait until it
//      is actually listening rather than sleeping and hoping.
//   3. Open the browser at the port it really chose (which is not always 4317).
//
// The server it starts is given an instance nonce; it records that, its port and
// its pid in machine-local temporary state and serves the identity on
// /api/status. That pair is what makes reuse safe: a pid alone is meaningless
// once the OS recycles it, and something else entirely may be sitting on the port.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coordinateStartup, readRuntime, runtimePaths } from "./runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "..");            // <project>/.ai-usage
const SERVER = path.join(HERE, "server.mjs");
const { runtimeFile: RUNTIME_FILE, lockFile: START_LOCK } = runtimePaths(DATA_DIR);
const READY_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is the thing on that port our server, for this project? */
async function verify(runtime) {
  if (!runtime) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/status`, {
      headers: { "X-AI-Usage-Launcher": runtime.nonce },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const s = await res.json();
    return s.app === "ai-usage-inspector"
      && s.nonce === runtime.nonce
      && path.resolve(s.dataDir) === path.resolve(DATA_DIR);
  } catch {
    return false;
  }
}

function runOpen(command, args, spawnImpl) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once("error", () => done(false));
    child.once("close", (code) => done(code === 0));
  });
}

export async function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let methods;
  if (platform === "win32") {
    // The empty string is start's window-title argument; without it a quoted
    // URL is taken as the title and nothing opens.
    methods = [["cmd", ["/c", "start", "", url]]];
  } else if (platform === "darwin") {
    methods = [["open", [url]]];
  } else {
    methods = [["xdg-open", [url]], ["gio", ["open", url]]];
  }
  for (const [command, args] of methods) {
    if (await runOpen(command, args, spawnImpl)) return true;
  }
  return false;
}

async function startServer() {
  const nonce = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.resolve(DATA_DIR, ".."),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, AI_USAGE_INSTANCE: nonce },
  });
  child.unref();

  // Wait for the server to say where it landed, then confirm it answers. A
  // fixed sleep would either open a dead page or waste time on a fast machine.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runtime = readRuntime(RUNTIME_FILE);
    if (runtime && runtime.nonce === nonce && (await verify(runtime))) return runtime;
    await sleep(150);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(SERVER)) {
    console.error(`\n  Cannot find the dashboard next to this file:\n    ${SERVER}\n`);
    process.exitCode = 1;
    return;
  }

  const result = await coordinateStartup({
    runtimeFile: RUNTIME_FILE,
    lockFile: START_LOCK,
    verify,
    start: startServer,
  });
  const runtime = result.runtime;
  if (runtime && !result.started) {
    console.log(`\n  Dashboard already running  ->  http://localhost:${runtime.port}`);
  } else if (runtime) {
    console.log("\n  Starting the dashboard...");
  }

  if (!runtime) {
    console.error("\n  The dashboard did not start in time.");
    console.error("  Run it directly to see why:");
    console.error(`    node "${SERVER}"\n`);
    process.exitCode = 1;
    return;
  }

  const url = `http://localhost:${runtime.port}`;
  if (!(await openBrowser(url))) {
    console.error("\n  Could not open a browser. Open this URL yourself:");
    console.error(`  ${url}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${url}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n  ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
