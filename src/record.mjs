#!/usr/bin/env node
// Claude Code `Stop` hook: after each response, re-derive this session's turns
// from the transcript and upsert them into the shared per-workspace ndjson.
//
// Robustness contract: never block Claude. Everything is wrapped in try/catch,
// nothing is written to stdout, and the process always exits 0.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTurns } from "./lib/transcript.mjs";
import { upsertSession } from "./lib/store.mjs";
import {
  workspaceFile,
  workspaceLabel,
  settingsCandidates,
  deriveTranscriptPath,
} from "./lib/paths.mjs";
import {
  loadConfig,
  mutateConfig,
  isTracked,
  effectiveFields,
  applyFieldSelection,
  encCwd,
} from "./lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bump when the bundled viewer changes so existing projects refresh their copy
// on the next prompt (after the user re-installs the app via npx). Keep in step
// with viewer changes.
const VIEWER_VERSION = "5";

// Make each project self-contained: copy the viewer + a default config into
// <project>/.claude-usage/ so it can be viewed in place. Skipped in aggregate
// mode (CLAUDE_USAGE_DIR). Idempotent and best-effort; re-copies when the
// bundled viewer is missing or out of date.
function ensureBundle(cwd) {
  if (process.env.CLAUDE_USAGE_DIR) return;
  try {
    const base = path.join(cwd, ".claude-usage");
    const viewerSrc = path.join(__dirname, "..", "viewer");
    const viewerDst = path.join(base, "viewer");
    const verFile = path.join(viewerDst, ".version");
    const have = fs.existsSync(verFile) ? fs.readFileSync(verFile, "utf8").trim() : null;
    const stale = !fs.existsSync(path.join(viewerDst, "server.mjs")) || have !== VIEWER_VERSION;
    if (fs.existsSync(viewerSrc) && stale) {
      fs.rmSync(viewerDst, { recursive: true, force: true });
      fs.cpSync(viewerSrc, viewerDst, { recursive: true });
      fs.writeFileSync(verFile, VIEWER_VERSION + "\n");
    }
    const cfg = path.join(base, "config.json");
    if (!fs.existsSync(cfg)) {
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(
        cfg,
        JSON.stringify({ title: path.basename(cwd), port: 4317, ui: {} }, null, 2) + "\n"
      );
    }
  } catch {}
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readEffort(cwd) {
  let effort = null;
  for (const f of settingsCandidates(cwd)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j && typeof j.effortLevel === "string") effort = j.effortLevel;
    } catch {}
  }
  return effort;
}

async function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw) || {};
  } catch {}

  const sessionId = payload.session_id || payload.sessionId;
  const cwd = payload.cwd || process.cwd();
  let transcript = payload.transcript_path || payload.transcriptPath;
  if (!transcript && sessionId) transcript = deriveTranscriptPath(cwd, sessionId);
  if (!transcript) return;

  // Opt-in gate: only record projects the user enabled. Projects that already
  // have recorded data are grandfathered in (lazily added on first sight) so an
  // upgrade never silently drops existing tracking.
  const cfg = loadConfig();
  const { tracked, grandfather } = isTracked(cfg, cwd, fs.existsSync(workspaceFile(cwd)));
  if (!tracked) return;
  if (grandfather) {
    try {
      await mutateConfig((c) => {
        const k = encCwd(cwd);
        if (!c.tracking.projects[k]) {
          c.tracking.projects[k] = { enabled: true, label: workspaceLabel(cwd), grandfathered: true };
        }
      });
    } catch {}
  }

  const effortLevel = readEffort(cwd);
  const turns = buildTurns(transcript, { effortLevel });
  if (!turns.length) return;

  // Tag every record with a human workspace label for the viewer.
  const label = workspaceLabel(cwd);
  for (const t of turns) t.workspace = label;

  const sid = sessionId || (turns[0] && turns[0].sessionId);
  if (!sid) return;

  // Strip field groups the user disabled (global default + per-project override).
  const fields = effectiveFields(cfg, cwd);
  const slim = turns.map((t) => applyFieldSelection(t, fields));
  await upsertSession(workspaceFile(cwd), sid, slim);
  ensureBundle(cwd);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
