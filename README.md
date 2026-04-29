# MBrain

MBrain is a local SQLite memory layer for one person and their local AI agents.
Your Markdown stays readable. The database makes it searchable, resumable, and
usable through CLI or MCP.

The default path is simple:

```bash
bun add -g github:meghendra6/mbrain
mbrain init --local
# Import any directory of Markdown files.
mbrain import ~/git/brain
mbrain query "what do we know about product strategy?"
mbrain serve
```

That creates a local SQLite brain at `~/.mbrain/brain.db`. No Supabase, OpenAI,
Anthropic, or hosted database is required to start. `mbrain serve` is the
long-running stdio MCP process your agent connects to.

## Why This Exists

LLM context is temporary. Agent memory is often operational and narrow. A real
personal brain needs something more durable:

- notes you can read and edit directly
- provenance for facts and claims
- search that works across thousands of pages
- task state that survives across sessions
- scoped personal memory that does not leak into work by default
- a review path for uncertain or inferred claims
- an MCP surface that agents can use without learning a separate app

MBrain keeps Markdown as the source of truth and uses the database as an index,
memory substrate, and operational record. Humans can still open the repo, edit a
page, review a diff, and repair mistakes.

## The Core Loop

MBrain is built around the brain-agent loop:

```text
Signal arrives: meeting, note, task, code question, conversation
  -> Agent detects entities, concepts, tasks, and memory candidates
  -> Agent reads the brain first
  -> Agent answers with context and provenance
  -> Agent writes durable updates to the right memory domain
  -> MBrain syncs, indexes, embeds, audits, and prepares the next read
```

The point is compounding context. If an agent learns something once, it should not
have to rediscover it in the next session.

## Quick Start: Local SQLite

Any directory of Markdown files can be a brain repo. If you do not have one yet,
make a tiny one first:

```bash
mkdir -p ~/tmp/mbrain-demo/concepts
printf '%s\n' '# First note' '' 'MBrain should remember this local demo note.' > ~/tmp/mbrain-demo/concepts/first-note.md
```

### 1. Install Bun

```bash
curl -fsSL https://bun.com/install | bash
exec "$SHELL"
bun --version
```

### 2. Install MBrain

```bash
bun add -g github:meghendra6/mbrain
mbrain --version
```

### 3. Create a local brain

```bash
mbrain init --local
```

This writes `~/.mbrain/config.json` and creates a SQLite database. The default
database is `~/.mbrain/brain.db`, stored in config as an expanded absolute path.

Use a custom path if you want the database somewhere else:

```bash
mbrain init --local --path ~/brains/personal-brain.db
```

### 4. Import your Markdown

```bash
mbrain import ~/tmp/mbrain-demo
```

Import is idempotent. Re-running it skips unchanged files by content hash. In
local mode, import writes pages and chunks first; embeddings are deferred so the
brain is usable immediately.

When you are ready, replace `~/tmp/mbrain-demo` with your real notes directory,
for example `~/git/brain` or an Obsidian vault.

### 5. Search

```bash
mbrain search "local demo"
mbrain query "what should MBrain remember?"
mbrain stats
mbrain health
```

Keyword search works immediately through SQLite FTS5. Semantic search comes
online after embeddings are backfilled.

### 6. Add optional local embeddings

MBrain defaults to a local Ollama-compatible embedding runtime and
`nomic-embed-text`.

```bash
ollama pull nomic-embed-text
mbrain embed --stale
```

Runtime resolution order:

1. `MBRAIN_LOCAL_EMBEDDING_URL`
2. `OLLAMA_HOST`
3. `http://127.0.0.1:11434/api/embed`

MBrain applies `search_document:` and `search_query:` prefixes internally for
`nomic-embed-text`.

### 7. Connect an agent

For Codex, Claude Code, or another stdio MCP client:

```bash
mbrain serve
```

Or let MBrain register the local MCP server and install the agent rules:

```bash
mbrain setup-agent
mbrain setup-agent --codex
mbrain setup-agent --claude
```

The agent rules matter. The MCP tools give an agent access to the brain; the
rules teach it when to read, when to write, how to cite, and how to avoid
writing the wrong thing into memory.

## What You Can Ask

Once your notes are imported, the useful questions are the ones only your brain
can answer:

