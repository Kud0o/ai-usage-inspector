// Cline / Roo Code / Kilo Code providers. All three are the same VS Code agent
// lineage (Roo and Kilo fork Cline) and share one on-disk task format, so a
// single factory produces all three — each just supplies its id, display name,
// and VS Code extension id.
//
// These are SCAN-ONLY: VS Code extensions can't run our command on turn-end, so
// there is no live hook. They are captured by sync.mjs and the viewer's autoSync
// (every launch), exactly like backfill for the other providers. Pure Node — no
// node:sqlite, so no Node >= 22.5 requirement.
import { listExtensionTasks } from "../../lib/vscode.mjs";
import { buildTurns as buildClineTurns } from "./transcript.mjs";

function makeProvider({ id, displayName, extId }) {
  return {
    id,
    displayName,
    extId,

    /** Present when at least one task dir exists for this extension. */
    detect() {
      try {
        return listExtensionTasks(extId).length > 0;
      } catch {
        return false;
      }
    },

    buildTurns(ref, opts = {}) {
      return buildClineTurns(ref, { ...opts, provider: id });
    },

    /** Tasks updated at/after `sinceMs`. Entries: { transcriptPath:{taskId,dir}, opts }. */
    discoverTranscripts({ sinceMs = 0 } = {}) {
      const out = [];
      for (const t of listExtensionTasks(extId, { sinceMs })) {
        out.push({ transcriptPath: { taskId: t.taskId, dir: t.dir, provider: id }, opts: { provider: id } });
      }
      return out;
    },

    // No hook to register — capture is via sync. install/uninstall are no-ops so
    // the installer can report the provider without special-casing it.
    install() {
      return { file: null, action: "scan-only" };
    },
    uninstall() {
      return { file: null, removed: 0 };
    },
  };
}

export const cline = makeProvider({ id: "cline", displayName: "Cline", extId: "saoudrizwan.claude-dev" });
export const roo = makeProvider({ id: "roo", displayName: "Roo Code", extId: "rooveterinary.roo-cline" });
export const kilo = makeProvider({ id: "kilo", displayName: "Kilo Code", extId: "kilocode.kilo-code" });
