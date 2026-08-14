import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO, "install.mjs");

// Cursor and OpenCode refuse to register on Node < 22.5 (they read SQLite), so
// their assertions only hold where node:sqlite exists.
const [maj, min] = String(process.versions.node).split(".").map(Number);
const sqliteCapable = maj > 22 || (maj === 22 && min >= 5);
const needsSqlite = { skip: sqliteCapable ? false : "installer refuses Cursor/OpenCode below Node 22.5" };

/**
 * install.mjs resolves every target from os.homedir(), which paths.mjs captures
 * at import time — so this has to be a real child process with the home
 * redirected, never an in-process import. That also keeps copyApp() and the
 * global config inside the sandbox.
 */
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-install-"));
  const project = path.join(home, "project");
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (args, cwd = project) =>
    spawnSync(process.execPath, [INSTALLER, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
    });

  return {
    home,
    project,
    run,
    read: (rel) => {
      try {
        return fs.readFileSync(path.join(home, rel), "utf8");
      } catch {
        return null;
      }
    },
    readJson: (rel) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(home, rel), "utf8"));
      } catch {
        return null;
      }
    },
    write: (rel, body) => {
      const file = path.join(home, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    },
  };
}

const CLAUDE_SETTINGS = path.join(".claude", "settings.json");
const CURSOR_HOOKS = path.join(".cursor", "hooks.json");
const OPENCODE_PLUGIN = path.join(".config", "opencode", "plugins", "ai-usage-inspector.js");
const hookText = (value) => JSON.stringify(value);

test("--claude registers a Stop hook and copies the app into the sandbox", (t) => {
  const box = sandbox(t);
  const r = box.run(["--claude"]);
  assert.equal(r.status, 0, r.stderr);

  const settings = box.readJson(CLAUDE_SETTINGS);
  assert.ok(Array.isArray(settings.hooks.Stop), "Stop hook array created");
  assert.match(hookText(settings.hooks.Stop), /ai-usage-inspector/);
  assert.match(hookText(settings.hooks.Stop), /--provider claude/);
  assert.ok(fs.existsSync(path.join(box.home, ".ai-usage-inspector", "app", "src", "record.mjs")));
  assert.ok(fs.existsSync(path.join(box.home, ".ai-usage-inspector", "config.json")), "global defaults seeded");
});

test("installing twice does not duplicate the hook", (t) => {
  const box = sandbox(t);
  box.run(["--claude"]);
  const second = box.run(["--claude"]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already registered/);
  assert.equal(box.readJson(CLAUDE_SETTINGS).hooks.Stop.length, 1);
});

test("a user's own Claude settings and hooks survive install and uninstall", (t) => {
  const box = sandbox(t);
  box.write(CLAUDE_SETTINGS, {
    model: "opus",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
  });

  box.run(["--claude"]);
  let settings = box.readJson(CLAUDE_SETTINGS);
  assert.equal(settings.model, "opus", "unrelated settings untouched");
  assert.equal(settings.hooks.Stop.length, 2);

  box.run(["--uninstall", "--claude"]);
  settings = box.readJson(CLAUDE_SETTINGS);
  assert.equal(settings.model, "opus");
  assert.equal(hookText(settings.hooks.Stop).includes("ai-usage-inspector"), false, "ours removed");
  assert.match(hookText(settings.hooks.Stop), /echo mine/, "theirs kept");
});

test("--local writes the project's settings.local.json and leaves the global file alone", (t) => {
  const box = sandbox(t);
  const r = box.run(["--claude", "--local"]);
  assert.equal(r.status, 0, r.stderr);

  const local = JSON.parse(fs.readFileSync(path.join(box.project, ".claude", "settings.local.json"), "utf8"));
  assert.match(hookText(local.hooks.Stop), /--provider claude/);
  assert.equal(box.readJson(CLAUDE_SETTINGS), null, "global settings not created");
  assert.ok(fs.existsSync(path.join(box.project, ".ai-usage", "config.json")), "project config seeded");
});

test("--cursor registers its stop hook and preserves other entries", needsSqlite, (t) => {
  const box = sandbox(t);
  box.write(CURSOR_HOOKS, { version: 1, hooks: { stop: [{ command: "echo mine" }] } });

  assert.equal(box.run(["--cursor"]).status, 0);
  let hooks = box.readJson(CURSOR_HOOKS);
  assert.equal(hooks.hooks.stop.length, 2);
  assert.match(hookText(hooks.hooks.stop), /--provider cursor/);

  box.run(["--uninstall", "--cursor"]);
  hooks = box.readJson(CURSOR_HOOKS);
  assert.deepEqual(hooks.hooks.stop, [{ command: "echo mine" }], "only ours removed");
});

test("--opencode writes a session.idle plugin and uninstall deletes it", needsSqlite, (t) => {
  const box = sandbox(t);
  assert.equal(box.run(["--opencode"]).status, 0);

  const plugin = box.read(OPENCODE_PLUGIN);
  assert.match(plugin, /session\.idle/);
  assert.match(plugin, /--provider/);
  assert.match(plugin, /ai-usage-inspector/);
  assert.match(plugin, /detached: true/, "must outlive a one-shot `opencode run`");

  box.run(["--uninstall", "--opencode"]);
  assert.equal(box.read(OPENCODE_PLUGIN), null);
});

test("scan-only providers report themselves without registering a hook", (t) => {
  const box = sandbox(t);
  const r = box.run(["--kilo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /captured on sync/);
  assert.equal(box.readJson(CLAUDE_SETTINGS), null, "no hook file invented for a scan-only provider");
});

test("an unknown flag fails before anything is written", (t) => {
  const box = sandbox(t);
  const r = box.run(["--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /unknown option/);
  assert.equal(fs.existsSync(path.join(box.home, ".ai-usage-inspector")), false, "nothing copied");
});

test("--uninstall with no provider flag clears every tool's hook", needsSqlite, (t) => {
  const box = sandbox(t);
  box.run(["--claude"]);
  box.run(["--cursor"]);
  box.run(["--opencode"]);

  assert.equal(box.run(["--uninstall"]).status, 0);
  assert.equal(hookText(box.readJson(CLAUDE_SETTINGS)).includes("ai-usage-inspector"), false);
  assert.equal(hookText(box.readJson(CURSOR_HOOKS)).includes("ai-usage-inspector"), false);
  assert.equal(box.read(OPENCODE_PLUGIN), null);
});