```text
Search the brain for what we know about the Series A.
What did I decide last time I investigated SQLite vs Postgres?
Resume the task about candidate status events.
What personal preferences should the agent remember about scheduling?
Show me stale memory candidates that need review.
Find the exact page or section that mentions operator fusion.
Map this codebase before changing retrieval routing.
Give me a bounded briefing for tomorrow's meetings.
```

MBrain is not a chat UI. It is the memory layer beneath the agent or CLI you
already use.

## How It Works

MBrain has three moving parts:

| Piece | What it does |
|---|---|
| Markdown repo | The human-readable source of truth. You can edit it, diff it, and repair it directly. |
| SQLite index | The local database that stores pages, chunks, links, embeddings, tasks, and governed memory state. |
| Agent loop | The behavior that reads first, answers with context, writes back with provenance, and syncs changes. |

From there, MBrain adds stricter memory domains only where they help: task state
for resuming work, profile memory for scoped personal facts, and the Memory
Inbox for uncertain claims that need review before they become durable memory.

## Markdown Pages

Curated knowledge pages use the compiled truth + timeline pattern:

```markdown
---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth]
---

Paul Graham's argument that startups should do unscalable things early on.
The key point is that the unscalable work teaches you what users actually want.

---

- 2013-07-01 | Published on paulgraham.com
- 2026-04-25 | Referenced during onboarding strategy discussion
```

Above the separator is compiled truth: the current best understanding. Below the
separator is the evidence timeline: append-only history.

The compiled truth is what you read first. The timeline is how you audit it.

## Long-Term Memory Governance

Agents infer things. Some inferences are useful. Some are wrong. MBrain does not
treat every inferred claim as durable memory.

Example: an agent hears that you now prefer decaf after lunch. It should not
overwrite an older espresso preference without evidence. It can store the new
claim as a candidate, keep the source reference, ask for review, and then promote
or reject it.

That review flow is the Memory Inbox:

```text
captured -> candidate -> staged_for_review
                    -> promoted
                    -> rejected
                    -> superseded
```

The system keeps the audit trail behind that flow:

- source references for every promotable claim
- candidate status events
- promotion preflight checks
- rejection reasons
- supersession links when newer memory replaces older memory
- handoff records when a promoted candidate is ready for durable memory
- validity checks for stale or superseded claims
- mutation ledger events for governed writes
- memory realms and sessions for scoped write authority
- redaction plans for reviewable removal of sensitive page text
- memory operations health reports for operator visibility

This is the difference between "the agent wrote something down" and "the system
knows why this claim is allowed to matter."

## Work Continuity

MBrain has first-class operational memory for long-running agent work:

- task threads
- working sets
- attempts
- decisions
- retrieval traces
- resume cards
- code claim re-verification

That lets an agent resume a task without re-reading the whole repo, repeating
failed attempts, or treating old code paths as current without checking them.

The main commands are:

```bash
mbrain task-start --title "Rewrite README" --goal "Reflect current product"
mbrain task-attempt --task-id <id> --summary "Reviewed old README" --outcome "succeeded"
mbrain task-decision --task-id <id> --summary "Lead with SQLite" --rationale "Single-user path is default"
mbrain task-working-set <id> --active-paths README.md --next-steps "run review"
mbrain task-show <id>
```

## Personal Memory and Scope

Personal memory is useful only if it stays scoped. MBrain keeps personal records
separate from work retrieval by default.

Two canonical personal stores are available:

- profile memory: stable facts and preferences
- personal episodes: append-only events and interaction summaries

Scope-gated operations prevent accidental leakage. In normal use, these are
agent-facing operations: the agent decides whether a request is personal, work,
or mixed before it writes profile memory or personal episodes.

Mixed-scope routes exist, but they are explicit. Export also respects visibility:
private-only profile memory stays private; exportable profile memory can be
written as curated Markdown.

## Derived Orientation: Maps and Atlases

Search finds pages. Orientation tells the agent where to look next.

MBrain can build note manifests, section indexes, context maps, and context
atlases from canonical state. Those derived artifacts help with broad synthesis
and codebase navigation: they can show useful entry points, paths, and related
systems before the agent reads source files.

