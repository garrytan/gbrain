# Core memory: always-loaded pages

Core memory is a small set of pages that every session sees without asking:
who the user is, how they like to work, the projects in flight. The agent does
not have to search for them, and they survive context compaction because they
are re-delivered at the start of each session.

Everything else in the brain stays on demand (search, `query`, `recall`,
per-turn context). Core is for the few facts an agent should never have to
look up.

Core memory is opt-in: it is off until the owner turns it on. In the held-out
evaluation, loading a standing-preferences page in every session helped one
model and hurt another on instruction following, so it is not on by default
(see [the verdict](../eval/decisions/p4-heldout-core-2026-10-06/README.md)).
To use it:

```bash
gbrain config set memory.core.enabled true
gbrain core init                 # or: gbrain core add <slug>
```

The save-before-compaction notice ([below](#saving-before-compaction)) is a
separate feature and is on by default.

## What makes a page core

A page is core when its frontmatter says so:

```yaml
---
title: Working preferences
always_load: true
core_priority: 10   # optional; lower renders first (default 100)
---
```

Only `always_load: true` counts; any other value means not core. Pages render
in `core_priority` order, then by source and slug. Each page renders as a
heading plus its compiled truth (the part above the timeline); timeline
entries never enter core.

A session sees the `default` source's core first, then the core of its own
source when that is a different source. Private pages and pages in sources a
caller cannot read never render. Withdrawn facts (`forget`) are removed from
the rendered text.

The easiest way to manage the set is the CLI:

```bash
gbrain core list                 # core pages, priority order, rendered size
gbrain core status --json        # usage against the budget, largest pages
gbrain core add people/alice-example --priority 10
gbrain core remove people/alice-example
gbrain core show                 # the exact block a session receives
gbrain core suggest              # read-only candidates; --apply marks them
gbrain core init                 # creates a starter profile page and marks it core
```

## Budget

Core enters every session's prompt in every connected harness, so its total
rendered size is capped brain-wide by `memory.core.max_chars` (default 4,000
characters; allowed 500 to 6,000), with at most 50 core pages. The count uses
the final rendered block, headings included.

A write that would grow core past the budget is refused with
`core_budget_exceeded`. The message gives the projected size, how far over it
is, and the largest core pages the caller can see. Writes that shrink core
always pass, so an over-budget brain can always be brought back under.

What to do when a write is refused: move the detail into a linked non-core
page and keep a one-line pointer in the core page, or ask the user to raise
the budget (`gbrain config set memory.core.max_chars 6000`). `gbrain core
status --json` shows where the characters go.

The owner's own git edits are never blocked: a sync that pushes core over
budget still succeeds, and `gbrain doctor` reports the overage until it is
fixed. Every other write, including local CLI writes, is held to the budget.

## Owner only

Only the brain owner (a local CLI or a git edit on the brain host) decides
which pages are core:

- A remote caller (MCP, HTTP) cannot add or remove `always_load` or change
  `core_priority`; that write is refused with `core_mark_owner_only`. A remote
  rewrite that leaves those keys out keeps the stored values, so ordinary edits
  never drop a page out of core by accident.
- A remote caller cannot delete a core page (`core_delete_owner_only`).

Both refusals mean the user has to act. Relay the command the message names
(for example `gbrain core add --source default notes/x` or `gbrain core remove
people/alice-example`) and let the user run it.

## Remote edits

Because core text reaches every session, edits to core pages by remote
callers follow `memory.core.remote_edit`:

| Value | Behavior |
|---|---|
| `notify` (default) | The edit is saved, and the next sessions show a short notice naming the page and revision until the owner runs `gbrain core ack <slug> --revision <token>`. `gbrain core diff <slug>` shows what changed. |
| `allow` | The edit is saved with no notice. |
| `refuse` | The edit is refused with `core_remote_edit_refused`. Make the edit on the brain host, or ask the user to switch the setting. |

## Where core is delivered

| Harness | How core arrives |
|---|---|
| Claude Code | The session-start hook prints the core block first, then the usual digest. The heartbeat records `core_chars` and `core_revision`. `GBRAIN_CORE=0` suppresses core for one session. |
| OpenClaw | The context engine adds the core block on every turn from a read-only fetch, refreshed at most once a minute. |
| Any MCP client | `context_pack` returns a `core` field and prepends the block to `text`; call it with no `entities` to get core alone. Core counts inside `budget_tokens`. |
| Static instruction files | `gbrain compile-context --include-core` writes core into the compiled file. Targets include `codex-global` (`$CODEX_HOME/AGENTS.md`) and `hermes` (`.hermes.md`, kept out of git). Core is never written into a git-tracked file; `--remove-core` recompiles without it. |

## Saving before compaction

Long sessions get compacted, and whatever was only in the conversation is lost.
Two pieces cover that:

- `remember` takes `items`: up to 20 facts in one call, each with the usual
  fields (`fact`, optional `entity`, `kind`, `ttl`, `visibility`,
  `provenance`). Every item is validated before anything is written; each item
  is then saved as its own write and reported with its own status, and
  `partial: true` marks a batch where some items failed. Replaying the same
  `request_id` replays the same per-item outcomes.
- When a session's context is about 80% full, or sooner when it is growing
  fast (two more turns the size of the last one would reach the automatic
  compaction point), the next prompt carries one notice telling the agent to
  save what matters now with `remember` and `items`. It fires once per compaction segment, only when `remember` is
  callable, and follows the capture policy (TTL, visibility, exclusions).
  Turn it off with `gbrain config set memory.pressure.enabled false`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `memory.core.enabled` | `false` | Deliver core in sessions (opt-in). |
| `memory.core.max_chars` | `4000` | Brain-wide rendered budget, 500 to 6,000. |
| `memory.core.remote_edit` | `notify` | `allow`, `notify` or `refuse` for remote edits to core pages. |
| `memory.pressure.enabled` | `true` | The save-before-compaction notice. |
| `memory.pressure.warn_ratio` | `0.80` | Context fill ratio that triggers the notice. |
| `memory.pressure.context_window` | unset | Override the detected context window, in tokens. |

## Troubleshooting

`gbrain doctor` runs a `core_memory` check: core over budget, out-of-range
settings, core pages that are deleted or withheld, compiled files carrying an
old core revision, and writers that predate the core guard. Each finding names
its fix.
