#!/usr/bin/env node
// Backfill/sync: import existing session history from each AI tool's own
// storage into the per-project .ai-usage records. The hooks only record turns
// from install time forward — this scans what's already on disk:
//
//   node sync.mjs                      # all detected providers, full history
//   node sync.mjs --provider codex     # one provider
//   node sync.mjs --days 30            # only transcripts modified in the last N days
//   node sync.mjs --reprice            # recompute stored costs at today's rates
//
// Idempotent: records upsert per sessionId, so re-running never duplicates.
// Re-syncing also does NOT rewrite costs this tool computed for old turns —
// what a turn cost is a fact about when it ran — unless --reprice is passed.
// Per-project tracking config still gates every project (disabled = skipped),
// exactly like the hook path.
import { getProvider, detectInstalled } from "./providers/index.mjs";
import { ingestTranscript } from "./lib/ingest.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function help() {
  console.log(`
  AI Usage Inspector sync

  Usage
    node src/sync.mjs
    node src/sync.mjs --provider claude|codex|cursor|opencode|cline|roo|kilo
    node src/sync.mjs --days 30
    node src/sync.mjs --reprice

  Imports existing provider history into per-project .ai-usage records.

  Costs this tool computed for turns already recorded are kept as-is on a
  re-sync; pass --reprice to recompute them at today's rates.
`);
}

function validateArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h" || a === "--reprice") continue;
    if (a === "--provider" || a === "--days") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
        throw new Error(`${a} requires a value`);
      }
      i++;
      continue;
    }
    if (a.startsWith("--provider=") || a.startsWith("--days=")) continue;
    throw new Error(`unknown option: ${a}`);
  }

  const wanted = arg("--provider", null);
  if (wanted && !getProvider(wanted)) throw new Error(`unknown provider: ${wanted}`);

  const rawDays = arg("--days", null);
  if (rawDays != null) {
    const days = Number(rawDays);
    if (!Number.isFinite(days) || days < 0) throw new Error("--days must be a non-negative number");
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }

  validateArgs();

  const wanted = arg("--provider", null);
  const days = Number(arg("--days", 0)) || 0;
  const sinceMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  // Opt in to recomputing costs we already stored (see upsertSession).
  const reprice = process.argv.includes("--reprice");
  if (reprice) {
    process.env.AI_USAGE_REPRICE = "1";
    console.log("  repricing: stored costs will be recomputed at today's rates");
  }

  const providers = wanted
    ? [getProvider(wanted)].filter(Boolean)
    : detectInstalled().filter((p) => typeof p.discoverTranscripts === "function");
  if (!providers.length) {
    console.error(wanted ? `unknown provider: ${wanted}` : "no providers detected");
    process.exit(1);
  }

  for (const p of providers) {
    if (typeof p.discoverTranscripts !== "function") {
      console.log(`  ${p.id}: no sync support`);
      continue;
    }
    if (typeof p.nodeSupported === "function" && !p.nodeSupported()) {
      console.log(`  ${p.id}: needs Node >= 22.5 for node:sqlite (you have ${process.versions.node}) — skipped`);
      continue;
    }
    const found = await p.discoverTranscripts({ sinceMs });
    let files = 0;
    let turns = 0;
    for (const t of found) {
      try {
        const n = await ingestTranscript(p, t);
        if (n > 0) {
          files++;
          turns += n;
        }
      } catch {}
    }
    console.log(`  ${p.id}: ${found.length} transcript(s) scanned, ${turns} turn(s) from ${files} session(s) imported`);
  }
}

main().catch((e) => {
  console.error(e && e.message);
  process.exit(1);
});