They remain derived. If a map suggests a claim, that claim still needs canonical
evidence or Memory Inbox governance before it becomes durable memory.

## Search and Retrieval

MBrain has two basic search modes:

```bash
mbrain search "exact term or entity"
mbrain query "conceptual question across the brain"
```

Internally:

```text
query
  -> optional expansion
  -> keyword search
  -> vector search when embeddings exist
  -> reciprocal-rank fusion
  -> dedup and diversity controls
  -> stale and provenance-aware output
```

SQLite uses FTS5 for keyword search and a stored-vector local cosine scan for
semantic recall. Postgres uses tsvector and pgvector when you choose the managed
path.

For richer routing, agents can use intent-specific operations for precision
lookup, broad synthesis, task resume, mixed-scope recall, brain-loop audit, and
code-claim verification. For cross-scenario prompts, agents can also classify
the memory scenario, select activation policy for candidate artifacts, and plan
the next memory reads before invoking route-specific tools. The default rule is
simple: canonical sources first, derived orientation second, live verification
when claims depend on the current workspace.

## Engines

MBrain uses a pluggable `BrainEngine` interface. The public CLI and MCP contract
stays stable while storage engines differ internally.

| Engine | Best for | Status |
|---|---|---|
| SQLiteEngine | Single-user local/offline personal brain | Recommended default |
| PGLiteEngine | Embedded Postgres-like local path and migration testing | Supported local path |
| PostgresEngine | Managed scale, pgvector, remote MCP, file/storage workflows | Optional managed path |

Use SQLite if you are one person using one machine. It is simpler, cheaper, and
easier to back up. Use Postgres when you need hosted scale, remote access, or
cloud file storage.

See `docs/ENGINES.md` for the engine contract and capability matrix.

## CLI Overview

Setup and diagnostics:

```bash
mbrain init --local
mbrain setup-agent
mbrain doctor --json
mbrain check-update --json  # online/managed profiles; local/offline returns offline_mode
mbrain migrate --to pglite
```

Pages and search:

```bash
mbrain get people/example
mbrain put concepts/example < page.md
mbrain list --type concept -n 20
mbrain search "exact phrase"
mbrain query "broad question"
```

Sync and embeddings:

```bash
mbrain import ~/git/brain
mbrain sync --repo ~/git/brain
mbrain sync --repo ~/git/brain --watch --interval 60
mbrain embed --stale
```

After `import` or `sync` records the markdown repo path, `put_page` / `mbrain put`
writes the matching `<slug>.md` file first and then refreshes the database index.

Links, tags, timelines, versions:

```bash
mbrain link concepts/a concepts/b --link-type depends_on
mbrain backlinks concepts/b
mbrain graph concepts/a --depth 2
mbrain tag concepts/a retrieval
mbrain timeline-add concepts/a 2026-04-25 "Updated after review"
mbrain history concepts/a
mbrain revert concepts/a <version-id>
```

Deterministic tools that do not need a database:

```bash
mbrain publish page.md --password
mbrain check-backlinks check --dir ~/git/brain
mbrain lint ~/git/brain --fix
echo "Reviewed open memory candidates." | mbrain report --type weekly --title "Weekly review"
```

Raw operation calls are available when an agent or script needs the full surface:

```bash
mbrain --tools-json
mbrain call get_stats '{}'
mbrain call plan_scenario_memory_request '{"query":"Resume the retrieval refactor","task_id":"task-123"}'
```

## MCP

`mbrain serve` exposes the same operation definitions over stdio MCP. That means
Codex, Claude Code, Cursor, Windsurf, and other MCP clients can use the same
tools the CLI uses.

Common local configuration:

```bash
codex mcp add mbrain -- mbrain serve
```

Claude Code style:

```json
{
  "mcpServers": {
    "mbrain": {
      "command": "mbrain",
      "args": ["serve"]
    }
  }
}
```

The MCP server includes compact instructions that tell agents when to prefer
MBrain over web search or codebase grep. For durable behavior, also install the
agent rules with `mbrain setup-agent`.

Remote MCP remains a managed/Postgres-oriented path. See `docs/mcp/DEPLOY.md`
and the other guides in `docs/mcp/`.

## File Storage

Local SQLite mode keeps files in your filesystem or git repo. Cloud file/storage
commands are intentionally reported as unsupported in local mode.

