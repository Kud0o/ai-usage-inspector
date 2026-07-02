#!/usr/bin/env node
// Hook entrypoint for AI Usage Inspector. Invoked by an AI tool's "stop" hook
// after each response, with the hook's JSON payload on stdin and the provider
// named via --provider:
//
//   node record.mjs --provider claude   (Claude Code Stop hook)
//   node record.mjs --provider codex     (OpenAI Codex Stop hook)
//
// Robustness contract: never block the agent. Everything is wrapped in
// try/catch, nothing is written to stdout, and the process always exits 0.
import fs from "node:fs";
import { getProvider } from "./providers/index.mjs";
import { ingest } from "./lib/ingest.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const provider = getProvider(arg("--provider", "claude"));
  if (!provider) return;
  await ingest(provider, readStdin());
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
