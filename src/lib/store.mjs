// Lock-guarded, atomic mutation of per-workspace usage + tombstone files.
// Safe for concurrent agent sessions and viewer deletes. Zero deps.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const TOMBSTONE_FILE = "tombstones.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempName = (file) => `${file}.${process.pid}.${randomUUID()}.tmp`;

function readToken(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function removeOwned(file, token) {
  try {
    if (readToken(file) === token) fs.rmSync(file, { force: true });
  } catch {}
}

/** Run `fn` under an owner-token lock. Returns false when lock times out. */
export async function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;

  while (true) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, token, "utf8");
      break;
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        fd = null;
      }
      if (err.code !== "EEXIST") throw err;

      // Read owner before considering a steal, then re-read immediately before
      // removal. A replaced lock has a different token and is left untouched.
      try {
        const seen = readToken(lock);
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (seen !== null && age > LOCK_STALE_MS && readToken(lock) === seen) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished -- retry
      }
      if (Date.now() > deadline) return false;
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    const value = await fn();
    return value === undefined ? true : value;
  } finally {
    try { fs.closeSync(fd); } catch {}
    removeOwned(lock, token);
  }
}

function atomicWrite(file, text) {
  const tmp = tempName(file);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

/** Locked JSON read-modify-write using same owner-token lock + atomic temp path. */
export async function mutateJson(file, fn, fallback = {}) {
  return withFileLock(file, () => {
    let current = fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") current = parsed;
    } catch {}
    const changed = fn(current);
    const next = changed && Object.hasOwn(changed, "data") ? changed.data : changed;
    const value = changed && Object.hasOwn(changed, "data") ? changed.value : undefined;
    atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
    return value === undefined ? true : value;
  });
}

function readNdjson(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}

  const records = [];
  const malformed = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      records.push(JSON.parse(raw.trim()));
    } catch {
      malformed.push(raw); // carry byte-for-byte line content through rewrites
    }
  }
  return { text, records, malformed };
}

