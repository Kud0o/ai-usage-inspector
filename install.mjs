#!/usr/bin/env node
// Installer for AI Usage Inspector — records every AI coding-agent prompt
// (tokens, model, cost, context %) and shows it in a local dashboard.
//
//   node install.mjs                register hooks for every detected agent
//   node install.mjs --claude       Claude Code only
//   node install.mjs --codex        OpenAI Codex only
//   node install.mjs --all          both, whether detected or not
//   node install.mjs --local        Claude Code: this project only (settings.local.json)
//   node install.mjs --update        refresh the app to the latest version
//   node install.mjs --uninstall     remove the hooks (add a provider flag to pick)
//
// Copies the app into ~/.ai-usage-inspector/app and points each agent's hook
// there, so tracking keeps working even if this repo moves. Existing settings
// are preserved.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProvider, listProviders, detectInstalled } from "./src/providers/index.mjs";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const APP = path.join(HOME, ".ai-usage-inspector", "app");
const GLOBAL_CFG = path.join(HOME, ".ai-usage-inspector", "config.json");

// ---- console styling (zero-dep ANSI; auto-off when not a TTY or NO_COLOR) ----
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const bold = sgr(1), dim = sgr(2), green = sgr("32;1"), red = sgr("31;1"), cyan = sgr(36), gray = sgr(90);
const ok = (msg) => console.log(`  ${green("✓")} ${msg}`);
const skip = (msg) => console.log(`  ${gray("•")} ${dim(msg)}`);
const cmd = (s) => cyan(s);
const rule = () => console.log(gray("  ────────────────────────────────────────────"));
function banner(subtitle) {
  console.log();
  console.log(`  ${bold(cyan("AI Usage Inspector"))}  ${dim("·")}  ${dim(subtitle)}`);
  rule();
}

const args = new Set(process.argv.slice(2));
const explicitScope = args.has("--local") ? "local" : args.has("--global") ? "global" : null;
const uninstall = args.has("--uninstall");
const update = args.has("--update");
const scope = explicitScope || "global"; // bare invocation installs globally
const VERSION = readJson(path.join(REPO, "package.json")).version || "0";

