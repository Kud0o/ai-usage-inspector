import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonicalProjectPath(dataDir) {
  const resolved = path.resolve(dataDir);
  const project = path.basename(resolved) === ".ai-usage" ? path.dirname(resolved) : resolved;
  let canonical = project;
  try {
    canonical = fs.realpathSync.native(project);
  } catch {}
  // Windows paths name the same project regardless of drive-letter or segment
  // casing, so their coordination key must do the same.
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function runtimePaths(dataDir) {
  const key = crypto.createHash("sha256").update(canonicalProjectPath(dataDir)).digest("hex");
  const dir = path.join(os.tmpdir(), "ai-usage-inspector", key);
  return {
    dir,
    runtimeFile: path.join(dir, "viewer-runtime.json"),
    lockFile: path.join(dir, "viewer-start.lock"),
  };
}

export function readRuntime(runtimeFile) {
  try {
    const value = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    return value && value.port && value.nonce ? value : null;
  } catch {
    return null;
  }
}

function removeStaleLock(lockFile, staleMs) {
  try {
    const before = fs.statSync(lockFile);
    if (Date.now() - before.mtimeMs <= staleMs) return false;
    const token = fs.readFileSync(lockFile, "utf8");
    const after = fs.statSync(lockFile);
    if (after.mtimeMs !== before.mtimeMs || fs.readFileSync(lockFile, "utf8") !== token) return false;
    fs.rmSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockFile, token) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    // A stale owner can wake after its lock was replaced; it must not release
    // the new launcher's lock on its way out.
    if (owner && owner.token === token) fs.rmSync(lockFile);
  } catch {}
}

// A port probe cannot serialize launchers; exclusive creation makes the right
// to spawn atomic, while verification lets contenders leave the winner alone.
export async function coordinateStartup({
  runtimeFile,
  lockFile,
  verify,
  start,
  staleMs = 30_000,
  waitMs = 55_000,
  pollMs = 100,
}) {
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });

  while (Date.now() < deadline) {
    const running = readRuntime(runtimeFile);
    if (running && (await verify(running))) return { runtime: running, started: false };

    let fd;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
    } catch (err) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (!err || err.code !== "EEXIST") throw err;
      removeStaleLock(lockFile, staleMs);
      await sleep(pollMs);
      continue;
    }

    fs.closeSync(fd);
    try {
      // The prior owner may have completed between our last check and its
      // release. Verify its result before starting anything ourselves.
      const winner = readRuntime(runtimeFile);
      if (winner && (await verify(winner))) return { runtime: winner, started: false };
      return { runtime: await start(), started: true };
    } finally {
      releaseLock(lockFile, token);
    }
  }
  return { runtime: null, started: false };
}
