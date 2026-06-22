#!/usr/bin/env node
// Installer for the Claude Code usage tracker.
//
//   node install.mjs --global     register the Stop hook for ALL workspaces (~/.claude/settings.json)
//   node install.mjs --local      register only for this project (./.claude/settings.local.json)
//   node install.mjs --uninstall  remove the hook (add --global/--local to pick which file)
//
// Copies the app into ~/.claude/usage-tracker/app and points the hook there,
// so the tracker keeps working even if this repo moves. Existing settings keys
// are preserved.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const APP = path.join(HOME, ".claude", "usage-tracker", "app");
const HOOK_CMD = `node "${path.join(APP, "src", "record.mjs")}"`;
const MARKER = "usage-tracker"; // identifies our hook for idempotency / uninstall

const args = new Set(process.argv.slice(2));
const scope = args.has("--global") ? "global" : args.has("--local") ? "local" : null;
const uninstall = args.has("--uninstall");

function settingsPath(scope) {
  return scope === "local"
    ? path.join(process.cwd(), ".claude", "settings.local.json")
    : path.join(HOME, ".claude", "settings.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function copyApp() {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  fs.cpSync(path.join(REPO, "src"), path.join(APP, "src"), { recursive: true });
  fs.cpSync(path.join(REPO, "viewer"), path.join(APP, "viewer"), { recursive: true });
}

function addHook(file) {
  const s = readJson(file);
  s.hooks = s.hooks || {};
  s.hooks.Stop = s.hooks.Stop || [];
  const exists = JSON.stringify(s.hooks.Stop).includes(MARKER);
  if (exists) {
    console.log(`  • hook already present in ${file}`);
  } else {
    s.hooks.Stop.push({ hooks: [{ type: "command", command: HOOK_CMD }] });
    writeJson(file, s);
    console.log(`  • registered Stop hook in ${file}`);
  }
}

function removeHook(file) {
  const s = readJson(file);
  if (!s.hooks || !Array.isArray(s.hooks.Stop)) {
    console.log(`  • no Stop hooks in ${file}`);
    return;
  }
  const before = s.hooks.Stop.length;
  s.hooks.Stop = s.hooks.Stop.filter((g) => !JSON.stringify(g).includes(MARKER));
  if (s.hooks.Stop.length === 0) delete s.hooks.Stop;
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeJson(file, s);
  console.log(`  • removed ${before - (s.hooks?.Stop?.length || 0)} hook(s) from ${file}`);
}

function help() {
  console.log(`Claude Code Usage Tracker — installer

  node install.mjs --global      track every workspace   (~/.claude/settings.json)
  node install.mjs --local       track this project only (./.claude/settings.local.json)
  node install.mjs --uninstall [--global|--local]

After installing, start (or continue) any Claude Code session — each prompt is
recorded into that project at  <project>/.claude-usage/usage.ndjson.

View the dashboard for a project (reads the folder you launch it from, or a
path you pass):

  cd <your project> && node "${path.join(APP, "viewer", "server.mjs")}"
  node "${path.join(APP, "viewer", "server.mjs")}" <path-to-project>
                                                   →  http://localhost:4317

Tip: add  .claude-usage/  to the project's .gitignore. To pool every project
into one dashboard, set CLAUDE_USAGE_DIR to a shared folder (hook + viewer).
`);
}

if (uninstall) {
  console.log("Uninstalling usage tracker hook…");
  removeHook(settingsPath(scope || "global"));
  if (!scope) removeHook(settingsPath("local"));
  console.log("Done. (app + data left in ~/.claude/usage-tracker — delete manually if desired.)");
} else if (!scope) {
  help();
} else {
  console.log(`Installing usage tracker (${scope})…`);
  copyApp();
  console.log(`  • copied app to ${APP}`);
  addHook(settingsPath(scope));
  console.log(`\nDone. Prompts are recorded into each project at  <project>/.claude-usage/usage.ndjson`);
  console.log(`Launch the dashboard from inside a project:\n`);
  console.log(`  node "${path.join(APP, "viewer", "server.mjs")}"   →  http://localhost:4317`);
  console.log(`  (tip: add  .claude-usage/  to that project's .gitignore)\n`);
}
