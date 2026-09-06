import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import { ensureProjectConfig, isEnabled } from "../src/lib/config.mjs";
import {
  PROJECT_DIRNAME,
  encCwd,
  subagentsDir,
  workspaceFile,
  workspaceLabel,
} from "../src/lib/paths.mjs";

function withAggregateDir(t, value) {
  const saved = process.env.AI_USAGE_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_DIR;
    else process.env.AI_USAGE_DIR = saved;
  });
  if (value === null) delete process.env.AI_USAGE_DIR;
  else process.env.AI_USAGE_DIR = value;
}

test("encCwd flattens drives and separators, trimming the edges", () => {
  assert.equal(encCwd("C:\\Work\\MyApp"), "C--Work-MyApp");
  assert.equal(encCwd("/home/me/proj"), "home-me-proj", "leading separator trimmed");
  assert.equal(encCwd("/trailing/"), "trailing");
  assert.equal(encCwd(""), "");
  assert.equal(encCwd(null), "");
});

// Claude Code uses this same encoding for its own project folders, which is why
// the Claude provider can locate transcripts by it — so it cannot be changed
// unilaterally.
test("encCwd matches the layout Claude Code itself uses", () => {
  assert.equal(encCwd("C:\\Work\\MyApp"), "C--Work-MyApp");
});

// KNOWN LIMITATION, pinned deliberately: separators and dashes both collapse to
// "-", so two distinct projects can share one aggregate filename. Odds are tiny;
// fixing it means hashing the path and migrating existing files. If that fix
// lands, this test SHOULD fail and be rewritten.
test("encCwd currently collides across dash/separator boundaries", () => {
  assert.equal(encCwd("/a-b/c"), encCwd("/a/b-c"));
  assert.equal(encCwd("/a-b/c"), "a-b-c");
});

test("workspaceFile writes inside the project by default", (t) => {
  withAggregateDir(t, null);
  assert.equal(
    workspaceFile("K:\\repo"),
    path.join("K:\\repo", PROJECT_DIRNAME, "usage.ndjson"),
  );
});

test("AI_USAGE_DIR switches to one flat file per project", (t) => {
  withAggregateDir(t, "/agg");
  assert.equal(workspaceFile("C:\\Work\\MyApp"), path.join("/agg", "C--Work-MyApp.ndjson"));
  assert.equal(workspaceFile(""), path.join("/agg", "unknown.ndjson"), "unnameable cwd still lands somewhere");
});

test("workspaceLabel is the last path segment", () => {
  assert.equal(workspaceLabel("C:\\Work\\MyApp"), "MyApp");
  assert.equal(workspaceLabel("/home/me/proj"), "proj");
  assert.equal(workspaceLabel("/home/me/proj/"), "proj", "trailing separator ignored");
  assert.equal(workspaceLabel(""), "unknown");
  assert.equal(workspaceLabel(null), "unknown");
});

test("subagentsDir derives the sidechain folder from a transcript path", () => {
  assert.equal(
    subagentsDir(path.join("/root", "sess-1.jsonl")),
    path.join("/root", "sess-1", "subagents"),
  );
  assert.equal(subagentsDir(null), null);
  assert.equal(subagentsDir(""), null);
});

// Aggregate mode pools every project into one directory, so there is no
// per-project folder to hold settings — the dashboard writes one config there.
// Capture has to read it, or its switches are decoration.
test("aggregate mode reads the dashboard's own config", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-aggcfg-"));
  const saved = process.env.AI_USAGE_DIR;
  process.env.AI_USAGE_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_DIR;
    else process.env.AI_USAGE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    tracking: { enabled: false },
    fields: { text: false },
  }));

  const cfg = await ensureProjectConfig("/any/project");
  assert.equal(isEnabled(cfg), false, "tracking off in the aggregate config is honoured");
  assert.equal(cfg.fields.text, false, "and so are its field toggles");
  assert.equal(cfg.fields.tokens, true, "anything it does not set falls back to the global default");
});
