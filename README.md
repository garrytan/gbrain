# MBrain

MBrain is a Postgres + pgvector personal memory runtime for one person and their
local AI agents. Your Markdown stays readable while Postgres gives agents a
durable, concurrent, auditable memory substrate through CLI or MCP.

The default path is simple:

```bash
bun add -g github:meghendra6/mbrain
# Requires a running local Postgres server with a database named mbrain.
createdb mbrain 2>/dev/null || true
mbrain init --profile homebrew-postgres
# Import any directory of Markdown files.
mbrain import ~/git/brain
mbrain query "what do we know about product strategy?"
mbrain serve
```

That connects to `postgresql://$USER@localhost:5432/mbrain`, creates the schema,
and enables `vector` when the server allows it. The profile does not start
Postgres or create the database for you. You can also pass any explicit
connection string with `mbrain init --url <conn>`. `mbrain serve` is the
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

## Quick Start: Postgres Runtime

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

#### Local source checkout install

If you are installing from a local source checkout instead of the GitHub package,
build the standalone binary and put it on your user `PATH`:

```bash
bun install
bun run build
mkdir -p "$HOME/.local/bin"
install -m 755 bin/mbrain "$HOME/.local/bin/mbrain"
command -v mbrain
mbrain --version
```

`bun link` runs the checkout's TypeScript source directly, so that workflow
requires dependencies to be installed in the checkout. The standalone binary path
above is the stable local-development install path. If `command -v mbrain` does
not resolve to `$HOME/.local/bin/mbrain`, add `$HOME/.local/bin` to your shell
`PATH` before continuing.

### 3. Create a Postgres brain

The `homebrew-postgres` profile expects a reachable local Postgres server and a
database named `mbrain`. It maps to `postgresql://$USER@localhost:5432/mbrain`;
it does not start Postgres or create the database.

```bash
createdb mbrain 2>/dev/null || true
```

```bash
mbrain init --profile homebrew-postgres
```

This writes `~/.mbrain/config.json` and initializes the Postgres schema. If your
database is not the local profile default, pass a DSN explicitly:

```bash
mbrain init --url postgresql://user:pass@localhost:5432/mbrain --non-interactive
```

Legacy local SQLite mode remains available with `mbrain init --local` when you
intentionally need an offline compatibility profile:

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

### Preview PDFs, Markdown/text files, and source projects

For raw files or project source trees, start with a review-only canonical draft:

```bash
mbrain canonicalize ~/Downloads/acme-report.pdf
mbrain canonicalize ./meeting-notes.md --target-slug projects/acme/docs/meeting-notes
mbrain canonicalize-code ~/src/acme-api
```

These commands compute provenance and render draft Markdown, but do not write
canonical memory. Review the draft first, then route accepted content through
the memory writeback or patch review flow. PDFs are metadata-only in this MVP:
text/OCR is not extracted yet. Use `--json` when an agent or script needs the
full structured preview result.

### 5. Search

```bash
mbrain search "local demo"
mbrain query "what should MBrain remember?"
mbrain stats
mbrain health
```

Keyword search works immediately through Postgres `tsvector`. Semantic search
comes online through pgvector after embeddings are backfilled.

### 6. Embeddings are optional

Postgres init currently starts with `embedding_provider="none"`. Keyword search
works immediately through `tsvector`; semantic/vector search comes online only
after a supported embedding provider is configured and chunks are backfilled.
Do not run `mbrain embed --stale` on the default Postgres profile until the
provider is configured.

When you do backfill, `mbrain embed --all` and `mbrain embed --stale` share one
queue across pages, flush chunks in batches of 100, and cap concurrent provider
calls so semantic backfills avoid many tiny runtime requests.

Local SQLite mode defaults to a local llama.cpp embedding server running
`qwen3-embedding:0.6b` with a CPU-friendly `Q4_K_M` GGUF quant, documented in
`docs/local-offline.md`:

```bash
# terminal 1
scripts/run-qwen3-llamacpp-embedding-cpu.sh

# terminal 2
mbrain embed --stale
```

Runtime resolution order:

1. `MBRAIN_LOCAL_EMBEDDING_URL`
2. `MBRAIN_LLAMA_CPP_HOST` (uses `/v1/embeddings`)
3. `OLLAMA_HOST` (legacy compatibility, uses `/api/embed`)
4. `http://127.0.0.1:8080/v1/embeddings`

For Qwen3 embeddings, MBrain leaves document chunks unchanged and applies the
recommended instruction format to search queries internally.