function encodeNdjson(records, malformed) {
  const lines = records.map((r) => JSON.stringify(r)).concat(malformed);
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Mutate valid records under the usage-file lock. Malformed lines never enter
 * the callback and are carried through unchanged at the end of the file.
 * Callback returns either records[] or { records, value }.
 */
export const ABORT = Symbol("abort-mutation");

export async function mutateNdjson(file, fn) {
  return withFileLock(file, () => {
    const current = readNdjson(file);
    const changed = fn(current.records.slice());
    // A caller can only decide "is this still worth writing?" while holding the
    // lock; checking beforehand leaves a window for the file to move.
    if (changed === ABORT) {
      return {
        value: ABORT,
        beforeBytes: Buffer.byteLength(current.text),
        afterBytes: Buffer.byteLength(current.text),
        malformed: current.malformed.length,
      };
    }
    const nextRecords = Array.isArray(changed) ? changed : changed.records;
    const value = Array.isArray(changed) ? undefined : changed.value;
    const out = encodeNdjson(nextRecords, current.malformed);
    atomicWrite(file, out);
    return {
      value,
      beforeBytes: Buffer.byteLength(current.text),
      afterBytes: Buffer.byteLength(out),
      malformed: current.malformed.length,
    };
  });
}

export function tombstonePath(usageFile) {
  return path.join(path.dirname(usageFile), TOMBSTONE_FILE);
}

export function tombstoneKey(value) {
  const provider = value && value.provider ? String(value.provider) : "claude";
  const sessionId = value && value.sessionId != null ? String(value.sessionId) : "";
  const id = value && value.id != null ? String(value.id) : "";
  return JSON.stringify([provider, sessionId, id]);
}

function readTombstones(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function loadTombstoneKeys(file) {
  return new Set(readTombstones(file).map(tombstoneKey));
}

/** Add/dedupe composite tombstones. No expiry: expiry could resurrect history. */
export async function addTombstones(file, values) {
  if (!values || !values.length) return 0;
  return withFileLock(file, () => {
    const byKey = new Map(readTombstones(file).map((t) => [tombstoneKey(t), t]));
    let added = 0;
    for (const value of values) {
      if (!value || value.id == null) continue;
      const entry = {
        provider: value.provider || "claude",
        sessionId: value.sessionId == null ? "" : value.sessionId,
        id: value.id,
        deletedAt: new Date().toISOString(),
      };
      const key = tombstoneKey(entry);
      if (!byKey.has(key)) added++;
      byKey.set(key, entry);
    }
    atomicWrite(file, JSON.stringify({ schema: 1, entries: [...byKey.values()] }, null, 2) + "\n");
    return added;
  });
}

// A cost WE computed from a rate table ("priced"/"estimated") must not silently
// change when history is re-scanned with today's rates — what a turn cost is a
// fact about when it ran. A cost the tool itself reported ("provider") is always
// taken fresh, since the tool is the authority on its own number. Set
// AI_USAGE_REPRICE=1 (sync --reprice) to deliberately recompute.
const COMPUTED_COST_SOURCES = new Set(["priced", "estimated"]);

const COST_AMOUNT_FIELDS = ["input", "output", "cacheWrite", "cacheRead", "total"];

/** Do two cost objects claim the same money? Provenance is ignored. */
function sameAmount(a, b) {
  return COST_AMOUNT_FIELDS.every((k) => {
    const x = a[k], y = b[k];
    // Only real numbers compare: a missing or NaN field means we do not know the
    // amounts match, and must not treat that as licence to relabel.
    return typeof x === "number" && typeof y === "number"
      && Number.isFinite(x) && Number.isFinite(y) && x === y;
  });
}

function preserveComputedCost(next, previous) {
  if (process.env.AI_USAGE_REPRICE === "1") return next;
  if (!previous || !previous.cost || !next || !next.cost) return next;
  if (!COMPUTED_COST_SOURCES.has(previous.cost.source)) return next;
  if (!COMPUTED_COST_SOURCES.has(next.cost.source)) return next;
  // The amount is preserved, but its provenance is not part of that promise: if
  // we now know the same number came from a guessed rate, say so. Without this a
  // row mislabelled by an older version stays mislabelled forever, because the
  // only escape was --reprice, which also restates the amount at today's rates.
  // Automatic correction only ever moves toward the more cautious label: a row
  // known to rest on a guess stays marked, even if a later scan happens to price
  // it exactly. Otherwise the marker flickers as the rate cache warms and cools.
  if (sameAmount(previous.cost, next.cost)
      && previous.cost.source === "priced" && next.cost.source === "estimated") {
    return next;
  }
  // Asked for explicitly (sync --relabel): take the new provenance whenever the
  // amount is unchanged, in either direction. This is the escape hatch for a row
  // left estimated after the real rate became known — --reprice would fix the
  // label too, but only by restating what the turn cost at today's rates.
  if (process.env.AI_USAGE_RELABEL === "1" && sameAmount(previous.cost, next.cost)) {
    return next;
  }
  return { ...next, cost: previous.cost };
}

/**
 * Raised when the usage-file lock could not be taken. Callers must be able to
 * tell "the write never happened" from "nothing needed writing" — both used to
 * surface as 0, which let a failed write look like a completed one.
 */
export class LockTimeoutError extends Error {
  constructor(file) {
    super(`timed out waiting for lock on ${file}`);
    this.name = "LockTimeoutError";
    this.code = "ELOCKTIMEOUT";
  }
}

/**
 * Replace one session's records, filtering persistent tombstones. Returns how
 * many records were accepted; THROWS LockTimeoutError if the lock was never
 * acquired, so the caller can retry instead of recording a phantom success.
 */
export async function upsertSession(file, sessionId, records, { precondition = null } = {}) {
  // Which provider this batch replaces. Session ids are only unique within a
  // provider, so replacing on the id alone would let one provider delete
  // another's rows — the same composite identity tombstoneKey() uses.
  const provider = records.length ? (records[0].provider ? String(records[0].provider) : "claude") : null;
  // Rows an older version wrote with no session at all got the id
  // "undefined:<startTs>". The turn now arriving with that same timestamp IS that
  // row, so it may replace it — but only that one. Matching the prefix alone
  // would delete every unrelated orphan in the file on any write.
  const supersededOrphanIds = new Set(
    records.map((r) => (r && r.ts ? `undefined:${r.ts}` : null)).filter(Boolean),
  );
  const replaces = (r) => {
    if (provider === null) return false; // nothing to replace with
    const rp = r && r.provider ? String(r.provider) : "claude";
    if (rp !== provider) return false;
    if (r.sessionId === sessionId) return true;
    return r.sessionId == null && typeof r.id === "string" && supersededOrphanIds.has(r.id);
  };
  const result = await mutateNdjson(file, (existing) => {
    // Re-checked under the lock: whatever these records were parsed from may have
    // moved on while we queued for it.
    if (precondition && precondition() === false) return ABORT;
    // Read while holding usage lock. Viewer writes tombstone before waiting for
    // this lock, closing delete-vs-upsert resurrection races.
    const blocked = loadTombstoneKeys(tombstonePath(file));
    const priorByKey = new Map(existing.map((r) => [tombstoneKey(r), r]));
    // A batch can carry the same turn twice. Keep the LAST copy: a re-parse
    // appends the more complete version, so the later record wins.
    const byKey = new Map();
    for (const r of records) {
      if (blocked.has(tombstoneKey(r))) continue;
      byKey.set(tombstoneKey(r), r);
    }
    const accepted = [...byKey.values()].map((r) =>
      preserveComputedCost(r, priorByKey.get(tombstoneKey(r))));
    return {
      records: existing.filter((r) => !replaces(r)).concat(accepted),
      value: accepted.length,
    };
  });
  if (result === false) throw new LockTimeoutError(file);
  if (result.value === ABORT) return ABORT;
  return result.value;
}
