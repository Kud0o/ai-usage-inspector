<div align="center">

# Claude Usage Tracker

**Record every Claude Code prompt — tokens, model, mode, effort, context %, and cost — then explore it in a local dashboard.**

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-success)
![Hook](https://img.shields.io/badge/Claude_Code-Stop_hook-e0785f)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

A tiny **zero-dependency** Claude Code hook that captures rich metadata about every
prompt — across all your concurrently-running workspaces — and a polished local
dashboard to slice through it.

```
 each Claude session ── Stop hook ── reads its transcript ──▶  one ndjson file per workspace
                                                                       │
                                            viewer (local web app) ◀───┘   filters · charts · drill-down
```

## Features

- **Per-prompt records** — prompt & response text, input/output/cache tokens, model,
  permission **mode**, configured **effort**, context-fill %, USD **cost**, duration,
  and tool/subagent/thinking counts.
- **Accurate accounting** — dedupes streamed transcript lines, attributes **subagent**
  token spend to the parent prompt, and prices each message at *its own* model.
- **Multi-workspace** — every workspace and session in one place; safe under concurrent writes.
- **Insightful dashboard** — summary cards, charts (tokens & cost over time, cost-by-model,
  context-fill distribution, mode split), filters, and click-to-expand drill-down.
- **Zero dependencies, zero build** — pure Node (`fs`/`http`). Nothing to `npm install`.

## Quick start

```sh
git clone https://github.com/Kud0o/claude-usage-tracker.git
cd claude-usage-tracker

node install.mjs --global          # register the hook for every workspace
npm run view                       # open the dashboard → http://localhost:4317
```

Then just use Claude Code as normal — each prompt is recorded automatically.

## Installation guide

### 1. Requirements

- **Node.js ≥ 18** (already present — it ships with Claude Code).
- **Claude Code** desktop or CLI.

Check Node: `node --version`.

### 2. Install the hook

Pick a scope:

```sh
node install.mjs --global     # track EVERY workspace   → ~/.claude/settings.json
node install.mjs --local      # track THIS project only  → ./.claude/settings.local.json
```

The installer:
1. Copies the app to `~/.claude/usage-tracker/app/`.
2. Adds a `Stop` hook pointing there (your existing settings keys are preserved).
3. Creates the data directory.

> Installing `--global` also enables tracking for your **current** session, so your
> next prompts are the first ones recorded.

### 3. View the dashboard

```sh
npm run view
# or directly:
node ~/.claude/usage-tracker/app/viewer/server.mjs
# custom port:
PORT=8080 node ~/.claude/usage-tracker/app/viewer/server.mjs
```

Open **http://localhost:4317**.

### 4. Uninstall

```sh
node install.mjs --uninstall            # remove from both scopes
node install.mjs --uninstall --global   # remove from one scope
```

The app and recorded data are left in `~/.claude/usage-tracker/` — delete that folder
manually if you want them gone.

## The dashboard

- **Summary cards** — prompts, total cost, total tokens, avg context, active time, top model, busiest workspace.
- **Charts** — tokens over time, cost / day, cost by model, context-fill distribution, permission-mode split (all inline SVG).
- **Filter bar** — workspace · model · mode · effort · date · free-text search · min-context %.
- **Table** — grouped by **workspace → session → prompt**, sortable on any column; click a row for the full prompt, response, and a raw usage/cost breakdown.

## How it works

Claude Code already writes a full JSONL transcript per session. The `Stop` hook fires
after each response; [`src/record.mjs`](src/record.mjs) re-derives that session's prompts
from the transcript and upserts them into a shared per-workspace file. No interception,
no instrumentation, no database.

Three details make the numbers trustworthy (all in [`src/lib/transcript.mjs`](src/lib/transcript.mjs)):

| Reality of the transcript | Handling |
|---|---|
| One assistant message spans many streamed lines sharing `message.id` | Dedupe by id; keep the final usage |
| Subagents live in separate `…/<session>/subagents/*.jsonl` files | Attribute to the parent prompt via `promptId` |
| Subagents may run a cheaper model | Price each message at its own model |

## Where the data lives

```
~/.claude/usage-tracker/data/workspaces/<encoded-cwd>.ndjson
```

**One file per workspace**, many sessions, one JSON record per prompt. Override the
location with the `CLAUDE_USAGE_DIR` environment variable.

**Concurrency:** different workspaces write different files (never contend); two sessions
in the *same* folder use a lock-guarded atomic write (`tmp`+rename, stale-lock stealing,
skip-on-timeout). Each `Stop` re-derives the whole session, so a skipped write self-heals
on the next prompt.

## Notes & caveats

- **effort** isn't in the transcript — it's read best-effort from `settings.json`
  (`effortLevel`) at capture time, so it reflects the configured level.
- **Pricing** is cached in [`src/lib/pricing.mjs`](src/lib/pricing.mjs); update it if rates change.
- **context fill %** = the last request's `input + cache_read + cache_creation` over the
  model's context window.

## Project layout

```
src/record.mjs          the Stop hook (entry point)
src/lib/transcript.mjs  parse JSONL → per-prompt turns (+ subagent attribution)
src/lib/pricing.mjs     model → context window + USD pricing
src/lib/store.mjs       lock-guarded atomic per-workspace upsert
src/lib/paths.mjs       data dir / settings / cwd-encoding helpers
viewer/server.mjs       zero-dep HTTP API + static host
viewer/public/          the dashboard SPA
install.mjs             installer (--global | --local | --uninstall)
```

## License

[MIT](LICENSE)
