# GBrain

**Your AI agent is smart but forgetful. GBrain gives it a brain.**

Built by the President and CEO of Y Combinator to run his own AI agents. The
production brain powering Garry's OpenClaw and Hermes deployments has grown
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
| **273** | skills (35 from gbrain bundle + 238 user-built in the live agent fork) |

The agent ingests meetings, emails, tweets, voice calls, books, papers, and
original ideas while you sleep. It enriches every person and company it
encounters. It fixes its own citations, consolidates memory overnight,
detects contradictions in your typed claims about people and companies, and
flags trajectory regressions. You wake up and the brain is smarter than when
you went to bed.

GBrain is those patterns, generalized. **Install in 30 minutes. Your agent
does the work.** As Garry's personal agent gets smarter, so does yours.

> Database ready in 2 seconds (PGLite, no server). Eval-tuned hybrid retrieval
> beats vector-only RAG by **+31.4 points P@5** on the BrainBench corpus.
> Full scorecards in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals)
> repo.

> **LLMs:** fetch [`llms.txt`](llms.txt) for the doc map, or
> [`llms-full.txt`](llms-full.txt) for the map with core docs inlined.
> **Agents:** start with [`AGENTS.md`](AGENTS.md) (or
> [`CLAUDE.md`](CLAUDE.md) for Claude Code).

---

## Install

### On an agent platform (recommended)

GBrain is designed to be installed and operated by an AI agent. If you don't
have one running yet:

- **[OpenClaw](https://openclaw.ai)** — deploy [AlphaClaw on Render](https://render.com/deploy?repo=https://github.com/chrysb/alphaclaw) (one click, 8GB+ RAM)
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — deploy on [Railway](https://github.com/praveen-ks-2001/hermes-agent-template) (one click)

Paste this into your agent:

```
Retrieve and follow the instructions at:
https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md
```

The agent clones the repo, installs GBrain, sets up the brain, loads 35
skills, and configures recurring jobs. You answer a few questions about
API keys. ~30 minutes.

### Standalone CLI (no agent)

```bash
git clone https://github.com/garrytan/gbrain.git && cd gbrain && bun install && bun link
gbrain init                     # local brain, ready in 2 seconds
gbrain import ~/notes/          # index your markdown
gbrain query "what themes show up across my notes?"
```

`gbrain init` picks a search mode (`conservative` / `balanced` / `tokenmax`).
Cost spread depends on mode × downstream model — see [docs/eval/SEARCH_MODE_METHODOLOGY.md](docs/eval/SEARCH_MODE_METHODOLOGY.md)
for the full matrix and `gbrain search modes` for what's active.

### MCP server (Claude Code, Cursor, Windsurf)

```bash
# stdio MCP — local single-user
claude mcp add gbrain "$(which gbrain) serve"

# HTTP MCP — multi-user, OAuth 2.1, admin dashboard
gbrain serve --http                              # prints admin bootstrap token
gbrain serve --http --bind 0.0.0.0 --public-url https://gbrain.example.com
```

The HTTP server supports **OAuth 2.1** (client_credentials, authorization_code
+ PKCE, refresh token rotation, revocation, RFC 7591 DCR behind `--enable-dcr`).
Source-scoped clients with `--source dept-x` tie write authority to one
source; `--federated-read S1,S2,S3` adds orthogonal read scopes. Loopback bind
by default — `--bind 0.0.0.0` to publish to the LAN.

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

Garry Tan needed a brain that could remember every meeting, every founder
encounter, every essay he'd ever drafted, every idea he wanted to chase
later. Off-the-shelf knowledge tools (Roam, Obsidian, Notion) handle
storage. None of them ingest a meeting, enrich the attendees, build the
graph, fix the citations, and surface the connection three weeks later
when it matters. So he built one. The first 12 days produced a working
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