Managed Postgres mode can use file metadata and object storage workflows:

```bash
mbrain files list
mbrain files upload ./deck.pdf --page sources/demo-day
mbrain files sync ./attachments
mbrain files verify
```

Use this path only if you need cloud storage or remote deployment. It is not
required for a local personal brain.

## Recommended Agent Behavior

The best way to use MBrain is not to memorize commands. It is to teach the agent
the operating loop:

- detect entities, systems, concepts, tasks, and memory candidates
- search or query MBrain before falling back to web search or repo grep
- read compiled truth first, then inspect timeline evidence when needed
- write new facts with source attribution
- put uncertain claims into the Memory Inbox
- promote only claims with provenance
- sync after writes and backfill embeddings when needed
- audit the loop periodically

The core references are:

- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MBRAIN_SKILLPACK.md`
- `docs/guides/brain-agent-loop.md`
- `docs/guides/source-attribution.md`
- `docs/guides/brain-vs-memory.md`

## Verification

For local/default verification, run:

```bash
bun test
bun run test:e2e:sqlite
bunx tsc --noEmit --pretty false
```

The SQLite E2E suite covers:

- local `mbrain init --local`
- import, sync, query, write, export
- stdio MCP lifecycle tools
- profile memory
- personal episodes
- task memory
- memory candidates
- promotion, rejection, supersession, handoff, historical validity
- candidate status events and brain-loop audit
- memory realms, sessions, mutation ledger events, dry-run mutation checks,
  patch apply, redaction plans, and memory operations health
- forgetting/deletion behavior

Network and managed Postgres tests are gated by environment such as
`DATABASE_URL`; they are skipped when that environment is not configured.

Scenario-level invariants live in `test/scenarios/`. The current scenario suite
has no placeholder tests and covers fresh install, task resume, routing, scope
denial, promotion provenance, supersession, rejection, canonical-first retrieval,
precision degradation, code-claim verification, export boundaries, retrieval
traces, brain-loop audit, interaction-linked writes, nullable interaction IDs,
and candidate status event auditing. Scenario-aware memory request planning has
focused unit and operation coverage alongside the scenario suite.

## Documentation Map

Start here:

- `docs/local-offline.md` - first-day SQLite setup
- `docs/local-offline.ko.md` - Korean SQLite setup guide
- `docs/ENGINES.md` - SQLite, PGLite, and Postgres engine contract
- `docs/MBRAIN_VERIFY.md` - verification runbook
- `test/scenarios/README.md` - end-to-end design scenario contract

Architecture:

- `docs/architecture/redesign/00-principles-and-invariants.md`
- `docs/architecture/redesign/01-target-architecture.md`
- `docs/architecture/redesign/02-memory-loop-and-protocols.md`
- `docs/architecture/redesign/03-migration-roadmap-and-execution-envelope.md`
- `docs/architecture/redesign/04-workstream-operational-memory.md`
- `docs/architecture/redesign/05-workstream-context-map.md`
- `docs/architecture/redesign/06-workstream-governance-and-inbox.md`
- `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`
- `docs/architecture/redesign/08-evaluation-and-acceptance.md`

Historical/reference:

- `docs/UPSTREAM_SYNC.md` - provenance for selected imports from gbrain
- `docs/MBRAIN_V0.md` - Historical v0 spec

Managed Postgres storage estimates and schema details are documented in the
engine and verification docs rather than being part of the default local setup.

## For gbrain Users

MBrain began as a fork of [garrytan/gbrain](https://github.com/garrytan/gbrain).
Some early patterns, skills, and deterministic tools were imported or adapted
from upstream, and `docs/UPSTREAM_SYNC.md` records that provenance.

The current project is SQLite-first, local-first, and not intended as a drop-in
replacement for gbrain. SQLite is the recommended engine for a single-user
personal brain. Postgres remains optional for managed scale and remote/cloud
workflows.

## Status

MBrain is usable today as a local SQLite memory layer for one person and one or
more local agents. The default path is intentionally boring: a Markdown repo,
one SQLite database, stdio MCP, deterministic tests, and optional local
embeddings.

The managed Postgres path remains available for scale and remote deployment, but
it is no longer the center of the product.

The project is MIT licensed.
