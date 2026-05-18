# GBrain

**Your AI agent is smart but forgetful. GBrain gives it a brain.**

Ask your agent about a meeting from six weeks ago, a paper you skimmed in
March, an idea you jotted down late one night. GBrain finds it. And it knows
the connections — who attended that meeting, who that paper's author has
invested in, what other ideas in your brain it overlaps with.

On [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval),
the public benchmark for AI memory systems, the right answer lands in
gbrain's top 5 results **97.6% of the time**. Better than every comparable
system that doesn't pay for a language-model call on every retrieval, at
$0.50 per thousand queries.

For relational questions ("who works at this company?", "what did this
founder invest in this quarter?"), gbrain's self-wiring knowledge graph
makes the answer roughly **4× more relevant** than plain vector RAG. The
graph isn't hand-curated. Every page write extracts entity references and
creates typed edges (`works_at`, `attended`, `invested_in`, `founded`,
`advises`) with zero language-model calls.

[Receipts on the evals →](#receipts-on-the-evals)

I'm the President and CEO of Y Combinator, and I use this 16 hours a day.
The production brain powering my OpenClaw and Hermes deployments has grown
into the largest documented personal-AI knowledge graph in active use:

| | |
|---|---|
| **~100K** | total items in the brain |
| **~16,000** | people pages, auto-enriched |
| **~5,000** | companies |
| **~8,000** | concepts |
| **~4,000** | original essays + ideas + drafts |
| **~3,500** | daily notes |
| **~31,000** | media items (tweets, books, papers, interviews, films, articles, calls) |
| **~2,200** | LLM-conversation transcripts (ChatGPT, Claude, Perplexity, agent forks) |
| **108** | cron jobs running autonomously |
| **273** | skills in the live agent fork (35 from gbrain bundle + 238 user-built on top) |

The agent ingests meetings, emails, tweets, voice calls, books, papers, and
original ideas while you sleep. It enriches every person and company it
encounters. It fixes its own citations, consolidates memory overnight,
detects contradictions in your typed claims about people and companies, and
flags trajectory regressions. You wake up and the brain is smarter than when
you went to bed.

GBrain is those patterns, generalized. As my personal agent gets smarter,
so does yours.

### What it is, technically

- **Open-source** (MIT) TypeScript CLI + MCP server. One binary, no service
  to host. Mac and Linux. Requires [Bun](https://bun.sh) 1.3+.
- **Local-first.** Your brain lives in `~/.gbrain` on your machine. Embedded
  Postgres (PGLite via WASM) so there's no database to install — ready in
  ~2 seconds. Or point at your own Postgres / Supabase for big brains.
- **Your data stays on disk.** Embedding calls hit OpenAI / Voyage / Anthropic
  only if you configure those keys. Sync, search, and graph extraction all
  run locally with zero outbound traffic.
- **Speaks MCP.** Plugs into Claude Code, Cursor, Windsurf, ChatGPT desktop,
  and any agent that consumes the Model Context Protocol — stdio for local,
  HTTP + OAuth 2.1 for multi-user.

> **LLMs:** fetch [`llms.txt`](llms.txt) for the doc map, or
> [`llms-full.txt`](llms-full.txt) for the map with core docs inlined.
> **Agents:** start with [`AGENTS.md`](AGENTS.md) (or
> [`CLAUDE.md`](CLAUDE.md) for Claude Code).

---

## Install

Three paths, ordered by how much you're committing.

### Path 1 — 60 seconds, just try it (standalone CLI)

```bash
git clone https://github.com/garrytan/gbrain.git
cd gbrain && bun install && bun link
gbrain init                     # brain ready in ~2 seconds (PGLite)
gbrain import ~/notes/          # index any directory of markdown
gbrain query "what themes show up across my notes?"
```

What you'll see — gbrain finds the relevant pages, ranks them by hybrid
search, and prints the top hits with snippets:

```
$ gbrain query "what themes show up across my notes?"
Found 8 results in 124ms (hybrid: vector + keyword + RRF)

1. concepts/durable-systems.md           (score 0.91)
   "Software that survives its maintainers has three properties: ..."
2. essays/2025-thinking-out-loud.md      (score 0.87)
   "I keep coming back to the idea that the best companies ..."
3. meetings/2026-02-12-alice-call.md     (score 0.83)
   "Discussed how Alice's framework for ..."
...
```

Add `gbrain extract all` after import to build the knowledge graph
(entity links + timeline edges). `gbrain dream` runs the full 9-phase
maintenance cycle.

### Path 2 — Plug it into Claude Code / Cursor (MCP)

```bash
# Local single-user via stdio MCP
claude mcp add gbrain "$(which gbrain) serve"

# Multi-user via HTTP MCP with OAuth 2.1 + admin dashboard
gbrain serve --http                              # prints admin bootstrap token
gbrain serve --http --bind 0.0.0.0 --public-url https://brain.example.com
```

Now ask Claude / Cursor "what did Alice and I discuss last quarter?"
and it queries your brain. The HTTP server supports OAuth 2.1
(`client_credentials`, `authorization_code` with PKCE, refresh rotation,
revocation, RFC 7591 DCR). Source-scoped clients (`--source dept-x`) tie
write authority to one source; `--federated-read S1,S2,S3` adds orthogonal
read scopes. Loopback bind by default — pass `--bind 0.0.0.0` to publish.

### Path 3 — Full agentic install (~30 min)

If you want the nightly auto-enrichment, cron jobs, and overnight
synthesis I described above, the brain needs an agent to drive it.

- **[OpenClaw](https://openclaw.ai)** — deploy [AlphaClaw on Render](https://render.com/deploy?repo=https://github.com/chrysb/alphaclaw) (one click, 8GB+ RAM)
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — deploy on [Railway](https://github.com/praveen-ks-2001/hermes-agent-template) (one click)

Then paste this into your agent:

```
Retrieve and follow the instructions at:
https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md
```

It clones the repo, installs GBrain, sets up the brain, scaffolds 35
skills, configures recurring jobs, and asks you for the API keys it
needs. Budget ~30 minutes for the conversation.

---

## Receipts on the evals

The lead's numbers come from published, reproducible eval runs. Sibling
repo [gbrain-evals](https://github.com/garrytan/gbrain-evals) has the full
reports, corpora, and cross-system tables. Glossary so the metric jargon
below doesn't get in the way:

- **R@5** — did the right answer land in gbrain's top 5? Higher is better.
- **P@5** — what fraction of the top 5 are actually correct? Higher is better.
- **No LLM in the loop** — retrieval uses embeddings + keyword search +
  ranking, with no language model called per query. Cheaper, deterministic,
  reproducible.

### LongMemEval — the standard public memory benchmark

500 questions across 6 question types, each against a haystack of ~50
conversation sessions. Built by [Wu et al.](https://huggingface.co/datasets/xiaowu0162/longmemeval),
the published yardstick for memory systems.

| System | R@5 | LLM in retrieval? | Notes |
|---|---|---|---|
| **gbrain-hybrid** | **97.60%** | no | this run, 2026-05-07 |
| MemPalace hybrid+rerank (held-out) | 98.4% | yes | 0.8pt ahead because they pay for an LLM call per query |
| MemPalace raw | 96.6% | no | gbrain wins this head-to-head by 1pt |
| Hindsight | 91.4% | yes | per their release |
| Stella (academic) | ~85% | no | dense retriever |
| Contriever (academic) | ~78% | no | dense retriever |
| BM25 (sparse) | ~70% | no | keyword baseline |

Mastra (94.87%) and Supermemory (~99%) publish on this dataset but measure
end-to-end QA accuracy with an LLM judge, which is a different thing than
"did retrieval find the right session." Not directly comparable; flagged
honestly in the [cross-system table](https://github.com/garrytan/gbrain-evals/blob/master/docs/comparison-systems.md).
Reports + reproduction:
[2026-05-07 LongMemEval](https://github.com/garrytan/gbrain-evals/blob/master/docs/benchmarks/2026-05-07-longmemeval-s.md).

### BrainBench — relational queries (in-house corpus)

LongMemEval is conversation-style. The other half of the proof is relational
questions over a structured knowledge base. We built a 240-page rich-prose
corpus (80 people, 80 companies, 50 meetings, 30 concepts) and wrote 145
relational gold queries — "who attended this meeting?", "what's this person
invested in?" — against it. Reproducible, deterministic.

| Retrieval system | P@5 | Δ vs gbrain |
|---|---|---|
| **gbrain** (hybrid + knowledge graph) | **49.1%** | — |
| Vector + keyword RRF (graph turned off) | 17.8% | −31.4 |
| Keyword search only (BM25) | 17.1% | −32.0 |
| Vector-only RAG | 10.8% | −38.4 |

The knowledge graph layer is worth **31 points P@5** on these queries.
Separable, measured, load-bearing. Flat across seven releases (v0.16 → v0.20)
— zero retrieval regression while ops + infra changed underneath.
[Full report.](https://github.com/garrytan/gbrain-evals/blob/master/docs/benchmarks/2026-04-23-brainbench-v0.20.0.md)

### Curated content vs bulk swamp

Personal brains accumulate bulk content (tweet dumps, daily chat
transcripts, archived articles). When a query phrase appears in both a
short curated essay AND a long chat dump, which wins? Source-aware ranking
keeps the essay on top. **93.3% top-1 hit** (vs 80% on grep-only). [Report.](https://github.com/garrytan/gbrain-evals/blob/master/docs/benchmarks/2026-04-25-brainbench-cat13b-source-swamp.md)

### Prompt compression

Routing rule: the `functional-area-resolver` skill compresses a fat
`AGENTS.md` into a two-layer dispatch table. A real-world 25KB resolver
compressed to **13KB (48% the size) and gained 13–17 percentage points of
routing accuracy** across Opus 4.7, Sonnet 4.6, and Haiku 4.5. The
`(dispatcher for: ...)` clause is load-bearing — strip it (same
compression, no dispatcher signal) and Sonnet's accuracy collapses to
41.7%. [Cross-model receipts in this repo.](evals/functional-area-resolver/)

### Run your own evals

```bash
# Public benchmark, in-process, ~30s warm
gbrain eval longmemeval ~/Downloads/longmemeval_s.jsonl

# Multi-model output quality gate (3 frontier models score the same output)
gbrain eval cross-modal --task "..." --output report.md

# Capture real query/search traffic as regression-eval data
GBRAIN_CONTRIBUTOR_MODE=1 gbrain eval export > snapshot.ndjson
gbrain eval replay --against snapshot.ndjson

# In-house BrainBench corpus + multi-adapter runner
cd ~/git/gbrain-evals && bun eval/runner/multi-adapter.ts
```

Full BrainBench corpus + per-category scorecards (Cats 1–13) in the sibling
[gbrain-evals](https://github.com/garrytan/gbrain-evals) repo.

---

## What it does

### 1. Ingests everything, enriches automatically

Markdown sync from a git brain. Meeting transcripts (Whisper / Groq Whisper).
EPUB / PDF books (`book-mirror` produces personalized chapter-by-chapter
analysis). PDFs of academic papers with citation extraction. Articles via
Reader / Perplexity / archive.is. Tweets (timeline + bookmarks). Voice notes.
ChatGPT / Claude / Perplexity / agent-fork conversation exports. Email
threads. Calendar events. Foursquare exports. Slack channel archives.

Every page write extracts entity references → typed links (`attended`,
`works_at`, `invested_in`, `founded`, `advises`, `mentions`) with zero LLM
calls. The graph wires itself.

### 2. Hybrid search that beats vector-only RAG

Per-query: vector + keyword + RRF fusion + multi-query expansion (Haiku) +
source-aware ranking + reranking (ZeroEntropy, optional). Two-stage CTE so
the HNSW index stays usable when source-boost re-ranks the top-K. Hard
exclude prefixes (`test/`, `archive/`, etc.) at retrieval. Intent classifier
auto-selects detail level by query type (entity / temporal / event /
general). **P@5 49.1%, R@5 97.9%** on the BrainBench corpus.

### 3. Self-maintaining via the dream cycle

A 9-phase nightly cycle: `lint → backlinks → sync → synthesize → extract →
patterns → recompute_emotional_weight → embed → orphans` (+ a `purge` phase
for the destructive-guard lifecycle). Each phase is independently runnable
via `gbrain dream --phase <name>`. Subagents fan out under a rate-leased
Anthropic client; protected job names gate trust; per-job + per-cycle
timeouts; auto-replay on stalled jobs. Conversation transcripts become brain
pages with content-hash dedup so re-runs are no-ops.

### 4. Multi-source brains + temporal trajectory

`gbrain sources add <id> --local-path <path>` mounts additional brains
alongside your `host` brain (team-published, CEO-class, departmental). Each
source has its own RLS-isolated DB rows. OAuth clients can write to one
source and read federated.

Author typed claims in the `## Facts` fence: `mrr=50000`, `arr=2000000`,
`team_size=12`, `valuation_usd=15000000`. `gbrain eval trajectory
companies/<slug>` prints the chronological history with regressions
auto-flagged. `gbrain founder scorecard <entity>` rolls up claim accuracy,
consistency, growth direction, and red flags into a stable JSON contract.

### 5. Durable background work

`gbrain agent run <prompt>` submits LLM-loop subagents. `gbrain jobs submit
shell --params '{"cmd":"..."}'` (operator-only) submits shell jobs.
`gbrain jobs supervisor start` runs a self-restarting worker daemon with
crash-cause classification, OOM detection, RSS watchdog, and per-cause
metrics surfaced in `gbrain doctor`. `gbrain autopilot --install` registers
the dream cycle as a launchd / systemd job.

Children + aggregator parents, `child_done` inbox for fan-in, per-job
timeouts, idempotency keys, cascade-kill. Supervisor classifies exit codes
into `runtime_error / oom_or_external_kill / graceful_shutdown / clean_exit`
so `120 crashes/24h` reads correctly instead of false-alarming on clean
worker drains.

---

## Multi-player and company brains

Three ways to share a brain across multiple agents, machines, or teammates.
Most setups want pattern 1 (single server, multiple MCP clients). The other
two patterns exist for specific reasons.

### Pattern 1 — One GBrain server, many MCP clients (recommended)

The GBrain server runs on the same machine or container as your primary
agent (OpenClaw, Hermes, AlphaClaw). It publishes an MCP endpoint over
HTTP with OAuth 2.1. Other agents — on other machines, in other apps,
across teammates' laptops — connect as thin MCP clients.

```bash
# On the box that hosts your brain + primary agent:
gbrain serve --http --bind 0.0.0.0 --public-url https://brain.example.com
# Prints a one-time admin bootstrap token; paste it into the admin UI
# at /admin to register OAuth clients.

# On any other machine, set up a thin client:
gbrain init --mcp-only
# Walks you through pointing at the server URL + OAuth credentials.
# No local database, no scaffolded skills — just a routing shim.
```

**Network: use Tailscale.** Run the server on a Tailscale-private address
so the brain is reachable from your other machines without exposing
anything to the public internet. Public-internet exposure works fine
(OAuth + loopback-bind-by-default + admin dashboard handle it), it's just
a larger blast radius. For teams, Tailscale + OAuth is the cheap path to
"my engineering team's agents all read from one shared brain."

**What thin clients CAN do** (subject to OAuth scope: `read` / `write` / `admin`):

- `search`, `query`, `think` — full retrieval pipeline, including the
  knowledge graph + reranking
- `get_page`, `list_pages`, `put_page`, `delete_page`, `restore_page` —
  page CRUD (`put_page`/`delete_page` require `write` scope)
- `find_experts` (whoknows), `find_trajectory`, `find_orphans`,
  `find_anomalies`, `find_contradictions` — the analytical surfaces
- `get_recent_salience`, `get_brain_identity` — observability
- `apply-migrations`, `restore_page` — admin scope, OAuth-gated
- Anything else marked `localOnly: false` in `src/core/operations.ts`

**What thin clients CANNOT do** (server-side only, by design):

- `sync_brain` — needs filesystem access to the git brain repo
- `file_upload`, `file_list`, `file_url` — server-side S3 / Supabase
  Storage credentials don't cross the trust boundary
- `get_recent_transcripts` — raw `.txt` transcripts; privacy gate keeps
  these local
- `purge_deleted_pages` — destructive, admin-only, local-only
- `code_traversal_cache_clear` — local maintenance

If a thin client tries one of these, the server returns a clear
"local-only" error pointing at the local CLI.

**Source-scoped clients (v0.34+).** A teammate's OAuth client can be tied
to a single source with `--source dept-x`; its writes are isolated to
that source's RLS-protected rows. `--federated-read S1,S2,S3` adds
orthogonal read scopes so the client can read across departments while
writing to one canon. Useful when a team has a shared brain AND
contributes back to a CEO-class brain.

### Pattern 2 — Local PGLite for code search (GStack)

For an engineering agent that wants symbol-aware code search on the
repo it's currently working in, run a local PGLite instance instead of
hitting a central GBrain server. [GStack](https://github.com/garrytan/gstack)
supports this directly: one PGLite per worktree, indexed against that
worktree's source tree.

```bash
# In the worktree you want to index:
gbrain init --pglite              # ~2 seconds, no server, no creds
gbrain import .                    # indexes the worktree's code
echo "$(pwd)" > .gbrain-source     # pins this PGLite to this worktree
```

`/sync-gbrain` (a GStack skill) keeps the PGLite current as you work.
Code-aware queries (`gbrain code-def`, `gbrain code-refs`,
`gbrain code-callers`) walk tree-sitter call-graph edges across 29
languages. Symbol-aware retrieval works better than `grep` for "where
is X defined" / "what calls Y" queries.

Don't use this pattern for shared knowledge. PGLite is single-process,
worktree-scoped, no concurrent writers. The right tool for "my agent
needs the brain my team uses" is pattern 1.

### Pattern 3 — Federated repos (advanced)

Multiple GBrain servers, each indexing the same brain repo from its
own git clone. Each server has its own DB; they sync to the same
markdown source of truth via `gbrain sync`.

Use this when:
- You want a personal brain AND a team brain that share some content
  (the team's knowledge wiki) but diverge on private notes.
- You're crossing a hard trust boundary (your personal brain is
  read-write to you; the team brain is read-only to most teammates,
  write-gated to a few).
- The shared content is genuinely repo-shaped (markdown files in git),
  not "we both query each other's brains via MCP."

The mechanics: clone the same brain repo on each server, run
`gbrain init` against each, configure both to sync from the same git
remote. Pages land in both databases; the knowledge graph wires
independently on each side from the same source markdown.

**Most teams should NOT pick this.** The MCP-client path (pattern 1)
gives you one source of truth, one set of skills, one knowledge graph,
and OAuth-gated multi-user access. Federated repos make sense when the
shared content is the source of truth (a published team wiki) and the
agents are operating against their own private overlays.

My personal setup runs both: a personal brain on my laptop and a team
brain on a separate box, indexing two different git repos. The team
brain is what teammates' thin MCP clients connect to; the personal
brain stays local.

---

## Skills

35 curated skills ship in the bundle. The agent installs them via
`gbrain skillpack scaffold <name>` (one-time additive copy — you own the
files after). See [docs/guides/skillpacks-as-scaffolding.md](docs/guides/skillpacks-as-scaffolding.md)
for the model.

### Always-on
| Skill | What it does |
|---|---|
| `signal-detector` | Catches ideas, entities, and TODOs on every message — the always-on capture surface. |
| `brain-ops` | Brain-first lookup before web search. Enforces the read-enrich-write loop. |
| `repo-architecture` | File-placement decisions follow the primary subject, not the format. |

### Content ingestion
| Skill | What it does |
|---|---|
| `idea-ingest` | Links / articles / tweets. Mandatory people page for the author. |
| `media-ingest` | Video / audio / PDF / book with entity extraction. |
| `meeting-ingestion` | Transcripts → attendee enrichment chaining. |
| `voice-note-ingest` | Whisper → brain page with entity refs. |
| `book-mirror` | EPUB / PDF → personalized chapter-by-chapter two-column analysis. |
| `book-mirror-extreme` | Synthesis pass: lift the book's principles into your own framework. |
| `brain-pdf` | Render any brain page as a publication-quality PDF. |

### Research + synthesis
| Skill | What it does |
|---|---|
| `perplexity-research` | Bounded Perplexity calls with brain-side dedup. |
| `academic-verify` | Citation verification + DOI resolution + claim cross-check. |
| `strategic-reading` | Reading-list curation tuned to active concept clusters. |
| `archive-crawler` | Crawl + extract from `archive.is` / archive-org bookmarks. |
| `article-enrichment` | Article → people / companies / concepts links. |
| `concept-synthesis` | Cross-source synthesis: 3+ pages on one concept → unified writeup. |
| `data-research` | Email-to-tracker pipeline with parameterized YAML recipes. |

### Brain operations
| Skill | What it does |
|---|---|
| `query` | The default query path. Walks intent classifier + hybrid search. |
| `enrich` | Tier-escalating enrichment for people / companies / deals. |
| `maintain` | Background brain hygiene: backlinks, citations, orphans. |
| `citation-fixer` | Audit and fix citation format issues across the brain. |
| `frontmatter-guard` | Validate every page's frontmatter against the contract. |

### Operational
| Skill | What it does |
|---|---|
| `daily-task-manager` | Task lifecycle with priority levels (P0–P4). |
| `daily-task-prep` | Morning prep with calendar context + agenda generation. |
| `cron-scheduler` | Schedule staggering, quiet hours, idempotency keys. |
| `reports` | Timestamped reports with keyword routing. |
| `cross-modal-review` | Quality gate via second model. |
| `webhook-transforms` | External events → brain signals. |
| `minion-orchestrator` | Background work: shell jobs + LLM subagents. |

### Identity + meta
| Skill | What it does |
|---|---|
| `soul-audit` | 6-phase interview → SOUL.md / USER.md / ACCESS_POLICY.md / HEARTBEAT.md. |
| `testing` | Skill validation framework. |
| `skillify` | The meta-skill: turn any feature into a properly-skilled, tested unit. |
| `skill-creator` | Create conforming skills with MECE check. |
| `skillpack-check` | Agent-readable bundle health report. |
| `skillpack-harvest` | Lift a proven skill from your fork back into gbrain (privacy-linted). |
| `functional-area-resolver` | Two-layer dispatch for compressing AGENTS.md / RESOLVER.md. |

### Conventions (shared deps, installed alongside every skill)
- `_AGENT_README.md` — agent operating contract: how to discover skills via frontmatter
- `_brain-filing-rules.md` — file-placement rules (primary subject wins)
- `_output-rules.md` — output quality standards (no LLM slop)
- `_friction-protocol.md` — log user friction to `~/.gstack/friction/`
- `conventions/` — cross-cutting rules (quality, brain-first, model-routing, test-before-bulk, cross-modal)

---

## How it works

### Architecture

Contract-first: `src/core/operations.ts` defines ~47 shared operations. CLI
and MCP server are both generated from that one source. Engine factory
dynamically imports the configured engine (`pglite` for zero-config local,
`postgres` for Supabase / self-hosted).

**Trust boundary:** `OperationContext.remote` distinguishes trusted local
CLI (`remote: false`) from untrusted agent-facing callers (`remote: true`).
Security-sensitive operations tighten when `remote: true` is set.

### Knowledge model

Every brain page is markdown with YAML frontmatter:
- **Frontmatter:** `name`, `type` (person / company / deal / concept / ...),
  `tags`, optional `sources:`, `triggers:` (for skills), `## Facts` fenced
  block with typed claims (`mrr=50000`, `arr=2000000`).
- **Compiled truth:** stable section the agent updates with consensus
  knowledge.
- **Timeline:** append-only event log, sentinel-separated (`<!-- timeline -->`).

Pages are chunked by recursive markdown structure (default) or LLM-guided
(opt-in). 29 programming languages get tree-sitter semantic chunking with
embedded WASM grammars and tiktoken token budgeting.

### Knowledge graph

Every page write fires `extract.ts`:
- Matches `[Name](people/slug)` markdown links AND `[[people/slug|Name]]`
  Obsidian wikilinks.
- Heuristics infer link type: `attended`, `works_at`, `invested_in`,
  `founded`, `advises`, `source`, `mentions`.
- Bulk-insert via `unnest()` arrays — 4-5 params regardless of batch size,
  sidesteps the 65535-param cap.

Query: `gbrain graph-query alice --depth 2 --direction in` returns who
attended what with Alice, transitively.

### Search

Per-query pipeline:
1. Query intent classifier (entity / temporal / event / general) selects
   detail level.
2. Multi-query expansion via Haiku (deterministic, off by default in
   `conservative` mode).
3. Hybrid: keyword (`ts_rank` × source-factor) + vector (HNSW + source-boost
   re-rank) + RRF fusion.
4. Optional reranker (ZeroEntropy `zerank-2` flagship or `zerank-1`).
5. Source-aware ranking: curated content (`originals/`, `concepts/`,
   `writing/`) outranks bulk content (chat transcripts, `daily/`,
   `media/x/`). Hard-exclude `test/`, `archive/`, `attachments/` by default.
6. Dedup + token budget enforcement per mode.

### Engines

- **PGLite** — embedded Postgres 17.5 via WASM. Zero-config default. Single-
  file backup. Forward-reference bootstrap walks schema migrations cleanly
  across the v0.13–v0.35 wave.
- **Postgres + pgvector** — Supabase / self-hosted. `pg_trgm` + HNSW indexes.
  Migrations include 60+ schema bumps with `sqlFor.postgres` / `sqlFor.pglite`
  branches for engine-specific DDL.

`gbrain migrate --to supabase` / `--to pglite` does the round-trip.

### Storage tiering

For brains crossing 100K files where bulk machine-generated content
dominates the size: declare which directories are `db_tracked` (committed)
vs `db_only` (DB-only, gitignored). `gbrain sync` manages `.gitignore`
automatically; `gbrain export --restore-only` repopulates missing DB-only
files from the database.

See [docs/guides/storage-tiering.md](docs/guides/storage-tiering.md) for the
config shape and per-tier defaults.

---

## Commands

```
SETUP
  gbrain init [--pglite | --supabase]   Set up a brain. Picks search mode.
  gbrain migrate --to {supabase,pglite} Round-trip between engines.
  gbrain doctor [--fast] [--fix]        Health check + auto-repair.

CONTENT
  gbrain sync [--workers N]             Pull from the git brain.
  gbrain import <path>                  Index any directory of markdown.
  gbrain embed [--stale]                Compute / refresh embeddings.
  gbrain extract {links,timeline,all}   Build the knowledge graph.

SEARCH + QUERY
  gbrain query "<question>"             Hybrid search + RRF + reranking.
  gbrain search "<text>"                Lower-level: vector | keyword | hybrid.
  gbrain whoknows <topic>               Expertise routing across the graph.
  gbrain graph-query <slug>             Typed-edge traversal.
  gbrain orphans                        Pages with zero inbound links.
  gbrain salience [--days N]            Pages ranked by emotional + activity.
  gbrain anomalies [--lookback-days N]  Cohort-level outlier detection.

AGENTS + JOBS
  gbrain agent run "<prompt>"           Submit a subagent run.
  gbrain agent logs <id>                Tail the run's heartbeat + transcript.
  gbrain jobs submit shell --params ... Submit a shell job (operator-only).
  gbrain jobs supervisor start          Self-restarting worker daemon.

CYCLE + AUTOPILOT
  gbrain dream [--phase NAME]           Run the 9-phase brain cycle.
  gbrain autopilot --install            Register cycle as launchd / systemd job.

SKILLPACK
  gbrain skillpack list                 What's in the bundle.
  gbrain skillpack scaffold <name>      Copy a skill into your agent repo.
  gbrain skillpack reference <name>     Diff vs bundle. Or --all --since <ver>.
  gbrain skillpack migrate-fence        One-shot upgrade from pre-v0.36 model.
  gbrain skillpack harvest <slug> --from <host>
                                        Lift a proven fork skill into gbrain.

SERVE
  gbrain serve                          Stdio MCP (single-user, Claude Code).
  gbrain serve --http [--bind HOST]     HTTP MCP + OAuth 2.1 + admin dashboard.

EVAL + TRAJECTORY
  gbrain eval longmemeval <dataset>     LongMemEval benchmark, in-memory PGLite.
  gbrain eval cross-modal --task "..."  3 frontier models score the same output.
  gbrain eval whoknows <fixture>        Two-layer gate for whoknows accuracy.
  gbrain eval suspected-contradictions  Cached contradiction probe.
  gbrain eval trajectory <entity>       Typed-claim history + regression flags.
  gbrain founder scorecard <entity>     Claim accuracy / consistency / growth.

INTEGRATIONS + SOURCES
  gbrain integrations list              Recipe catalog (Reader, Perplexity, etc).
  gbrain sources {list,add,remove,...}  Multi-source brain management.
  gbrain auth register-client <name>    Mint an OAuth client for the HTTP MCP.
```

Run `gbrain <command> --help` for per-command options.

---

## Docs

- **Architecture:** [`docs/architecture/`](docs/architecture/)
- **Skills as scaffolding (v0.36):** [`docs/guides/skillpacks-as-scaffolding.md`](docs/guides/skillpacks-as-scaffolding.md)
- **Search modes + cost matrix:** [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md)
- **Storage tiering:** [`docs/guides/storage-tiering.md`](docs/guides/storage-tiering.md)
- **Embedding providers (14 recipes):** [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md)
- **Eval capture (BrainBench-Real):** [`docs/eval-bench.md`](docs/eval-bench.md)
- **MCP per-client setup:** [`docs/mcp/`](docs/mcp/)
- **Two-repo pattern (agent vs brain):** [`docs/guides/repo-architecture.md`](docs/guides/repo-architecture.md)
- **Skill development cycle:** [`docs/guides/skill-development.md`](docs/guides/skill-development.md)
- **Per-agent install guide:** [`AGENTS.md`](AGENTS.md), [`CLAUDE.md`](CLAUDE.md), [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md)
- **Full changelog:** [`CHANGELOG.md`](CHANGELOG.md)

---

## Origin story

I needed a brain that could remember every meeting, every founder
encounter, every essay I'd ever drafted, every idea I wanted to chase
later. Off-the-shelf knowledge tools (Roam, Obsidian, Notion) handle
storage. None of them ingest a meeting, enrich the attendees, build the
graph, fix the citations, and surface the connection three weeks later
when it matters. So I built one. The first 12 days produced a working
brain. The next 12 months produced 100,000 pages, a self-wiring knowledge
graph, 108 cron jobs, and the multi-engine architecture that ships here.

GBrain is the generalized version of that work. You scaffold the skills.
You bring your data. Your agent runs the patterns. The brain compounds
nightly.

---

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev loop,
test taxonomy, and how to ship. Privacy rules in [`CLAUDE.md`](CLAUDE.md)
are non-negotiable — no real names, fork names, or private references in
public artifacts. The harvest CLI's privacy linter exists to catch
accidental leaks before they merge.

## License

MIT.
