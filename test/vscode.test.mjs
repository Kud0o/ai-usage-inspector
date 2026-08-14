import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listExtensionTasks, readJsonFile, vscodeUserDirs } from "../src/lib/vscode.mjs";

const ENV_KEYS = ["APPDATA", "HOME", "USERPROFILE"];
const EXT = "kilocode.kilo-code";

// The lib resolves its base from APPDATA (Windows) or the home dir (macOS/Linux),
// so redirect all three and build the tree the platform actually looks in.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-vscode-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = root;
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base =
    process.platform === "win32"
      ? root
      : process.platform === "darwin"
        ? path.join(root, "Library", "Application Support")
        : path.join(root, ".config");

  return {
    root,
    productDir: (product) => path.join(base, product, "User"),
    /** Create <product>/User/globalStorage/<ext>/tasks/<id>/ui_messages.json */
    addTask(product, taskId, { body = "[]", mtimeMs } = {}) {
      const dir = path.join(base, product, "User", "globalStorage", EXT, "tasks", taskId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "ui_messages.json");
      fs.writeFileSync(file, body);
      if (mtimeMs) {
        const when = new Date(mtimeMs);
        fs.utimesSync(file, when, when);
      }
      return dir;
    },
    addProduct(product) {
      fs.mkdirSync(path.join(base, product, "User"), { recursive: true });
    },
  };
}

test("vscodeUserDirs lists only the product variants that exist", (t) => {
  const box = sandbox(t);
  assert.deepEqual(vscodeUserDirs(), [], "nothing installed, nothing reported");

  box.addProduct("Code");
  box.addProduct("Cursor");
  const dirs = vscodeUserDirs();
  assert.equal(dirs.length, 2);
  assert.ok(dirs.includes(box.productDir("Code")));
  assert.ok(dirs.includes(box.productDir("Cursor")), "forks host the same extensions");
  assert.equal(dirs.includes(box.productDir("Windsurf")), false);
});

test("listExtensionTasks finds tasks across every variant", (t) => {
  const box = sandbox(t);
  box.addTask("Code", "task-a");
  box.addTask("Cursor", "task-b");
  box.addTask("VSCodium", "task-c");

  const tasks = listExtensionTasks(EXT);
  assert.deepEqual(tasks.map((x) => x.taskId).sort(), ["task-a", "task-b", "task-c"]);
  for (const task of tasks) {
    assert.ok(fs.existsSync(path.join(task.dir, "ui_messages.json")));
    assert.ok(task.mtimeMs > 0);
  }
});

test("listExtensionTasks reports nothing for an extension that is not installed", (t) => {
  const box = sandbox(t);
  box.addTask("Code", "task-a");
  assert.deepEqual(listExtensionTasks("saoudrizwan.claude-dev"), []);
});

test("sinceMs filters on the task's ui_messages.json mtime", (t) => {
  const box = sandbox(t);
  const old = Date.parse("2026-01-01T00:00:00Z");
  const fresh = Date.parse("2026-08-01T00:00:00Z");
  box.addTask("Code", "stale", { mtimeMs: old });
  box.addTask("Code", "recent", { mtimeMs: fresh });

  assert.equal(listExtensionTasks(EXT, { sinceMs: 0 }).length, 2);
  assert.deepEqual(
    listExtensionTasks(EXT, { sinceMs: Date.parse("2026-06-01T00:00:00Z") }).map((x) => x.taskId),
    ["recent"],
  );
  assert.deepEqual(listExtensionTasks(EXT, { sinceMs: fresh }).map((x) => x.taskId), ["recent"], "boundary is inclusive");
});

test("stray files in the tasks dir are ignored", (t) => {
  const box = sandbox(t);
  const dir = box.addTask("Code", "task-a");
  fs.writeFileSync(path.join(path.dirname(dir), "notes.txt"), "x");

  const tasks = listExtensionTasks(EXT);
  assert.deepEqual(tasks.map((x) => x.taskId), ["task-a"], "only directories are tasks");
});

test("a task dir without ui_messages.json still reports, using the dir mtime", (t) => {
  const box = sandbox(t);
  box.addTask("Code", "task-a");
  fs.rmSync(path.join(listExtensionTasks(EXT)[0].dir, "ui_messages.json"));

  const tasks = listExtensionTasks(EXT);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].mtimeMs > 0, "falls back to the directory's own mtime");
});

test("readJsonFile parses valid JSON and swallows everything else", (t) => {
  const box = sandbox(t);
  const dir = box.addTask("Code", "task-a", { body: '{"ok":true}' });
  assert.deepEqual(readJsonFile(path.join(dir, "ui_messages.json")), { ok: true });

  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  assert.equal(readJsonFile(path.join(dir, "bad.json")), null);
  assert.equal(readJsonFile(path.join(dir, "missing.json")), null);
});
