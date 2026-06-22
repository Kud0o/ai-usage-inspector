<div align="center">

# Claude Usage Tracker

**Record every Claude Code prompt — tokens, model, mode, effort, context %, and cost — then explore it in a local dashboard.**

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-success)
![Hook](https://img.shields.io/badge/Claude_Code-Stop_hook-2f6fed)
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
- **Self-contained per project** — each project's `.claude-usage/` holds its data, a bundled viewer, and your saved view settings (`config.json`). Safe under concurrent sessions. Opt into a combined dashboard with one env var.
- **Insightful dashboard** — summary cards, inline-SVG charts (tokens over time, context-fill
  distribution, permission-mode and per-model splits), a filter bar, and click-to-expand drill-down.
- **Built for any team** — professional **light / dark** themes with a one-click toggle,
  **locale-aware** numbers and dates, and broad-script typography (IBM Plex). The drill-down
  **renders Markdown** — tables, code blocks, and lists from your prompts and responses display
  as formatted content (with a raw toggle), safely escaped.
- **Zero dependencies, zero build** — pure Node (`fs`/`http`) on the server, vanilla JS on the
  client. Nothing to `npm install`, nothing to compile.

## Quick start

One line — no clone, no config, no environment variables:

```sh
npx -y github:Kud0o/claude-usage-tracker
```

That registers the `Stop` hook for every workspace. Now just use Claude Code —
each project becomes **self-contained**: its data, its own copy of the viewer,
and your saved view settings all land in `<project>/.claude-usage/`. To look:

```sh
cd <your project>
node .claude-usage/viewer/server.mjs   # dashboard for this project → http://localhost:4317
```

To remove it: `npx -y github:Kud0o/claude-usage-tracker --uninstall`.

## Installation guide

### 1. Requirements

- **Node.js ≥ 18** (already present — it ships with Claude Code).
- **Claude Code** desktop or CLI.

Check Node: `node --version`.

### 2. Install the hook

One line — nothing to clone, configure, or set as an environment variable:

```sh
npx -y github:Kud0o/claude-usage-tracker
```

Or, if you've cloned the repo:

```sh
node install.mjs              # global — every workspace   → ~/.claude/settings.json
node install.mjs --local      # this project only          → ./.claude/settings.local.json
```

The installer makes exactly two changes: it copies the app to
`~/.claude/usage-tracker/app/` and adds one `Stop` hook entry to your settings
(existing keys are preserved). No environment variables, no other config.

> Installing also enables tracking for your **current** session, so your next
> prompts are the first ones recorded.

### 3. View the dashboard

After a project's first prompt, it has its own viewer inside `.claude-usage/`.
Run it from the project:

```sh
cd <your project>
node .claude-usage/viewer/server.mjs            # → http://localhost:4317
```

Your filters, sort order, and grouping are saved per project in
`.claude-usage/config.json` (set `"port"` there to change the default port).
Add `.claude-usage/` to your project's `.gitignore` so the records don't get
committed.

### 4. Uninstall

```sh
node install.mjs --uninstall            # remove from both scopes
node install.mjs --uninstall --global   # remove from one scope
```

The app and recorded data are left in `~/.claude/usage-tracker/` — delete that folder
manually if you want them gone.

## The dashboard

- **Summary cards** — ordered by what matters for hands-on work: total tokens, prompts, average
  context, active time, top model, busiest workspace, and an estimated cost (de-emphasised, since
  most work isn't billed per API call).
- **Charts** — tokens over time, context-fill distribution, permission-mode split, prompts by model,
  and estimated cost / day (all inline SVG, theme-aware).
- **Filter bar** — workspace · model · mode · effort · date · free-text search · min-context %.
- **Table** — grouped by **workspace → session → prompt**, sortable on any column; click a row to
  open a detail panel with the full prompt and response **rendered as Markdown** (tables, code,
  lists), plus a usage and cost breakdown.
- **Theme & locale** — light/dark toggle (defaults to your OS preference, remembered across visits);
  numbers, dates, and currency follow the viewer's browser locale.

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

Everything for a project lives **inside that project**, self-contained:

```
<project>/.claude-usage/
├── usage.ndjson     one JSON record per prompt (many sessions)
├── config.json      the viewer's saved settings (title, port, filters, sort, grouping)
└── viewer/          a copy of the dashboard — run it in place
```

The data never touches `~/.claude`, and the viewer that ships with each project reads its
own sibling folder. (The hook itself lives once at `~/.claude/usage-tracker/app/`; only the
recorded data + viewer copy are per-project.)

**Combined dashboard (optional):** set `CLAUDE_USAGE_DIR` to a shared folder for both the
hook and the viewer, and every project is collected there as `<encoded-cwd>.ndjson` — one
dashboard across all your workspaces (no per-project bundle in this mode).

**Concurrency:** two sessions in the *same* project use a lock-guarded atomic write
(`tmp`+rename, stale-lock stealing, skip-on-timeout). Each `Stop` re-derives the whole
session, so a skipped write self-heals on the next prompt.

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
