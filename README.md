<div align="center">

# AI Usage Inspector

**Record every AI coding-agent prompt — tokens, model, mode, context %, and cost — from Claude Code and OpenAI Codex, then explore it in one local dashboard.**

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-success)
![Claude Code](https://img.shields.io/badge/Claude_Code-Stop_hook-2f6fed)
![OpenAI Codex](https://img.shields.io/badge/OpenAI_Codex-Stop_hook-10a37f)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

A tiny **zero-dependency** tool that hooks your AI coding agents — **Claude Code** and
**OpenAI Codex** — captures rich metadata about every prompt across all your
concurrently-running workspaces, and gives you one polished local dashboard to slice
through it. Each agent is a **provider**; the architecture is pluggable, so more can be
added.

```
 each agent session ── Stop hook ── reads its transcript ──▶  one ndjson file per workspace
                                                                      │
                                           viewer (local web app) ◀───┘   filters · charts · drill-down
```

## Features

- **Multi-provider** — tracks **Claude Code** and **OpenAI Codex** side by side, each priced
  and parsed by its own provider module; filter and compare by provider in the dashboard.
- **Per-prompt records** — prompt & response text, input/output/cache/reasoning tokens, model,
  permission **mode**, configured **effort**, context-fill %, USD **cost**, duration,
  **first-response latency**, invoked **skills**, and tool/subagent/thinking counts.
- **You choose what's tracked, per project** — each project owns its config in its own
  `.ai-usage/` (inherited from a global defaults template, then independent). Toggle
  recording per project and pick which **field groups** are stored; disabled groups are
  stripped before writing (smaller files, more privacy). Manage it from that project's
  ⚙ settings or its config file.
- **Accurate accounting** — dedupes streamed transcript lines, attributes **subagent**
  token spend to the parent prompt, and prices each message at *its own* model.
- **Self-contained per project** — each project's `.ai-usage/` holds its data, a bundled viewer, and your saved view settings (`config.json`). Safe under concurrent sessions. Opt into a combined dashboard with one env var.
- **Insightful dashboard** — summary cards, inline-SVG charts (tokens over time, context-fill
  distribution, permission-mode and per-model splits), a filter bar, and click-to-expand drill-down.
- **Built for any team** — professional **light / dark** themes with a one-click toggle,
  **locale-aware** numbers and dates, and broad-script typography (IBM Plex). The drill-down
  **renders Markdown** — tables, code blocks, and lists from your prompts and responses display
  as formatted content (with a raw toggle), safely escaped.
- **Manage your own data** — delete the prompts currently shown (scoped by any filter) or a
  single record from the drill-down to reclaim disk space; the viewer rewrites the on-disk
  files in place and reports how much was freed.
- **Zero dependencies, zero build** — pure Node (`fs`/`http`) on the server, vanilla JS on the
  client. Nothing to `npm install`, nothing to compile.

## Quick start

One line — no clone, no config, no environment variables:

```sh
npx -y github:Kud0o/ai-usage-inspector
```

That auto-detects which agents you have installed (Claude Code, OpenAI Codex) and
registers each one's `Stop` hook. Now just use your agent — each project becomes
**self-contained**: its data, its own copy of the viewer, and your saved view settings
all land in `<project>/.ai-usage/`. To look:

```sh
cd <your project>
node .ai-usage/viewer/server.mjs   # dashboard for this project → http://localhost:4317
```

To remove it: `npx -y github:Kud0o/ai-usage-inspector --uninstall`.

**Upgrading:** run the update command (or just re-run the one-liner):

```sh
npx -y github:Kud0o/ai-usage-inspector --update
```

It refreshes the shared app to the latest version, and each project re-bundles its own
viewer automatically on its next prompt (a version stamp detects the change), so existing
projects pick up the latest dashboard. Cloned repo? `git pull && node install.mjs --update`.

## Installation guide

### 1. Requirements

- **Node.js ≥ 18** (already present — it ships with Claude Code).
- At least one supported agent: **Claude Code** (desktop or CLI) and/or **OpenAI Codex** (CLI).

Check Node: `node --version`.

### 2. Install the hooks

One line — nothing to clone, configure, or set as an environment variable:

```sh
npx -y github:Kud0o/ai-usage-inspector          # auto-detects Claude Code + Codex
```

Or target one agent, or install from a clone:

```sh
node install.mjs              # every detected agent, all workspaces
node install.mjs --claude     # Claude Code only
node install.mjs --codex      # OpenAI Codex only
node install.mjs --local      # Claude Code: this project only → ./.claude/settings.local.json
```

The installer copies the app to `~/.ai-usage-inspector/app/` and registers each
agent's `Stop` hook in its own config — Claude Code's `~/.claude/settings.json`
and Codex's `~/.codex/config.toml` (a fenced block that's cleanly removed on
uninstall). Existing settings are preserved.

> Installing also enables tracking for your **current** session, so your next
> prompts are the first ones recorded.

### 2b. Backfill existing history (optional)

Hooks only record from install time forward. To import the session history both
agents already have on disk (Claude Code under `~/.claude/projects/…`, Codex
under `~/.codex/sessions/…`):

```sh
node install.mjs --sync                                  # at install time
node ~/.ai-usage-inspector/app/src/sync.mjs              # any time later
node ~/.ai-usage-inspector/app/src/sync.mjs --provider codex --days 30
```

Sync is idempotent (records upsert per session — re-running never duplicates)
and respects each project's tracking config: projects with tracking disabled
are skipped, exactly like the hook path.

### 3. View the dashboard

After a project's first prompt, it has its own viewer inside `.ai-usage/`.
Run it from the project:

```sh
cd <your project>
node .ai-usage/viewer/server.mjs            # → http://localhost:4317 (or next free port)
node .ai-usage/viewer/server.mjs --port 8080
```

By default the viewer picks the first free port starting at `4317`, so it
never fails to start because something else is already listening. Pin a
specific port with `--port` (or `$PORT`, or `"port"` in
`.ai-usage/config.json`).

Your filters, sort order, and grouping are saved per project in
`.ai-usage/config.json`. Add `.ai-usage/` to your project's
`.gitignore` so the records don't get committed.

### 4. Uninstall

```sh
node install.mjs --uninstall            # remove from both scopes
node install.mjs --uninstall --global   # remove from one scope
```

The app and recorded data are left in `~/.ai-usage-inspector/` — delete that folder
manually if you want them gone.

## The dashboard

- **Summary cards** — ordered by what matters for hands-on work: total tokens, prompts, average
  context, active time, top model, busiest workspace, and an estimated cost (de-emphasised, since
  most work isn't billed per API call).
- **Charts** — tokens over time, context-fill distribution, permission-mode split, prompts by model,
  skills invoked, and estimated cost / day (all inline SVG, theme-aware).
- **Filter bar** — workspace · model · mode · effort · date · free-text search · min-context %.
- **Table** — grouped by **workspace → session → prompt**, sortable on any column; a per-row badge
  flags how many **skills** a prompt invoked. Click a row to open a detail panel with the full
  prompt and response **rendered as Markdown** (tables, code, lists), the invoked skills as chips,
  plus a usage and cost breakdown.
- **Theme & locale** — light/dark toggle (defaults to your OS preference, remembered across visits);
  numbers, dates, and currency follow the viewer's browser locale.
- **Delete data** — a *delete shown* action removes exactly the records the current filters match
  (scope it by workspace, model, date, or search first), and each detail panel can delete that one
  prompt. Both ask for confirmation and report the space freed; deletions are permanent.

## Configuration

**Config is per project.** Each project owns its tracking + field choices inside its own
folder — the same file the viewer uses for title/port/ui:

```
<project>/.ai-usage/config.json
```

```jsonc
{
  "title": "MyApp", "port": 4317, "ui": { /* saved filters/sort/grouping */ }, // "port" is optional — omit it to auto-pick a free one
  "tracking": { "enabled": true },   // record this project?
  "fields": {                        // which field groups to store for this project
    "text": true, "tokens": true, "cost": true, "context": true,
    "timing": true, "skills": true, "counts": true, "meta": true
  }
}
```

A **global defaults template** lives at `~/.ai-usage-inspector/config.json`
(`{ "enabledDefault": true, "fields": { … } }`). It is *only* a template:

- **Global install** → each project **inherits a copy** of the defaults into its own
  `config.json` the first time it's seen, then is independent. Tracking is **on by default**;
  disable or tune a project from *its own* dashboard without affecting others.
- **Local install** (`node install.mjs --local`) → the project's `config.json` is written at
  install time (tracked, defaults applied) — fully self-contained, no reliance on the global file.
- **Aggregate mode** (`AI_USAGE_DIR`) is the one exception: with everything pooled in one
  folder there's no per-project file, so the global defaults govern directly.

- **Field groups** — `text` (prompt/response), `tokens`, `cost`, `context`, `timing`
  (duration + first-response latency), `skills`, `counts`, `meta` (git branch, cli version,
  slug, tier, effort). A disabled group is **stripped before writing**; already-stored data
  is left as-is. `text` off keeps the character counts but drops the text itself.
- **Two ways to manage it:** the dashboard's **⚙ settings** panel — which edits **only the
  project you're viewing** (record toggle + field groups) — or by editing that project's
  `config.json` directly. The global template is edited by hand for changing future defaults.

The viewer **adapts** to your choices: cards, charts, table columns, drawer rows and filters
for a disabled (or simply absent) field group don't render.

### Model pricing

Per-model token rates ship built-in, but the viewer keeps them current: when the
project tracks **cost**, each viewer start refreshes both providers' rates —

- **Claude** from Anthropic's public [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
  → cached at `~/.ai-usage-inspector/pricing-claude.json`
- **OpenAI** from [models.dev](https://models.dev) (open, machine-readable model/pricing
  dataset; OpenAI publishes no machine-readable pricing themselves)
  → cached at `~/.ai-usage-inspector/pricing-codex.json`

There's no pricing API or version to check, so it re-fetches every run and
**content-diffs** the result — a cache and its startup-log line only move when a
rate actually changed (it prints exactly which models moved). It's fully
best-effort: offline, or when cost isn't tracked, the built-in tables are used
and no fetch happens.

Costs are computed and stored **when each prompt is recorded**, so the refreshed
rates apply to turns recorded after the viewer last updated the cache (the `Stop`
hook reads the cache locally — it never makes a network call). New models the
table doesn't know about yet are picked up automatically; their context window
falls back to a default until the built-in table is updated.

## How it works

Both agents already write a full JSONL transcript per session (Claude Code under
`~/.claude/projects/…`, Codex under `~/.codex/sessions/…`). Each agent's `Stop` hook fires
after a response and runs [`src/record.mjs --provider <id>`](src/record.mjs), which hands
the payload to that **provider** ([`src/providers/<id>/`](src/providers/)) to re-derive the
session's prompts and upsert them into a shared per-workspace file. No interception, no
instrumentation, no database.

A provider owns everything agent-specific — the hook payload shape, the transcript parser,
the pricing table, and how its hook is registered — while the generic core (storage, config,
the turn-record schema, the dashboard) is shared. Every provider emits the **same** record,
so the viewer treats all agents identically.

For Claude Code, three details make the numbers trustworthy (in
[`src/providers/claude/transcript.mjs`](src/providers/claude/transcript.mjs)):

| Reality of the transcript | Handling |
|---|---|
| One assistant message spans many streamed lines sharing `message.id` | Dedupe by id; keep the final usage |
| Subagents live in separate `…/<session>/subagents/*.jsonl` files | Attribute to the parent prompt via `promptId` |
| Subagents may run a cheaper model | Price each message at its own model |

For OpenAI Codex, the rollout records cumulative token totals, so
[`src/providers/codex/transcript.mjs`](src/providers/codex/transcript.mjs) segments the
rollout into turns at each user message and takes the **delta** of the running total across
the turn — robust to multiple model calls per turn (tool loops).

## Where the data lives

Everything for a project lives **inside that project**, self-contained:

```
<project>/.ai-usage/
├── usage.ndjson     one JSON record per prompt (many sessions)
├── config.json      the viewer's saved settings (title, port, filters, sort, grouping)
└── viewer/          a copy of the dashboard — run it in place
```

The data never touches the agents' own dirs, and the viewer that ships with each project
reads its own sibling folder. (The app itself lives once at `~/.ai-usage-inspector/app/`;
only the recorded data + viewer copy are per-project.)

**Combined dashboard (optional):** set `AI_USAGE_DIR` to a shared folder for both the
hook and the viewer, and every project is collected there as `<encoded-cwd>.ndjson` — one
dashboard across all your workspaces (no per-project bundle in this mode).

**Concurrency:** two sessions in the *same* project use a lock-guarded atomic write
(`tmp`+rename, stale-lock stealing, skip-on-timeout). Each `Stop` re-derives the whole
session, so a skipped write self-heals on the next prompt.

## Notes & caveats

- **effort** isn't in the transcript — it's read best-effort from `settings.json`
  (`effortLevel`) at capture time, so it reflects the configured level.
- **Pricing** — Claude rates auto-refresh from Claude's public pricing docs (see above);
  OpenAI/Codex rates are the built-in table in
  [`src/providers/codex/pricing.mjs`](src/providers/codex/pricing.mjs) (no machine-readable
  OpenAI source), so update that file if OpenAI rates change.
- **context fill %** = the last request's `input + cache_read + cache_creation` over the
  model's context window.
- **first-response latency** is the gap from the prompt to the first streamed line of the
  first assistant message — a transcript-granularity approximation of time-to-first-token.
- **Disabling a field group affects new records only** — it does not scrub text or fields
  already written. Use *delete shown* to remove old records you don't want.

## Project layout

```
src/record.mjs                     hook entry point: node record.mjs --provider <id>
src/lib/ingest.mjs                 provider-neutral flow: normalize → buildTurns → upsert → bundle
src/lib/store.mjs                  lock-guarded atomic per-workspace upsert
src/lib/config.mjs                 global tracking/field config (copied into the bundle)
src/lib/paths.mjs                  data dir / cwd-encoding helpers (provider-neutral)
src/lib/pricing-core.mjs           shared cost object + math
src/providers/index.mjs            provider registry + install-detection
src/providers/claude/              Claude Code: transcript parser, pricing (+ docs scrape), hook
src/providers/codex/               OpenAI Codex: rollout parser, OpenAI pricing, config.toml hook
viewer/server.mjs                  zero-dep HTTP API + static host
viewer/public/                     the dashboard SPA
install.mjs                        installer (--claude | --codex | --local | --update | --uninstall)
```

## License

[MIT](LICENSE)
