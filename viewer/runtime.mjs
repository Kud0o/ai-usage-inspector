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

// Where machine-local coordination lives.
//
// Windows and macOS give each user a private temp directory, but on Linux
// os.tmpdir() is /tmp — shared and world-writable. A predictable path under it
// is somebody else's to create first: they could plant a lock, or plant a
// runtime record naming a server of their own, and the launcher would verify it
// and open a browser on their page believing it was your dashboard. So prefer
// the per-user runtime directory the OS already provides, fall back to a
// uid-qualified name, and refuse to use a directory that is not ours.
function runtimeRoot() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "ai-usage-inspector");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return path.join(os.tmpdir(), uid === null ? "ai-usage-inspector" : `ai-usage-inspector-${uid}`);
}

/**
 * Would we trust this directory, given what a stat says about it?
 *
 * Separated from the filesystem so it can be exercised everywhere, not only on
 * the platform where it matters: Windows and macOS hand each user a private
 * temp directory, so the checks below only ever bite on Linux, which is exactly
 * where they would otherwise go untested.
 *
 * Returns null when the directory is ours, or the reason to refuse it.
 */
export function refuseReason(st, { uid = null } = {}) {
  if (!st || !st.isDirectory()) return "is not a directory";
  if (uid !== null && st.uid !== uid) return "belongs to another user";
  if (st.mode & 0o077) return "is accessible to other users";
  return null;
}

/**
 * Create a directory we are willing to trust, or throw.
 *
 * mkdir's mode only applies to directories it actually creates, so an existing
 * path proves nothing about who owns it. A symlink, another user's directory, or
 * one others can write to means somebody got there first, and on a shared /tmp
 * that is how a planted lock or a forged runtime record gets in.
 */
export function ensureOwnedDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return dir;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let reason = refuseReason(fs.lstatSync(dir), { uid });
  if (reason === "is accessible to other users") {
    // Ours, merely too open: tighten rather than refuse.
    fs.chmodSync(dir, 0o700);
    reason = refuseReason(fs.lstatSync(dir), { uid });
  }
  if (reason) throw new Error(`${dir} ${reason}`);
  return dir;
}

export function runtimePaths(dataDir) {
  const key = crypto.createHash("sha256").update(canonicalProjectPath(dataDir)).digest("hex");
  const dir = path.join(runtimeRoot(), key);
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

function removeStaleLock(lockFile, staleMs, token) {
  try {
    const before = fs.statSync(lockFile);
    if (Date.now() - before.mtimeMs <= staleMs) return false;
    // Claim the stale lock by moving it aside. Only one rename can succeed, so
    // a slower contender cannot delete the fresh lock its winner just created.
    const claimed = `${lockFile}.stale-${token}`;
    fs.renameSync(lockFile, claimed);
    fs.rmSync(claimed, { force: true });
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
  ensureOwnedDir(path.dirname(lockFile));

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
      removeStaleLock(lockFile, staleMs, token);
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
