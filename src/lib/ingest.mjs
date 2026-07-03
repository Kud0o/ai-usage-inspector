// Provider-neutral ingestion: turn a hook payload into stored turn records.
// Shared by every provider; the provider supplies payload normalization, the
// transcript parser, and (at install time) its own hook wiring.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertSession } from "./store.mjs";
import { workspaceFile, workspaceLabel } from "./paths.mjs";
import { ensureProjectConfig, isEnabled, applyFieldSelection } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bump when the bundled viewer changes so existing projects refresh their copy
// on the next prompt (after the user re-installs the app via npx).
export const VIEWER_VERSION = "9";

// Make each project self-contained: copy the viewer + a default config into
// <project>/.ai-usage/ so it can be viewed in place. Skipped in aggregate mode
// (AI_USAGE_DIR). Idempotent and best-effort.
function ensureBundle(cwd) {
  if (process.env.AI_USAGE_DIR) return;
  try {
    const base = path.join(cwd, ".ai-usage");
    const viewerSrc = path.join(__dirname, "..", "..", "viewer");
    const viewerDst = path.join(base, "viewer");
    const verFile = path.join(viewerDst, ".version");
    const have = fs.existsSync(verFile) ? fs.readFileSync(verFile, "utf8").trim() : null;
    const stale = !fs.existsSync(path.join(viewerDst, "server.mjs")) || have !== VIEWER_VERSION;
    if (fs.existsSync(viewerSrc) && stale) {
      fs.rmSync(viewerDst, { recursive: true, force: true });
      fs.cpSync(viewerSrc, viewerDst, { recursive: true });
      fs.writeFileSync(verFile, VIEWER_VERSION + "\n");
    }
    const cfgFile = path.join(base, "config.json");
    fs.mkdirSync(base, { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) || {}; } catch {}
    let changed = false;
    if (!cfg.title) { cfg.title = path.basename(cwd); changed = true; }
    if (!cfg.ui || typeof cfg.ui !== "object") { cfg.ui = {}; changed = true; }
    if (changed) fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  } catch {}
}

// Shared tail: tag, field-select, upsert, bundle. Returns turns written.
async function storeTurns(turns, cwd, cfg, sessionId) {
  const label = workspaceLabel(cwd);
  for (const t of turns) t.workspace = label;

  const sid = sessionId || (turns[0] && turns[0].sessionId);
  if (!sid) return 0;

  const slim = turns.map((t) => applyFieldSelection(t, cfg.fields));
  await upsertSession(workspaceFile(cwd), sid, slim);
  ensureBundle(cwd);
  return turns.length;
}

/**
 * Ingest one provider's hook event (raw stdin string). Best-effort: never
 * throws to the caller. Returns the number of turns written.
 */
export async function ingest(provider, raw) {
  const { sessionId, cwd, transcriptPath, opts } = provider.normalizePayload(raw);
  if (!transcriptPath || !cwd) return 0;

  // Hook path: cwd is known up front, so gate on config before parsing.
  const cfg = await ensureProjectConfig(cwd);
  if (!isEnabled(cfg)) return 0;

  const turns = provider.buildTurns(transcriptPath, opts || {});
  if (!turns.length) return 0;
  return storeTurns(turns, cwd, cfg, sessionId);
}

/**
 * Ingest one transcript directly (backfill/sync path — no hook payload).
 * cwd may be unknown up front; it's recovered from the parsed turns. The same
 * per-project tracking config gates ingestion, so disabled projects are
 * skipped exactly like on the hook path. Returns the number of turns written.
 */
export async function ingestTranscript(provider, { transcriptPath, cwd, sessionId, opts } = {}) {
  if (!transcriptPath) return 0;
  const turns = provider.buildTurns(transcriptPath, opts || {});
  if (!turns.length) return 0;

  const effCwd = cwd || turns[0].cwd;
  if (!effCwd) return 0;
  // Skip projects whose directory no longer exists (stale history) — except in
  // aggregate mode, where records pool centrally and no folder is created in cwd.
  if (!process.env.AI_USAGE_DIR) {
    try {
      if (!fs.statSync(effCwd).isDirectory()) return 0;
    } catch {
      return 0;
    }
  }

  const cfg = await ensureProjectConfig(effCwd);
  if (!isEnabled(cfg)) return 0;
  return storeTurns(turns, effCwd, cfg, sessionId);
}