// Which providers to act on: explicit flags > --all > auto-detect. For
// uninstall, default to every provider so nothing is stranded.
function selectedProviders(defaultAll) {
  const picked = [];
  if (args.has("--claude")) picked.push(getProvider("claude"));
  if (args.has("--codex")) picked.push(getProvider("codex"));
  if (picked.length) return picked;
  if (args.has("--all") || defaultAll) return listProviders();
  const detected = detectInstalled();
  return detected.length ? detected : [getProvider("claude")];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function copyApp() {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  fs.cpSync(path.join(REPO, "src"), path.join(APP, "src"), { recursive: true });
  fs.cpSync(path.join(REPO, "viewer"), path.join(APP, "viewer"), { recursive: true });
  // The per-project bundle ships viewer/ only (no src/). Copy the self-contained
  // modules the bundled server imports next to the viewer (config + the Claude
  // pricing refresher). ensureBundle copies the whole viewer/ dir into each
  // project, so these ride along automatically.
  fs.cpSync(path.join(REPO, "src", "lib", "config.mjs"), path.join(APP, "viewer", "config.mjs"));
  fs.cpSync(
    path.join(REPO, "src", "providers", "claude", "remote-pricing.mjs"),
    path.join(APP, "viewer", "remote-pricing.mjs"),
  );
  fs.cpSync(
    path.join(REPO, "src", "providers", "codex", "remote-pricing.mjs"),
    path.join(APP, "viewer", "remote-pricing-codex.mjs"),
  );
}

const FIELD_GROUPS = ["text", "tokens", "cost", "context", "timing", "skills", "counts", "meta"];
function allFields() {
  const f = {};
  for (const g of FIELD_GROUPS) f[g] = true;
  return f;
}
function globalDefaults() {
  const c = readJson(GLOBAL_CFG);
  const fields = allFields();
  if (c.fields && typeof c.fields === "object") for (const g of FIELD_GROUPS) if (typeof c.fields[g] === "boolean") fields[g] = c.fields[g];
  return { enabledDefault: typeof c.enabledDefault === "boolean" ? c.enabledDefault : true, fields };
}

// Create the global defaults TEMPLATE the first time only — projects inherit a
// copy of it. Never overwrite user edits.
function seedGlobalConfig() {
  if (fs.existsSync(GLOBAL_CFG)) return GLOBAL_CFG;
  const cfg = { schema: 2, enabledDefault: true, fields: allFields() };
  fs.mkdirSync(path.dirname(GLOBAL_CFG), { recursive: true });
  fs.writeFileSync(GLOBAL_CFG, JSON.stringify(cfg, null, 2) + "\n");
  return GLOBAL_CFG;
}

// A --local install makes the project self-contained: write its tracking + field
// config into <cwd>/.ai-usage/config.json (enabled, seeded from global).
function seedProjectConfig(cwd) {
  const base = path.join(cwd, ".ai-usage");
  const file = path.join(base, "config.json");
  const def = globalDefaults();
  const c = readJson(file);
  if (!c.title) c.title = path.basename(cwd);
  if (!c.ui || typeof c.ui !== "object") c.ui = {};
  c.tracking = { enabled: true, ...(c.tracking || {}) };
  c.fields = { ...def.fields, ...(c.fields || {}) };
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
  return file;
}

function installProvider(p) {
  try {
    const r = p.install({ appPath: APP, scope, cwd: process.cwd() });
    if (r.action === "exists") skip(`${p.displayName}: hook already registered  ${gray(r.file)}`);
    else ok(`${p.displayName}: registered hook  ${gray(r.file)}`);
  } catch (e) {
    skip(`${p.displayName}: could not register hook (${e.message})`);
  }
}

function uninstallProvider(p) {
  try {
    const r = p.uninstall({ scope, cwd: process.cwd() });
    if (r.removed) ok(`${p.displayName}: removed hook  ${gray(r.file)}`);
    else skip(`${p.displayName}: no matching hook  ${gray(r.file)}`);
  } catch (e) {
    skip(`${p.displayName}: uninstall skipped (${e.message})`);
  }
}

function help() {
  banner("installer");
  console.log();
  console.log(`  ${bold("Usage")}`);
  console.log(`    ${cmd("npx -y github:Kud0o/ai-usage-inspector")}   ${dim("one-line install (auto-detects agents)")}`);
  console.log(`    ${cmd("node install.mjs")}              ${dim("install for every detected agent")}`);
  console.log(`    ${cmd("node install.mjs --claude")}     ${dim("Claude Code only")}`);
  console.log(`    ${cmd("node install.mjs --codex")}      ${dim("OpenAI Codex only")}`);
  console.log(`    ${cmd("node install.mjs --local")}      ${dim("Claude Code: this project only")}`);
  console.log(`    ${cmd("node install.mjs --update")}     ${dim("refresh app to the latest version")}`);
  console.log(`    ${cmd("node install.mjs --uninstall")}  ${dim("remove the hooks")}`);
  console.log(`    ${cmd("node install.mjs --sync")}       ${dim("also import existing session history")}`);
  console.log();
  console.log(`  ${bold("Backfill history")}  ${dim("(hooks only record from install time forward)")}`);
  console.log(`    ${cmd(`node "${path.join("~", ".ai-usage-inspector", "app", "src", "sync.mjs")}"`)}   ${dim("[--provider claude|codex] [--days N]")}`);
  console.log();
  console.log(`  ${bold("View a project")}  ${dim("(after its first prompt)")}`);
  console.log(`    ${cmd("node .ai-usage/viewer/server.mjs")}   ${dim("→ http://localhost:4317 (first free port; --port to pin)")}`);
  console.log();
  console.log(dim(`  Each project records into its own  .ai-usage/  folder (data + a`));
  console.log(dim(`  bundled viewer + saved settings). Add it to the project's .gitignore.`));
  console.log(dim(`  Set AI_USAGE_DIR to pool every project into one shared dashboard.`));
  console.log();
}

if (args.has("--help") || args.has("-h")) {
  help();
} else if (update) {
  banner("update");
  console.log();
  copyApp();
  ok(`updated app to v${VERSION}  ${gray(APP)}`);
  for (const p of selectedProviders(false)) installProvider(p); // ensure hooks exist
  const gc = seedGlobalConfig();
  skip(`config  ${gray(gc)}`);
  console.log();
  console.log(`  ${green("✓")} ${bold("Up to date.")} ${dim("Open projects refresh their viewer on the next prompt.")}`);
  console.log();
} else if (uninstall) {
  banner("uninstall");
  console.log();
  for (const p of selectedProviders(true)) uninstallProvider(p);
  console.log();
  console.log(`  ${bold("Done.")}`);
  console.log(dim(`  App + recorded data left in  ~/.ai-usage-inspector  — delete manually if desired.`));
  console.log();
} else {
  const providers = selectedProviders(false);
  banner(`install · ${scope} · ${providers.map((p) => p.id).join("+")}`);
  console.log();
  copyApp();
  ok(`copied app v${VERSION}  ${gray(APP)}`);
  for (const p of providers) installProvider(p);
  const gc = seedGlobalConfig();
  ok(`global defaults  ${gray(gc)}`);
  if (args.has("--sync")) {
    console.log();
    console.log(`  ${bold("Importing existing history")}${dim(" …")}`);
    for (const p of providers) {
      const r = spawnSync(process.execPath, [path.join(APP, "src", "sync.mjs"), "--provider", p.id], {
        encoding: "utf8",
      });
      process.stdout.write(r.stdout || "");
      if (r.status !== 0) skip(`${p.displayName}: sync failed`);
    }
  }
  if (scope === "local") {
    const pc = seedProjectConfig(process.cwd());
    ok(`project config  ${gray(pc)}`);
    console.log();
    console.log(`  ${green("✓")} ${bold("This project is tracked.")} ${dim("Its config lives in the folder; tune it in ⚙ settings.")}`);
  } else {
    console.log();
    console.log(`  ${green("✓")} ${bold("Tracking on by default.")} ${dim("Each project inherits an editable copy of the global defaults.")}`);
    console.log(dim(`  Disable or tune a project from its dashboard ⚙ settings (writes that project's config).`));
  }
  console.log();
  console.log(`  ${bold("View a project")}  ${dim("(after its first prompt)")}`);
  console.log(`    ${cmd("cd <your project>")}`);
  console.log(`    ${cmd("node .ai-usage/viewer/server.mjs")}   ${dim("→ http://localhost:4317 (first free port; --port to pin)")}`);
  console.log();
  console.log(dim(`  Tip: add  .ai-usage/  to that project's .gitignore.`));
  console.log();
}
