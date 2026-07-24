// Provider registry. Each provider owns one AI tool's payload/transcript/pricing/
// hook details behind a common interface; the generic core (ingest, store,
// config, viewer) is provider-neutral.
import * as claude from "./claude/index.mjs";
import * as codex from "./codex/index.mjs";
import * as cursor from "./cursor/index.mjs";
import * as opencode from "./opencode/index.mjs";
import * as continueProvider from "./continue/index.mjs";
import { cline, roo, kilo } from "./clinefamily/index.mjs";

const PROVIDERS = {
  [claude.id]: claude,
  [codex.id]: codex,
  [cursor.id]: cursor,
  [opencode.id]: opencode,
  [cline.id]: cline,
  [roo.id]: roo,
  [kilo.id]: kilo,
  [continueProvider.id]: continueProvider,
};

export function getProvider(id) {
  return PROVIDERS[id] || null;
}

export function listProviders() {
  return Object.values(PROVIDERS);
}

/** Providers whose AI tool appears to be installed on this machine. */
export function detectInstalled() {
  return listProviders().filter((p) => {
    try {
      return p.detect();
    } catch {
      return false;
    }
  });
}