Qwen3 page chunks use token-aware recursive windows by default:
`chunk_size_tokens=768`, `chunk_overlap_tokens=128`, and
`chunk_strategy=qwen3_token_recursive`. This keeps document inputs instruction-free
as recommended by Qwen while using larger long-context windows than the legacy
300-word chunker. The token estimator is CJK/Hangul-aware so Korean notes do not
collapse into one oversized whitespace chunk.

### 7. Connect an agent

For Codex, Claude Code, or another stdio MCP client, let MBrain register the
local MCP server and install the agent rules:

```bash
mbrain setup-agent --preview
mbrain setup-agent --diff
mbrain setup-agent --apply
mbrain setup-agent --codex --apply
mbrain setup-agent --claude --apply
```

`--preview` and `--diff` are read-only. Use `--apply` for the recommended
explicit mutating setup path, including when filtering to one client with
`--codex` or `--claude`. Bare `mbrain setup-agent` still mutates as a legacy
compatibility alias.

The agent rules matter. The MCP tools give an agent access to the brain; the
rules teach it when to read, when to write, how to cite, and how to avoid
writing the wrong thing into memory.

Then verify the installed command, MCP registration, prompt rules, and Claude
prompt/stop hooks:

```bash
mbrain doctor --agent --explain --json
MBRAIN_SMOKE_COMMAND=mbrain bun run smoke:installed-mcp
```

For daily operator review, generate the exception-first memory report:

```bash
mbrain memory-report
mbrain memory-report --save --report-dir ~/git/brain
mbrain memory-report --json
```

The report leads with Memory Inbox pressure and includes canonical target
proposal review actions, source ingest, failed jobs, safety exceptions, and
connector health. Connector rows classify staleness,
auth/rate-limit/network/schema failures, retry posture, and the next operator
action. Saved reports are written under
`brain/reports/memory-review-report/`; JSON output includes
`saved_report_path` when `--save` writes a report.

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
| Postgres runtime | The target database that stores pages, chunks, links, embeddings, jobs, assertions, projections, and governed memory state. |
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
                    -> promoted -> canonical handoff -> durable memory write
                    -> rejected
                    -> superseded
