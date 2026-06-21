// Lock-guarded, atomic upsert of turn records into a per-workspace ndjson file.
// Safe for concurrent Claude Code sessions in the same folder. Zero deps.
import fs from "node:fs";
import path from "node:path";

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (true) {
    try {
      fd = fs.openSync(lock, "wx"); // atomic exclusive create
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Steal a stale lock left by a crashed process.
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished — retry
      }
      if (Date.now() > deadline) return false; // give up; next Stop self-heals
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    fn();
    return true;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.rmSync(lock, { force: true });
    } catch {}
  }
}

function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

/**
 * Replace this session's records inside the workspace file with `records`,
 * preserving every other session's records. Atomic (tmp + rename).
 */
export async function upsertSession(file, sessionId, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    const existing = readRecords(file).filter((r) => r.sessionId !== sessionId);
    const merged = existing.concat(records);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.renameSync(tmp, file); // atomic on Windows + POSIX
  });
}
