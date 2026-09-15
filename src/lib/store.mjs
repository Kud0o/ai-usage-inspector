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

/** Do two usage objects count the same tokens? A field one of them lacks counts as zero. */
function sameTokens(a, b) {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of fields) if ((Number(a[k]) || 0) !== (Number(b[k]) || 0)) return false;
  return true;
}

/** Every token a record accounts for, of whatever kind. */
function tokenCount(r) {
  const u = r && r.usage;
  if (!u || typeof u !== "object") return 0;
  let n = 0;
  for (const v of Object.values(u)) n += Number(v) || 0;
  return n;
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
  // It never takes a new amount, not even for tokens that changed: that is what a
  // plain re-sync does.
  if (process.env.AI_USAGE_RELABEL === "1") {
    return sameAmount(previous.cost, next.cost) ? next : { ...next, cost: previous.cost };
  }
  // The promise is about rates, not tokens. When a re-read counts different
  // tokens for the turn, the stored figure was worked out for something that is
  // not this turn — a capture taken before it finished, a replay holding none of
  // its work, or a position an older parser gave to a different turn — so it is
  // worked out again instead of being carried forward.
  if (previous.usage && next.usage && !sameTokens(previous.usage, next.usage)) return next;
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
 * Replace what one transcript wrote for one session, filtering persistent
 * tombstones. Returns how many records were accepted; THROWS LockTimeoutError if
 * the lock was never acquired, so the caller can retry instead of recording a
 * phantom success.
 *
 * Without `transcriptId` the batch is taken to be the whole session, which holds
 * for every provider that keeps one source per session. With it, the batch
 * replaces only what that transcript wrote: Codex continues a reverted thread in
 * a new rollout under the same thread id, and reading one file must not delete
 * the other's turns.
 */
export async function upsertSession(file, sessionId, records, {
  precondition = null,
  preserveFields = (r) => r,
  transcriptId = null,
} = {}) {
  // Which provider this batch replaces. Session ids are only unique within a
  // provider, so replacing on the id alone would let one provider delete
  // another's rows — the same composite identity tombstoneKey() uses.
  const provider = records.length ? (records[0].provider ? String(records[0].provider) : "claude") : null;
  const transcript = transcriptId == null ? null : String(transcriptId);
  // Rows an older version wrote with no session at all got the id
  // "undefined:<startTs>". The turn now arriving with that same timestamp IS that
  // row, so it may replace it — but only that one. Matching the prefix alone
  // would delete every unrelated orphan in the file on any write.
  // The parser knows exactly which legacy id a turn used to carry; inferring it
  // from ts guessed wrong whenever the old id was built from a promptId.
  const supersededOrphanIds = new Set(
    records.map((r) => (r && r.legacyId ? String(r.legacyId) : null)).filter(Boolean),
  );
  const providerOf = (r) => (r && r.provider ? String(r.provider) : "claude");

  const result = await mutateNdjson(file, (existing) => {
    // Re-checked under the lock: whatever these records were parsed from may have
    // moved on while we queued for it.
    if (precondition && precondition() === false) return ABORT;
    // Read while holding usage lock. Viewer writes tombstone before waiting for
    // this lock, closing delete-vs-upsert resurrection races.
    const blocked = loadTombstoneKeys(tombstonePath(file));
    // Only a turn's own key blocks it. An old, position-based name is ambiguous —
    // it may be another transcript's turn — and honouring it hid every later
    // revert's turn at a position the user had once deleted. A continuation turn
    // deleted under its old name can reappear once; deleting it again sticks.
    const deleted = (r) => blocked.has(tombstoneKey(r));

    // A batch can carry the same turn twice. A re-parse appends the more complete
    // version, so the later copy wins — unless it carries fewer tokens: after
    // /compact, Claude Code writes earlier prompts again, and a replay holds none
    // of the turn's work.
    const incoming = new Map();
    for (const r of records) {
      if (deleted(r)) continue;
      const key = tombstoneKey(r);
      const held = incoming.get(key);
      if (held && tokenCount(held) > tokenCount(r)) continue;
      incoming.set(key, r);
    }
    const renamed = new Set();
    for (const r of incoming.values()) if (r.legacyId != null) renamed.add(String(r.legacyId));

    const replaced = [];
    const kept = [];
    // Turns another transcript already holds with at least as much work.
    const outranked = new Set();
    for (const row of existing) {
      if (provider === null || providerOf(row) !== provider) {
        kept.push(row);
      } else if (row.sessionId !== sessionId) {
        const orphan = row.sessionId == null && typeof row.id === "string" && supersededOrphanIds.has(row.id);
        (orphan ? replaced : kept).push(row);
      } else if (transcript === null) {
        replaced.push(row);
      } else if (row.transcriptId != null) {
        const key = tombstoneKey(row);
        const mine = incoming.get(key);
        if (String(row.transcriptId) === transcript) {
          // This transcript read again: a turn that has left it goes too.
          replaced.push(row);
        } else if (mine && tokenCount(mine) > tokenCount(row)) {
          replaced.push(row);
        } else {
          // Another transcript's turn. When both carry it, keep the copy with the
          // work; on a tie the stored one stays, so two files never trade it back
          // and forth.
          if (mine) outranked.add(key);
          kept.push(row);
        }
      } else if (transcript === String(sessionId)
          || incoming.has(tombstoneKey(row))
          || (typeof row.id === "string" && renamed.has(row.id))) {
        // Stored before rows named their transcript. The session's own transcript
        // takes all of them, as every write used to: such rows can carry ids and
        // timestamps today's parser no longer produces, and only wholesale
        // replacement clears those. Any other transcript takes only the turns it
        // can name.
        replaced.push(row);
      } else {
        kept.push(row);
      }
    }

    // A turn inherits preserved fields and its cost only from a replaced row with
    // its own key. A row claimed through an old name is removed but passes on
    // nothing: that name may have belonged to a different turn.
    const priorByKey = new Map(replaced.map((row) => [tombstoneKey(row), row]));
    const accepted = [];
    for (const [key, r] of incoming) {
      if (outranked.has(key)) continue;
      const prior = priorByKey.get(key);
      const named = transcript === null ? r : { ...r, transcriptId: transcript };
      accepted.push(preserveComputedCost(preserveFields(named, prior), prior));
    }
    return {
      records: kept.concat(accepted),
      value: accepted.length,
    };
  });
  if (result === false) throw new LockTimeoutError(file);
  if (result.value === ABORT) return ABORT;
  return result.value;
}
