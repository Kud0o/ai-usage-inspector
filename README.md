<div align="center">

# AI Usage Inspector

**Record every AI coding-agent prompt — tokens, model, context %, and cost — then explore it in one local dashboard.**

![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-success)
![Tests](https://img.shields.io/badge/tests-149-success)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

Your coding agent spends tokens on every prompt. This records what each one cost — priced from
published rates, or taken from the agent when it reports its own —
locally, in the project it happened in — and gives that project its own dashboard.

It tracks **Claude Code**, **OpenAI Codex**, **Cursor**, **OpenCode**, and the VS Code
agents **Cline**, **Roo Code**, and **Kilo Code**, and normalizes them into one record
shape so they sit side by side in the same table.

```mermaid
flowchart TD
  A["Claude / Codex<br/>stop hook"] --> R["record.mjs<br/>spool, then exit 0"]
  B["Cursor / OpenCode<br/>hook is only a trigger"] --> R
  R --> S[("spool file")]
  S --> W["worker.mjs<br/>detached"]
  W --> I["ingest<br/>parse + gate"]
  W -. "then sweeps every<br/>detected agent" .-> I
  V["VS Code agents<br/>nothing to hook"] --> Y["sync.mjs<br/>manual, or 7 days on dashboard start"]
  Y --> I
  I --> D[("usage.ndjson")]
  D --> P["dashboard<br/>updates live"]
```

Two ways in, one way through. A live turn is captured the moment an agent stops. Anything
that fired no hook — a VS Code agent, or a CLI another agent launched — is picked up by the
sweep the same detached worker runs straight afterwards, or by `sync.mjs`, which the
dashboard also starts in the background over the last seven days. Everything meets at the
same ingest step.

## Features

- **Multi-agent, one table** — seven agents side by side, with provider filters, badges, charts, and cost/token splits.
- **Per-prompt detail** — prompt and response text, input/output/cache/reasoning tokens, model, permission mode, context fill %, USD cost, duration, first-response latency, skills, and tool/subagent counts where the agent exposes them.
- **Stays out of your agent’s way** — the hook writes the payload to a spool file and exits; a detached worker does the parsing and writing. It reads stdin with a 150 ms idle cutoff and a two-second ceiling, so it returns even if the agent leaves the pipe open.
- **Yours, locally** — records live in your project, tracking can be turned off per project, and whole field groups (including the prompt text) can be stripped before anything is written. Turning a group off stops new recording; rows you already collected keep what they have.
- **Live dashboard** — the page follows the data as it is recorded, with full-text search, CSV/JSON export, and an optional monthly budget.
- **Zero dependencies, zero build** — pure Node built-ins and vanilla browser JS, covered by the built-in regression suite.

## Quick start

```sh
npx -y ai-usage-inspector
```

Or install it once and keep the command around:

```sh
npm install -g ai-usage-inspector
ai-usage-inspector
```

To run the unreleased tip instead, point npx at the repo:
`npx -y github:Kud0o/ai-usage-inspector`.

That looks for each agent’s own data directory, and registers a hook wherever one can run. Then just
use your agent — each project becomes self-contained, with its data, its own copy of the
viewer, and your saved view settings in `<project>/.ai-usage/`. To look:

Open **`.ai-usage/Open dashboard.cmd`** in the project (`Open dashboard.command` on macOS,
`open-dashboard.sh` on Linux). It starts the dashboard if it is not already running, waits until it
is actually up, and opens your browser at the right port. Click it again while that project's server
is still healthy and it reuses the process; simultaneous clicks are serialized so only one server
starts. There is no window to leave open — the server stops on its own a few minutes after you close
the last dashboard tab.

The launcher is written only after a successful non-aggregate store. Disabled projects, projects
with no stored turns, and aggregate-mode projects therefore do not get one. After upgrading, an
existing project gets it on its next successfully stored prompt. The launcher also needs `node` on
the GUI process's `PATH`; if it is missing, the shell reports that `node` was not found and the
dashboard does not open (the Windows launcher pauses so the message remains visible).

From a terminal, if you prefer:

```sh
cd <your project>
node .ai-usage/viewer/server.mjs   # -> http://localhost:4317
```

Add `.ai-usage/` to that project's `.gitignore` so the records are not committed.

```sh
npx -y ai-usage-inspector --update      # upgrade
npx -y ai-usage-inspector --uninstall   # remove the hooks
```

## Supported agents

| Agent | Where the numbers come from | Registered in | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/projects/.../*.jsonl` | `~/.claude/settings.json` | Exact usage, streamed-message dedupe, subagent attribution, skills |
| OpenAI Codex | `~/.codex/sessions/.../rollout-*.jsonl` | `~/.codex/hooks.json` | Cumulative token deltas per turn |
| Cursor | `state.vscdb` SQLite stores | `~/.cursor/hooks.json` | Needs Node >= 22.5. Estimates tokens when Cursor stores no exact counts |
| OpenCode | `~/.local/share/opencode/opencode.db` | `~/.config/opencode/plugins/` | Needs Node >= 22.5. Tokens **and cost as OpenCode recorded them**; a session whose per-message accounting is incomplete is stored as one rolled-up row |
| Cline · Roo · Kilo | `<VSCode>/User/globalStorage/<extId>/tasks/` | none — scan only | Tokens and cost as the extension recorded them. VS Code extensions cannot run a turn-end hook, so these arrive on sync or on the sweep any other agent triggers |

**Requirements:** Node >= 18, or >= 22.5 for Cursor and OpenCode (they are read from SQLite
via the built-in `node:sqlite`).

> **Antigravity** is detected and reported as unsupported: it encrypts its local
> conversations, so there is nothing on disk to read. **GitHub Copilot** is not supported
> either and is not detected — VS Code records the model it used but no token counts, so a
> row would carry a name and nothing to weigh it by.

## Installing

```sh
node install.mjs                  # every detected agent
node install.mjs --claude         # or one at a time: --codex --cursor --opencode
node install.mjs --cline          #                   --roo --kilo
node install.mjs --local          # Claude Code, this project only
node install.mjs --sync           # install, then import existing history
node install.mjs --dashboard      # one dashboard across every project
node install.mjs --uninstall      # remove the hooks
```

The installer copies the app to `~/.ai-usage-inspector/app/` and registers each agent's
hook in that agent's own config. Entries are marked, so uninstall removes only this tool's
hook and leaves your settings — including your own hooks — untouched.

After installing Codex tracking, open `/hooks` in Codex and trust the hook. Codex
deliberately skips new or changed command hooks until their definition is reviewed.

### Importing history you already have

A hook reparses the session it fires on, so its earlier turns arrive too, and the automatic sweep looks back a day on first run. To import everything the agents already have on disk:

```sh
node $HOME/.ai-usage-inspector/app/src/sync.mjs                      # everything
node $HOME/.ai-usage-inspector/app/src/sync.mjs --provider codex --days 30
node $HOME/.ai-usage-inspector/app/src/sync.mjs --reprice            # recompute stored costs
node $HOME/.ai-usage-inspector/app/src/sync.mjs --relabel            # refresh provenance where the amount is unchanged
```

Sync is idempotent — records upsert per session, so re-running never duplicates — and it
respects each project's tracking setting. Records you deleted in the dashboard stay
deleted: a tombstone is kept per record, and sync honours it.

## The dashboard

```sh
node .ai-usage/viewer/server.mjs                 # first free port from 4317
node .ai-usage/viewer/server.mjs --port 8080     # pinned: fails if taken, rather than moving
node .ai-usage/viewer/server.mjs --no-sync       # do not import the last 7 days on start
node .ai-usage/viewer/server.mjs --no-pricing-refresh   # do not fetch rates on start
```

- **Summary cards** — prompts, tokens, active time, first-response latency, top model, busiest workspace, this-month cost against an optional budget. With more than one agent in view, cost carries a per-agent split and a **by agent** breakdown appears.
- **Charts** — tokens over time, context-fill distribution, permission mode, turns by model, skills invoked, cost per day, and per-agent splits.
- **Filter bar** — provider, platform, workspace, model, mode, effort, date, minimum context %, and free-text search. Export the filtered view as CSV or JSON.
- **Table and detail drawer** — grouped by workspace → session → prompt, with rendered Markdown, usage, timing, cost, and metadata per turn.
- **Settings** — per project: tracking on/off, which field groups to store, monthly budget.
- **Delete** — remove the filtered records or a single prompt, with confirmation and the space the records freed. A small tombstone is kept for each, so a re-sync cannot resurrect it.

Search matches the **whole stored prompt and response**, not the 280-character preview the
table shows, and JSON export fetches the full stored records — falling back to those previews, and saying so, if that fetch fails. The page subscribes to a change
feed and refreshes itself as the worker records new turns.

> The dashboard serves your prompt text and exposes a delete API, so it binds to
> `127.0.0.1`. Set `AI_USAGE_HOST` only if you deliberately want it reachable from your
> network.

## Where your data lives

Everything for a project stays inside that project:

```text
<project>/.ai-usage/
|-- usage.ndjson     one JSON record per prompt
|-- tombstones.json  records you deleted, so a later sync cannot bring them back
|-- config.json      tracking, stored fields, and saved view settings
|-- Open dashboard.cmd   double-click to open the dashboard (.command / .sh elsewhere)
`-- viewer/          a copy of the dashboard; run it in place
```

Machine-wide state lives once, outside your projects, in `~/.ai-usage-inspector/`: the
installed `app/`, the hook `spool/` (normally empty), `scan-state.json`, and cached pricing
tables. While a launcher-started dashboard is open, its pid, port, absolute data path, and nonce
live in the OS temporary directory under a key derived from the canonical project path. That
machine-local coordination file goes away when the server stops and is never stored in the project.

The only thing written into an agent's own directory is its hook — listed in the table above,
and removed by `--uninstall`. Your prompts and costs never leave your machine: the hook and
sweep paths make no network calls at all. The one thing that does is the dashboard fetching
public pricing pages when it starts, which `--no-pricing-refresh` turns off.

**Tracking is on by default and per project.** Turn it off, or strip whole field groups —
`text` (the prompt and response themselves), `tokens`, `cost`, `context`, `timing`,
`skills`, `counts`, `meta` — from that project's dashboard settings or its `config.json`. A
disabled group is stripped *before* anything is written. See
[configuration in depth](docs/internals.md#configuration-in-depth).

**Combined dashboard:** point `AI_USAGE_DIR` at a shared folder, for both the hook and the
viewer, to pool every project into one dashboard.

## Why it does not slow your agent down

A stop hook runs on the agent's clock, so this one does almost nothing:

```mermaid
flowchart TD
  subgraph clock["on the agent's clock"]
    H["stop hook fires"] --> L["record.mjs<br/>read stdin, spool, spawn, exit 0"]
  end
  L --> F[("spool entry")]
  F --> K["worker.mjs<br/>parse, scan, lock, write"]
  K --> N[("usage.ndjson")]
```

Only the boxed step is time the agent pays for. `record.mjs` imports no provider, opens no
database, and takes no lock — it writes the payload to the spool and returns. Measured on
Windows it comes back in 160-210 ms depending on the machine, and most of that is Node
starting up at all (~110-125 ms measured bare), so the tool itself costs roughly 50-80 ms.

The handover is built not to drop work: spool entries are claimed by atomic rename, and a
failed write is retried rather than dropped. A turn is given up only after three attempts
or seven days, and a payload over 1 MiB is truncated rather than held. See [the spool](docs/internals.md#the-spool) and
[the write](docs/internals.md#the-write).

### Work you delegate to another agent

Agents launched non-interactively by another agent — a delegate skill running `codex exec`, for
example — write their own transcript but fire no stop hook, so nothing tells this tool they ran.
Their cost is real and it belongs to the same project.

So after the worker has drained the spool, it also sweeps every installed provider for work that
arrived without a hook. That happens in the already-detached worker, off the agent's clock, and is
throttled so a burst of turns does not re-walk every store. The next turn from any agent pulls in
whatever the delegated one spent, without the delegate skill having to cooperate. How soon depends
on the next turn arriving: a provider is swept at most once a minute, and only if its agent was
detected at all.

Delegated turns land in the project the delegate itself reports as its working directory, so a run
launched against your repo is filed under your repo, not under wherever the launcher happened to be.

This covers the same agents the dashboard already scans, just sooner. If you would rather history
only arrive when you open the dashboard, set `"autoSweep": false` in
`~/.ai-usage-inspector/config.json`. A `--local` install never sweeps: it means this project only.

The dashboard then splits the numbers by agent, so delegated spend is visible rather than folded
into one total:

```text
cost  $695.50
      claude $655.14 · codex $40.36
```

The **by agent** card breaks that down further — prompts, tokens, active time, cost and share of
spend per agent. It appears whenever the view holds more than one agent.

## How much to trust a cost

Not every dollar figure is equally trustworthy, so each record says where its number came
from — and that decides what a re-sync may do with it:

| `cost.source` | Who worked the number out | On a re-sync |
|---|---|---|
| `provider` | the agent itself (OpenCode, Cline / Roo / Kilo) | **always taken fresh** — it is the authority on its own number |
| `priced` | this tool, from a rate table (Claude, Codex, Cursor with exact counts) | **kept as recorded** |
| `estimated` | this tool, but something in the number was a guess — token counts derived from text length (Cursor with no local counts), or a model with no listed rate, charged at its family default | **kept as recorded** |

A cost this tool worked out is a fact about the day the turn ran, so re-importing history
does not quietly restate it at today's rates — pass `--reprice` when you want that. If a row is
labelled `estimated` and you now know the real rate, `--relabel` refreshes the provenance and
leaves the amount exactly as recorded. A turn
mixing exact and estimated parts counts as estimated overall, so a guess is never shown as
authoritative.

Rates ship built-in and refresh best-effort when the dashboard starts; the hook path never
touches the network. See [pricing refresh](docs/internals.md#pricing-refresh), and
[the numbers behind all this](docs/internals.md#the-numbers-behind-all-this) for the limits,
windows and retry bounds these paths run under.

## Caveats

- **Some rows are approximate, and say so.** A row is marked `≈ estimated` when Cursor's
  local stores held no exact token counts (it derives them from text length), or when the
  model has no listed price and is charged at its family default rate. Built-in rates cover
  current models; the dashboard refreshes them, so a brand-new model is usually only
  estimated until that first refresh. OpenCode and the VS Code agents report exact tokens
  and cost themselves, so their rows are never estimated.
- **Auto-continued turns are not prompts.** When a session runs out of context it is compacted, and
  the continuation is written as if the user had typed it. Those turns are marked `⟳` and counted
  separately from prompts — the work they did is real and its cost is included, but nobody asked for
  it in those words.
- **`effort` is Claude-specific**, and read from settings at capture time. Other agents
  leave it blank unless they expose it.
- **`context fill %`** uses the latest request's input size over the known model context
  window; unknown windows fall back to a default.
- **First-response latency** is transcript-granularity timing, not a model-side metric.
- **Disabling a field group affects new records only.** It does not scrub what is already
  written — use the delete controls for that.

More, including the rougher edges: [Internals](docs/internals.md).

## License

[MIT](LICENSE)