```

The system keeps the audit trail behind that flow:

- source references for every promotable claim
- candidate status events
- promotion preflight checks
- rejection reasons
- supersession links when newer memory replaces older memory
- canonical handoff records that carry promoted candidates into the owning durable memory domain
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
mbrain task-decision --task-id <id> --summary "Lead with Postgres" --rationale "Postgres is the target runtime"
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

## Agent Session Memory

Agent sessions can be captured as source-backed memory inputs without granting
the capture step canonical authority. Preview first, then capture with an
explicit dry run or apply decision:

```bash
mbrain agent-session preview --file session.json --json
mbrain agent-session capture --file session.json --dry-run --json
mbrain agent-session capture --file session.json --apply --write-mode candidate_only
```

Captured sessions are redacted before compression, summarized into bounded
observations, classified into durable memory signals, and routed through the
same Memory Inbox and personal-memory governance as other writes. The default
`candidate_only` mode keeps inferred or compressed session signals reviewable;
`direct_personal_when_allowed` is only for explicit, source-backed personal
signals that pass preflight.

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

Postgres uses `tsvector` for keyword search and pgvector for semantic recall.
Legacy local engines keep their older search paths only for explicit
compatibility profiles.

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
| PostgresEngine | Target personal memory runtime, pgvector, remote MCP, file/storage workflows | Default target |
| SQLiteEngine | Legacy local/offline compatibility profile | Explicit legacy path |
| PGLiteEngine | Embedded Postgres-like migration testing and escape hatch | Explicit legacy path |

Use Postgres for the target runtime. Use SQLite or PGLite only when you
intentionally need the legacy offline profile or migration test path.

See `docs/ENGINES.md` for the engine contract and capability matrix.

## CLI Overview

Setup and diagnostics:

```bash
mbrain init --profile homebrew-postgres
mbrain setup-agent
mbrain doctor --json
mbrain check-update --json
mbrain migrate --to postgres --url postgresql://user:pass@localhost:5432/mbrain
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
mbrain sync --clear-failure   # dismiss a dead-watcher warning without a DB connection
mbrain embed --stale
```

After `import` or `sync` records the markdown repo path, `put_page` / `mbrain put`
writes the matching `<slug>.md` file first and then refreshes the database index.

For a non-git `brain/` container with multiple git-backed sub-brains, register
each child repo explicitly and sync them as one indexed brain:

```bash
mbrain subbrain add personal ~/brain/personal --prefix personal --default
mbrain subbrain add office ~/brain/office --prefix office
mbrain sync --all-subbrains
mbrain embed --stale
```

Registered sub-brains use prefixed slugs, so `~/brain/personal/people/alice.md`
indexes as `personal/people/alice` and writes back to the `personal` repo.

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

For remote MCP clients, start the built-in Streamable HTTP transport and expose
it through a tunnel or host:

```bash
mbrain serve --http --host 127.0.0.1 --port 8787
ngrok http 8787
```

The HTTP server exposes `/mcp` and `/health`, requires
`Authorization: Bearer <token>` for MCP requests, and uses the same operation
catalog, response guards, and concurrency limits as stdio. Create tokens with
`DATABASE_URL=... bun run src/commands/auth.ts create "<client-name>"` against
the same Postgres brain.

For ChatGPT-style OAuth clients, enable the opt-in OAuth 2.1/DCR routes and set
a one-time owner approval token:

```bash
export MBRAIN_OAUTH_APPROVAL_TOKEN='choose-a-long-random-token'
mbrain serve --http --oauth --public-url https://YOUR-DOMAIN.ngrok.app
```

OAuth clients discover metadata, register a public client, complete PKCE, and
receive a normal MBrain bearer token stored in `access_tokens`. Refresh grants
rotate the client session so the refreshed access token works and the
pre-refresh access token is rejected. DCR client registrations and
authorization codes are persisted in Postgres so setup can survive HTTP server
restarts; SQLite/PGLite local profiles should use bearer-token HTTP MCP instead
of OAuth setup. Authorization codes are consumed with one conditional Postgres
update so concurrent exchanges cannot mint multiple bearer tokens from the same
code. Unapproved DCR registrations are pruned after one hour, and pending
registrations are capped at 128 so public registration cannot grow the setup
tables without bound. When OAuth is enabled, `serve` prepares the database
schema before exposing the HTTP routes so upgraded Postgres installs have the
OAuth runtime tables in place.

HTTP MCP clients receive full tool descriptors with titles, descriptions, and
MCP read/write/destructive annotations so ChatGPT can discover MBrain app
actions after OAuth connects. Stdio clients keep compact descriptors to preserve
frame budget headroom, and `resources/list` returns manifest-backed MBrain
documentation resources for clients that load docs on demand.

To verify the OAuth runtime locally, or to reproduce a ChatGPT-style setup
without using ChatGPT:

```bash
DATABASE_URL='postgresql://...' bun run smoke:http-oauth
```

To verify restart-resilient OAuth setup state:

```bash
DATABASE_URL='postgresql://...' \
MBRAIN_SMOKE_RESTART_OAUTH_STATE=1 \
bun run smoke:http-oauth
```

To verify that OAuth discovery advertises the public HTTPS issuer your tunnel
or host will expose:

```bash
DATABASE_URL='postgresql://...' \
MBRAIN_HTTP_PUBLIC_URL='https://YOUR-DOMAIN.ngrok.app' \
bun run smoke:http-oauth
```

### Agent Readiness Verification

For an installed `mbrain` command, verify the command your agents are expected
to call:

```bash
mbrain doctor --agent --explain --json
MBRAIN_SMOKE_COMMAND=mbrain bun run scripts/smoke-test-installed-mcp.ts
```

`mbrain doctor --agent --explain --json` checks the configured brain plus the
installed command, resolved command path, Codex/Claude MCP registration,
required MCP tools, prompt rule blocks, Claude stop-hook routing, and a
read-only summary of agent memory authority boundaries. The installed MCP smoke
starts the configured command over stdio and verifies tool discovery, page
lifecycle, search, and `route_memory_writeback` dry-run availability. If Codex
or Claude is configured to call a different command, pass the same command to
`--agent-command` and `MBRAIN_SMOKE_COMMAND`. MCP registration checks accept the
resolved executable path form of the same command, but fail registrations that
are disabled or disconnected.

For source-tree verification, run:

```bash
bun run src/cli.ts doctor --agent --explain --json --agent-command "bun run src/cli.ts"
MBRAIN_SMOKE_COMMAND="bun run src/cli.ts" bun run scripts/smoke-test-installed-mcp.ts
```

This source-tree check may warn when installed clients are registered to the
global `mbrain serve` command; use the default
`mbrain doctor --agent --explain --json` to verify the installed command that
Codex and Claude actually call.

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
- route durable writeback through `route_memory_writeback`
- put uncertain claims into the Memory Inbox
- call `put_page` only after canonical write is allowed, passing the router's
  `expected_content_hash` precondition
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

For the current Phase 0-14 implementation status and how package scripts map to
roadmap phases, see the
[Phase Implementation Status](docs/architecture/redesign/03-migration-roadmap-and-execution-envelope.md#phase-implementation-status)
crosswalk.

For target Postgres runtime verification, run:

```bash
bun test test/postgres-runtime-migration-cleanup.test.ts test/postgres-runtime-foundation.test.ts
DATABASE_URL='postgresql://...' bun run smoke:postgres-runtime
bun run test:phase13
bun test
bunx tsc --noEmit --pretty false
```

`smoke:postgres-runtime` is the Phase 14 confidence gate for a disposable
Postgres target: it runs `mbrain init`, imports a Markdown fixture,
checks projection lineage, runs deterministic Phase 13 replay, and finishes with
`mbrain doctor --json` without requiring OpenAI or Anthropic API keys.

For release or installed-command confidence, also run the installed-command
doctor checks plus the MCP binary-compatibility smoke:

```bash
mbrain --version
mbrain doctor --agent --explain --json
MBRAIN_SMOKE_COMMAND=mbrain bun run smoke:installed-mcp
```

`runtime_db_identity` is process evidence from the command being checked; use
the installed-command doctor and actual configured agent profile before claiming
CLI/MCP/autopilot are all pointed at the same runtime database. The installed
MCP smoke starts the command in an isolated temporary local profile; it proves
the binary can serve MCP, not that the configured agent MCP shares the validated
Postgres profile. Phase 13 is deterministic replay plus live-eval budget gating
by default, not evidence that paid live LLM evals ran.

Release-readiness notes should also verify the MBrain project self-brain page.
If the durable project memory is stale, refresh it or say explicitly that the
source-tree release checks did not update that page.

For tag-driven releases, do not treat a pushed tag as published. Watch the
Release workflow through the final `release` job, then verify the GitHub
Release itself:

```bash
gh release view vX.Y.Z --json tagName,assets,url
```

The release must include non-empty `mbrain-darwin-arm64` and
`mbrain-linux-x64` assets before calling the version published.

Legacy local SQLite verification is isolated compatibility coverage. Run it
when changing the explicit legacy profile, not as proof that new Postgres target
runtime behavior is complete:

```bash
bun run test:e2e:sqlite
```

For install validation of an already installed command, use Agent Readiness
Verification above. The smoke step is also available through the package script:

```bash
MBRAIN_SMOKE_COMMAND=mbrain bun run smoke:installed-mcp
```

### Phase 1 Task Resume Benchmark

Run the operational-memory benchmark with:

```bash
bun run scripts/bench/phase1-operational-memory.ts --json
bun run scripts/bench/phase1-operational-memory.ts --json --write-baseline /tmp/mbrain-phase1-baseline.json
bun run scripts/bench/phase1-operational-memory.ts --json --baseline /tmp/mbrain-phase1-baseline.json
```

It reports task-resume latency, attempt and decision history latency, resume
projection correctness, repeated-work suppression, decision reuse, verification
warnings, and retrieval-trace template completeness. The first command is a local
readiness run; without a comparable baseline its JSON output keeps
`phase1_status: "pending_baseline"`. Full Phase 1 acceptance requires a
comparable baseline and `phase1_status: "pass"`. Do not accept Phase 1 if the
benchmark passes only by weakening local/offline behavior, provenance, or scope
boundaries.

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
candidate status event auditing, and agent-session memory loop authority.
Scenario-aware memory request planning has focused unit and operation coverage
alongside the scenario suite.

## Documentation Map

Start here:

- `docs/local-offline.md` - legacy SQLite compatibility guide
- `docs/local-offline.ko.md` - Korean legacy SQLite compatibility guide
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
- `docs/superpowers/specs/2026-06-03-mbrain-agent-session-memory-runtime-design.md` - agent-session memory runtime design
- `docs/superpowers/plans/2026-06-03-mbrain-agent-session-memory-runtime.md` - implementation plan and verification map

Managed Postgres storage estimates and schema details are documented in the
engine and verification docs rather than being part of the default local setup.

## For gbrain Users

MBrain began as a fork of [garrytan/gbrain](https://github.com/garrytan/gbrain).
Some early patterns, skills, and deterministic tools were imported or adapted
from upstream, and `docs/UPSTREAM_SYNC.md` records that provenance.

The current project is a Postgres-target personal memory runtime and is not
intended as a drop-in replacement for gbrain. Legacy local engines remain only
as explicit compatibility and migration paths.

## Status

MBrain is usable today as a Postgres-backed personal memory runtime for one
person and one or more local agents. The default path is intentionally boring:
a Markdown repo, a local or managed Postgres database, stdio MCP, deterministic
tests, and optional embeddings.

The legacy SQLite/PGLite paths remain available for explicit offline or
migration scenarios, but they no longer define the target runtime.

The project is MIT licensed.
