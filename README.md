# GBrain

**Search gives you raw pages. GBrain gives you the answer.** It's the brain layer your AI agent has been missing — the only one that does synthesis, graph traversal, and gap analysis in one box. Run a full autonomous agent on top of it, or just wire it into Claude Code or Codex as a supercharged retrieval layer in one command; either way your coding agent stops being amnesiac about everything that isn't code.

I'm Garry Tan, President and CEO of Y Combinator. I built GBrain to run my own AI agents. It's the production brain behind my OpenClaw and Hermes deployments: **146,646 pages, 24,585 people, 5,339 companies**, 66 cron jobs running autonomously. My agent ingests meetings, emails, tweets, voice calls, and original ideas while I sleep. It enriches every person and company it encounters. It fixes its own citations and consolidates memory overnight. I wake up smarter than when I went to bed — and so will you.

**And now it works as a company brain too.** Each person on the team gets their own slice of the brain, scoped by login. When you query, you only see what you're allowed to see — never another person's notes, never another team's data. We fuzz-tested this across every way you can read the brain (search, list, lookup, multi-source reads) and got zero leaks. Drop GBrain in as your team's shared institutional memory — the [company-brain](https://www.ycombinator.com/rfs#company-brain) shape YC just put on its Request for Startups. If you're building in that space, you might as well build on this. **[Tutorial: set up GBrain as your company brain →](docs/tutorials/company-brain.md)**

Lots of personal-knowledge systems give you keyword matching and grep in a box. GBrain does that, and adds two things nobody else ships together:

- **A synthesis layer that gives you the actual answer.** Synthesized, well-cited prose across people, companies, deals, and ideas. Not "here are 10 chunks that mention your query"; an actual answer with citations and an explicit note on what the brain doesn't know yet. The gap analysis is the part that changes how you use the brain.
- **A self-wiring knowledge graph.** Every page write extracts entity refs and creates typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`) with zero LLM calls. Ask "who works at Acme AI?" or "what did Bob invest in this quarter?" and get answers vector search alone can't reach. Benchmarked: **P@5 49.1%, R@5 97.9%** on a 240-page Opus-generated rich-prose corpus, **+31.4 points P@5** over its graph-disabled variant and over ripgrep-BM25 + vector-only RAG by a similar margin. Full BrainBench scorecards live in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo.

The point of building a 100K-page brain is to use it as a strategic moat. To never lose context. To query what's in your own head without re-reading it. The brain layer is what makes the moat usable. The 24/7 dream cycle is what keeps it sharp. Both run on your hardware, your DB, your keys.

It's easier to ship a daemon that runs 24/7 to ingest, enrich, and consolidate than it is to keep an agent in chat working hard. GBrain is that daemon, generalized. Install in 30 minutes. Your agent does the work. As my personal agent gets smarter, so does yours.

> **~30 minutes to a fully working brain.** Database ready in 2 seconds (PGLite, no server). You just answer questions about API keys.

## Start here

- **Current release.** Read [`VERSION`](VERSION) for the exact version and
  [`CHANGELOG.md`](CHANGELOG.md) for what changed. Upgrade instructions live in
  [`docs/INSTALL.md`](docs/INSTALL.md). Coding agents should follow
  [`INSTALL_FOR_AGENTS.md#upgrade`](INSTALL_FOR_AGENTS.md#upgrade).
- **Install or operate GBrain.** Start with
  [`docs/INSTALL.md`](docs/INSTALL.md). It covers local PGLite, Postgres or
  Supabase, thin clients, MCP, and verification.
- **Install with a coding agent.** Follow
  [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md). Non-Claude agents start with
  [`AGENTS.md`](AGENTS.md). Claude Code starts with [`CLAUDE.md`](CLAUDE.md).
- **Run a shared or production brain.** Choose an
  [operating model](docs/architecture/topologies.md#operating-model-decision-tree)
  and a
  [deployment topology](docs/architecture/topologies.md#deployment-topology-decision-tree),
  then continue with [`docs/mcp/DEPLOY.md`](docs/mcp/DEPLOY.md),
  [`SECURITY.md`](SECURITY.md), and
  [`docs/GBRAIN_VERIFY.md`](docs/GBRAIN_VERIFY.md).
- **Choose a working mode.** Use the
  [mode selection guide](docs/guides/mode-selection.md) after installation. It
  distinguishes direct search, synthesis, background maintenance, retrieval
  reflex, volunteered context, and watch mode.
- **Load the docs into an LLM.** Fetch [`llms.txt`](llms.txt) for the curated
  map or [`llms-full.txt`](llms-full.txt) for the map with core docs inlined.
  The build reads [`scripts/llms-config.ts`](scripts/llms-config.ts). Forks
  should set `LLMS_REPO_BASE` before running `bun run build:llms`.

## What this looks like

Say you have a meeting with Alice tomorrow. You want to walk in remembering what she works on, when you last talked, and what's still open between you. Here's what you'd type, and what you'd get back.

**You ask:**

> "What do I need to know before my meeting with Alice tomorrow?"

**Most personal-knowledge tools give you back a list of pages.** Something like:

```
1. people/alice — Alice runs engineering at Acme...
2. meetings/2026-03-15-alice-q1 — Q1 product review with Alice...
3. meetings/2026-01-08-acme-kickoff — Kickoff meeting with Acme team...
4. customers/acme — Acme is a series-B fintech we work with...
5. notes/2026-04-22 — Quick chat with Alice about pricing...
```

Five pages you now have to open and read yourself to actually prepare. The tool found the right material, but it didn't do the work.

**GBrain gives you back the answer, with sources:**

```
Alice runs engineering at Acme (a series-B fintech). You last spoke
on April 22 in a quick pricing chat. Three things are still open
from that conversation:

1. She owes you the security review for the new tier
   (deadline was May 1; no update since).
2. You committed to pricing for a 500-seat tier
   (you sent it April 25; no response yet).
3. She mentioned they're hiring a CISO; you said you'd intro
   someone from your network.

Heads up: nothing's been added to the brain about Alice or Acme
since April 22, six weeks ago. She may have replied through email
or Slack DM, channels the brain doesn't see. Worth asking her to
catch up before assuming any of this is still current.
```

Every claim has a source page behind it. The "heads up" at the end tells you what the brain doesn't know yet, so you can ask Alice about it directly instead of being surprised. The brain just did your meeting prep.

This is the difference between a search engine and a brain. Search finds the pages. The brain reads them for you and writes the answer.

## Install

Choose one complete installation guide:

- **Installing it yourself:** follow [`docs/INSTALL.md`](docs/INSTALL.md). It
  starts with plain-language choices for a personal, multi-source, remote, or
  shared brain and takes that route through verification. For the simplest
  local test, start with Route A.
- **Asking a coding agent to install it:** give the agent
  [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md). It uses the same routes but
  stops for your approval before cost, credentials, network exposure, and
  recurring jobs.

Paste this into an agent that can read HTTPS and run shell commands:

```text
Retrieve and follow the instructions at:
https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md
```

Do not combine snippets from several setup pages. The human and agent guides
route to the relevant MCP, provider, topology, security, and verification detail
at the point where each choice is needed.

## Two ways to query your brain

Raw retrieval (what most personal-knowledge tools ship) and a synthesis layer that gives you an actual answer. They serve different jobs.

```bash
# raw retrieval: top pages by hybrid score, fast, no LLM cost
gbrain search "who's working on AI agents at portfolio companies?"

# brain layer: synthesized answer with citations and gap analysis
gbrain think "who's working on AI agents at portfolio companies?"
```

**`gbrain search`** returns the top retrieved pages, ranked by hybrid scoring (vector + keyword + RRF + source-tier boost + reranker). Use it when you want raw material to skim: agent context windows, citation lookups, finding a specific quote.

**`gbrain think`** runs the same retrieval, then composes a synthesized answer across the results with explicit citations to the source pages AND an honest note on what the brain doesn't know yet. The gap analysis is the differentiator: the answer tells you when a page is stale, when a claim is uncited, when two pages contradict each other, when there's a hole you should fill.

**Why it compounds.** Pair the brain layer with `find_trajectory` and you get answers like *"how have the company's metrics changed AND what does the team look like right now AND what did they promise / share AND when did we last meet AND what's the value-add I can offer here"*: well-scored, well-cited, in one shot. That's the strategic moat. That's why building a 100K-page brain is worth the effort.

`gbrain agent run "..."` exposes the same surface to a sub-agent through the Minions queue, with crash-safe two-phase persistence. Same answers, durable.

## How to get data in

One command, local or hosted, synchronous receipt:

```bash
gbrain capture "the thought I want to remember"
gbrain capture --file ./notes/today.md
echo "from a pipe" | gbrain capture --stdin
SLUG=$(gbrain capture "..." --quiet)
```

The page lands in the database and on disk in one move. Default slug `inbox/YYYY-MM-DD-<hash8>` so captures cluster in a predictable triage location. On thin-client installs the verb routes through MCP to the server: same command, same UX.

For webhook ingestion (Zapier / IFTTT / Apple Shortcuts):

```bash
curl -X POST https://your-brain/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  -d "# a thought from a Shortcut"
```

For mobile capture, the inbox folder source picks up anything dropped into
`~/.gbrain/inbox/` from iOS Shortcuts / AirDrop / Drafts / Finder.

Third-party skillpacks can ship custom ingestion sources (Granola, Linear,
voice, OCR) against the versioned `IngestionSource` contract at
`gbrain/ingestion`. See [`docs/skillpack-anatomy.md`](docs/skillpack-anatomy.md).

## Your brain's shape (schema packs)

Most personal-knowledge tools force one fixed layout: their idea of "notes" + "people" + "tags." Drop a Notion export or your own years-old Obsidian vault on top, and the agent doesn't know what a `Projects/` folder means or whether `Reading/` is people or sources.

**gbrain doesn't have a fixed layout.** It ships with bundled schema packs and lets you author your own when none fit:

- **`gbrain-base-v2`** (default as of v0.41.22) — 15-type DRY/MECE canonical taxonomy (14 canonical + `note` catch-all): `person`, `company`, `media`, `tweet`, `social-digest`, `analysis`, `atom`, `concept`, `source`, `deal`, `email`, `slack`, `writing`, `project`, `note`. Subtypes/format/origin pushed to frontmatter. The taxonomy that responds to issue #1479.
- **`gbrain-base`** (legacy, v0.41 and earlier brains) — the original 24-type layout. Stays bundled for back-compat; brains on it can upgrade via `gbrain onboard --check --explain` → `gbrain jobs submit unify-types --allow-protected --params '{"target_pack":"gbrain-base-v2"}'`.
- **`gbrain-recommended`** — extends `gbrain-base` with the 13 additional directories from `docs/GBRAIN_RECOMMENDED_SCHEMA.md` (source, place, trip, conversation, personal, civic, project, etc.). Activate with `gbrain schema use gbrain-recommended`.
- **Your own pack** — `gbrain schema detect` clusters your actual filesystem into proposed types, `gbrain schema suggest` runs an LLM pass over them, and `gbrain schema review-candidates --apply` promotes the ones you like. Three commands and the brain knows your shape. Authoring a successor pack (declares `migration_from:` so existing brains can opt in): see [`docs/architecture/pack-upgrade-mechanism.md`](docs/architecture/pack-upgrade-mechanism.md).

```bash
gbrain schema active                # which pack is running, which tier set it
gbrain schema list                  # bundled + installed packs
gbrain schema detect                # propose types matching your filesystem
gbrain schema suggest               # LLM-refined proposals on top of detect
gbrain schema review-candidates     # human gate: promote / rename / ignore
gbrain schema use my-pack           # activate
```

The active pack threads through every read + write path: `parseMarkdown` infers page type from the pack's path prefixes; `whoknows` scopes expert routing to types declared `expert_routing: true`; `extract_facts` runs only on `extractable: true` types; the search cache folds the pack name + version into its key so cross-pack contamination is structurally impossible. Switch packs and the brain re-interprets itself; switch back and nothing's lost.

Seven-tier resolution chain (per-call flag → env var → per-source DB key → brain-wide DB key → `gbrain.yml` → `~/.gbrain/config.json` → `gbrain-base` default). Full reference + authoring guide: [`docs/architecture/schema-packs.md`](docs/architecture/schema-packs.md).

## Tutorials

Step-by-step walkthroughs for getting the most out of GBrain. Each one takes you from zero to a working outcome, with concrete commands and real numbers.

- [**Set up your personal AI agent + brain from zero**](docs/tutorials/personal-brain.md) — the canonical full-stack install. Two GitHub repos, a Telegram bot, AlphaClaw on Render, OpenClaw + GBrain + Supabase. End-to-end in about 2 hours.
- [**Set up GBrain as your company brain**](docs/tutorials/company-brain.md) — federated, multi-user, OAuth-scoped institutional memory for a 10-50 person team. About 90 minutes end-to-end.
- [**Auto-improve a skill with `gbrain skillopt`**](docs/tutorials/improving-skills-with-skillopt.md) — treat a `SKILL.md` as a trainable parameter. Generate a starter benchmark straight from the skill with `--bootstrap-from-skill` (or write your own), strengthen the judges, then watch the optimizer propose edits and keep only the ones that measurably score higher. ~20 minutes, ~$1 in API calls. Flag + cost + safety reference: [`docs/guides/skillopt.md`](docs/guides/skillopt.md).

More walkthroughs in progress: connecting an existing agent (Claude Code, Cursor, OpenClaw, Hermes) to a GBrain memory layer; setting up GBrain for VC dealflow with founder scorecards and meeting prep; migrating an existing Notion or Obsidian vault; indexing a codebase as a queryable code brain. Full tutorial index: [`docs/tutorials/`](docs/tutorials/).

Want to see a tutorial that isn't here yet? [Open an issue](https://github.com/garrytan/gbrain/issues) describing the workflow you want documented.

## What it does (the loop)

```
  signal   →   search   →   respond   →   write   →   auto-link   →   sync
  (every    (brain-first  (informed     (page +    (typed edges     (cron
  message)  retrieval)    by context)   timeline)  + backlinks)     keeps fresh)
```

- **Signal detector** runs on every message your agent receives. Captures ideas, entity mentions, time-sensitive todos, names, links.
- **Brain-first lookup** before any external API call. The cheapest, fastest, most personal information source you have.
- **Auto-link** fires on every page write. No LLM calls; pure pattern matching on `[[wiki/people/bob]]` style references. New entity → new page stub → graph grows.
- **Cron-driven enrichment** runs while you sleep: dedup people pages, fix citations, score salience, find contradictions, prep tomorrow's tasks.

The whole loop is described in [`docs/architecture/topologies.md`](docs/architecture/topologies.md) with diagrams.

## Capabilities

**Hybrid search.** GBrain combines vectors, BM25 keywords, reciprocal-rank fusion, source-tier boosts, and intent-aware query rewriting.

Three search modes (`conservative`, `balanced`, `tokenmax`) bundle the cost and quality settings. Fresh initialization recommends a mode from detected provider and model-tier inputs. An unset mode falls back to `balanced`. Check the persisted choice with `gbrain search modes`. Live cost and recall comparisons are in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md).

Graph signals adjust results that are connected, corroborated across sources, or crowded out by weak session chunks. Run `gbrain search "your query" --explain` to inspect every score adjustment. `gbrain doctor` checks graph-signal coverage, and `gbrain search stats` reports usage and failures. Vector retrieval keeps the strongest chunk from each page. Title phrases and declared aliases can also promote the page they name.

Every result includes an `evidence` tag and a `create_safety` hint. Agents use those fields to decide whether a page already exists. Run `gbrain search diagnose "your query" --target page-slug` to trace which retrieval layer finds or misses a page.

**Self-wiring knowledge graph.** Every `put_page` extracts entity refs from markdown/wikilinks/typed-link syntax and writes edges with zero LLM calls. Typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, …). Multi-hop traversal via `gbrain graph-query`. The graph is what produces the +31.4 P@5 lift over vector-only RAG. **Obsidian-style vaults:** bare `[[note-name]]` wikilinks that point across folders — you wrote `[[struktura]]` but the page lives at `projects/struktura.md` — resolve by basename once you opt in with `gbrain config set link_resolution.global_basename true`. Off by default; `gbrain doctor` tells you how many edges you'd gain before you flip it. See [migrating an Obsidian vault](INSTALL_FOR_AGENTS.md#step-45-wire-the-knowledge-graph).

**Job queue (Minions).** BullMQ-shaped, Postgres-native job queue. Durable subagents (LLM tool loops that survive crashes via two-phase pending→done persistence), shell jobs with audit, child jobs with cascading timeouts, rate leases for outbound providers, attachments via S3/Supabase storage. Replaces "spawn subagent as fire-and-forget Promise" with something that recovers from anything.

**Non-English brains (FTS language config).** The Postgres full-text search tokenizer is configurable via `GBRAIN_FTS_LANGUAGE`. Defaults to `english`. Set it to any text-search configuration that exists in your Postgres instance:

```bash
export GBRAIN_FTS_LANGUAGE=portuguese     # uses built-in portuguese stemmer
export GBRAIN_FTS_LANGUAGE=spanish        # built-in spanish stemmer
export GBRAIN_FTS_LANGUAGE=pt_br          # custom config (e.g. unaccent + portuguese)
```

List available configs: `psql -c "SELECT cfgname FROM pg_ts_config"`. Both the **query side** (`websearch_to_tsquery`) and the **write side** (the trigger functions that populate `pages.search_vector` and `content_chunks.search_vector`) honor `GBRAIN_FTS_LANGUAGE`. On first install (or upgrade), the `configurable_fts_language` schema migration reads the env var and creates trigger functions in the configured language; subsequent inserts/updates tokenize using that setting. To change language on a brain that has already run the migration, use the dedicated CLI command:

```bash
export GBRAIN_FTS_LANGUAGE=portuguese
gbrain reindex-search-vector --dry-run    # preview row counts
gbrain reindex-search-vector --yes        # recreate triggers + backfill
```

The command is idempotent (re-running with the same language is a no-op for vector content) and uses the same recreate-and-backfill primitives as the migration. For accent-insensitive Portuguese (`pt_br`), see [docs/guides/multi-language-fts.md](docs/guides/multi-language-fts.md) for the `unaccent` + portuguese stemmer recipe.

**Bundled skills.** Routing lives in [`skills/RESOLVER.md`](skills/RESOLVER.md).
The skills cover signal capture, ingest, enrichment, querying, brain operations,
citation repair, task management, scheduled jobs, reports, voice, audits, skill
creation, evaluations, and migrations. The installer adds this Markdown-based
skillpack to your agent workspace.

**Eval framework.** `gbrain eval longmemeval` runs the public [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) benchmark against your hybrid retrieval. `gbrain eval export` + `gbrain eval replay` capture real queries and replay them against code changes (set `GBRAIN_CONTRIBUTOR_MODE=1`). `gbrain eval cross-modal` cross-checks an output against the task using three different-provider frontier models. `gbrain eval retrieval-quality` runs NamedThingBench, which hard-gates the named-thing retrieval families (title-substring, alias-synonym, generic-to-named, multi-chunk-dilution) so a regression in "find the page this query names" fails CI loudly. Full methodology in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md).

**Brain consistency.** `gbrain eval suspected-contradictions` samples retrieval pairs, layered date pre-filter, query-conditioned LLM judge, persistent cache. Surfaces conflicts between takes + facts the agent has written. Wired into the daily dream cycle.

**Agent-authored schema (v0.40.7.0).** Your brain has a shape — what page types exist (`person`, `meeting`, `paper`, `case`, `lab-result`), what they link to (`attended`, `authored`, `prescribed-by`), what facts get extracted automatically. The default ships with 22 universal types, but your brain's actual shape is not the default shape. Agents can now evolve that shape on your behalf via 14 `gbrain schema` CLI verbs + a batched MCP op (`schema_apply_mutations`, admin scope, NOT localOnly so remote agents reach it over HTTPS). Atomic file locks, audit log with the agent's identity, chunked UPDATE backfill in 1000-row batches that never wedge concurrent writers. The brain stops being a pile of notes and becomes something with structure. **Why it matters:** [`docs/what-schemas-unlock.md`](docs/what-schemas-unlock.md) — 7 killer use cases (4000 invisible meetings, founder ops brain, research brain, legal brain, team brain, agent-as-co-curator). **5-minute walkthrough:** [`docs/schema-author-tutorial.md`](docs/schema-author-tutorial.md). **Agent skill:** [`skills/schema-author/SKILL.md`](skills/schema-author/SKILL.md).

## Integrations

Data flowing into the brain. Each integration is a recipe — markdown + setup hints — that ships in `recipes/` and is discoverable via `gbrain integrations list`.

- **Voice**: Phone calls create brain pages via Twilio + OpenAI Realtime (or DIY STT+LLM+TTS). Setup recipe: [`recipes/twilio-voice-brain.md`](recipes/twilio-voice-brain.md).
- **Email + calendar**: webhook handlers that route to brain signals. [`docs/integrations/meeting-webhooks.md`](docs/integrations/meeting-webhooks.md).
- **Embedding providers**: 16 recipes covering OpenAI (default fallback), OpenRouter, Voyage, ZeroEntropy (default), Google Gemini, Azure OpenAI, MiniMax, Alibaba DashScope, Zhipu, Ollama (local), llama.cpp llama-server (local), LiteLLM proxy. Pricing matrix + decision tree in [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md).
- **Rerankers**: ZeroEntropy `zerank-2` hosted (enabled by default in `balanced` and `tokenmax` modes) plus the v0.40.6.1 `llama-server-reranker` recipe for local cross-encoder reranking through llama.cpp. It runs Qwen3-Reranker or self-hosted ZeroEntropy weights against the same `gateway.rerank()` interface. Follow the setup in [`docs/ai-providers/llama-server-reranker.md`](docs/ai-providers/llama-server-reranker.md).
- **Credential gateway**: vault-aware secret distribution. [`docs/integrations/credential-gateway.md`](docs/integrations/credential-gateway.md).
- **MCP clients**: every major MCP client is supported. [`docs/mcp/`](docs/mcp/) per-client setup.

## Architecture

**Two engines, one contract.** PGLite (Postgres 17 via WASM, zero-config, default) for personal brains up to ~50K pages. Postgres + pgvector (Supabase or self-hosted) for shared / large / multi-machine deployments. The contract-first `BrainEngine` interface in [`src/core/engine.ts`](src/core/engine.ts) defines ~47 operations both engines implement; CLI and MCP server are generated from one source.

**Brain repo is the system of record.** Your knowledge lives in a regular git repo (your "brain repo") as markdown files. GBrain syncs the repo into Postgres for retrieval; deletes in git become soft-deletes in DB. You can publish public subsets, share team mounts, run thin-client setups pointing at a colleague's brain server. Layout guidance: [`docs/architecture/brain-repo-layout.md`](docs/architecture/brain-repo-layout.md). Topologies: [`docs/architecture/topologies.md`](docs/architecture/topologies.md).

**Two organizational axes (brain ⊥ source).** A *brain* is a database (your personal brain, a team mount you joined). A *source* is a repo inside that brain (wiki, gstack, an essay, a knowledge base). Routing lives in `.gbrain-source` dotfiles and resolves via a documented 6-tier precedence chain. Full diagrams in [`docs/architecture/brains-and-sources.md`](docs/architecture/brains-and-sources.md).

**Why the graph matters.** Vector search returns chunks that are semantically close. The graph returns chunks that are factually connected. Hybrid search pulls from both; auto-linking on every write keeps the graph fresh. Deep dive: [`docs/architecture/RETRIEVAL.md`](docs/architecture/RETRIEVAL.md).

## Troubleshooting

**`gbrain init --pglite` fails?** The current CLI distinguishes a Bun virtual
filesystem problem, the macOS 26.3 WASM regression, a corrupted PGLite store,
and an unknown failure. Follow
[`docs/INSTALL.md` - PGLite fails to initialize](docs/INSTALL.md#pglite-fails-to-initialize)
before changing database engines.

**`gbrain import` fails with `expected N dimensions, not M`?** Run `gbrain doctor`. For an OpenAI-backed PGLite brain, for example, rebuild the index with `gbrain reinit-pglite --embedding-model openai:text-embedding-3-large --embedding-dimensions 1536`. For Postgres, use `gbrain retrieval-upgrade --to openai:text-embedding-3-large --reindex` or follow [`docs/embedding-migrations.md`](docs/embedding-migrations.md).

Do not change only `embedding_model` or `embedding_dimensions` with `gbrain config set`. Current releases refuse that schema-breaking shortcut. You should not need to delete `~/.gbrain`.

Fresh `gbrain init --pglite` detects embedding providers from API keys in your environment. Set `OPENAI_API_KEY`, `ZEROENTROPY_API_KEY`, or `VOYAGE_API_KEY` before initialization. You can also pass `--embedding-model your_provider:your_model` explicitly. With multiple keys set, init opens an interactive picker. In non-TTY contexts with no keys, init exits with a setup hint. Pass `--no-embedding` to defer the provider choice. See [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md) for the provider matrix and [`docs/operations/headless-install.md`](docs/operations/headless-install.md) for Docker and continuous integration sequencing.

**Hourly cron sync keeps timing out on a federated brain?** v0.41.13.0 ships
two flags + a recommended pattern. Switch your cron to a per-source loop
with shell `timeout(1)` doing the OS-level kill and gbrain self-terminating
gracefully half-a-minute earlier:

```bash
gbrain sync --break-lock --all --max-age 1800
for src in $(gbrain sources list --json | jq -r '.[].id'); do
  timeout 600 gbrain sync --source "$src" --timeout 540 || true
done
```

When `--timeout` fires mid-import, `gbrain sync` exits 0 with status
`partial` and `last_commit` UNCHANGED — the next run re-walks the same
diff and `content_hash` short-circuits already-imported files. The
`--max-age 1800` first command self-heals any wedged-but-alive locks
left by a hung previous run, using the v98 `last_refreshed_at` semantic
(NOT `acquired_at`) so healthy long-running holders are safe by
construction. See the sync entries in [`CHANGELOG.md`](CHANGELOG.md) for the
honest scope notes: the original v0.41.13 timeout behavior was followed by
v0.42 resumability, full-sync delete reconciliation, and additional recovery
work. Keep cron runbooks pinned to the release behavior you actually run.

**Dream cycle silently losing wiki links on Supabase?** v0.41.19.0 fixes
the bug class structurally. The engine now self-retries every bulk batch
write (`addLinksBatch` / `addTimelineEntriesBatch` / `upsertChunks`) on
Supavisor pooler blips, with a 12s worst-case wait that covers the full
5-10s circuit-breaker recovery window. `gbrain doctor` surfaces incidents
via the new `batch_retry_health` check (reads the last 24h of
`~/.gbrain/audit/batch-retry-YYYY-Www.jsonl`). To tune for an unusually
slow pooler:

```bash
# Defaults: 3 retries, base 1s, max 10s, decorrelated jitter.
# Override per operator without a release:
export GBRAIN_BULK_MAX_RETRIES=5       # int >= 0; 0 disables retries
export GBRAIN_BULK_RETRY_BASE_MS=2000  # int > 0
export GBRAIN_BULK_RETRY_MAX_MS=15000  # int >= base
```

Bad values surface at `gbrain doctor` startup with a paste-ready fix
(not at first-retry mid-cycle). PGLite-only installs pay zero cost — the
retry wrap is engine-level, but PGLite has no pooler so retries never
fire in practice.

**Dream cycle losing ~150 link rows per run with `'No database
connection: connect() has not been called'` errors in the log?** v0.41.27.0
makes the retry layer self-heal on a nulled-out database singleton. A
new `reconnect` callback on `withRetry` rebuilds the connection between
attempts; `PostgresEngine.batchRetry` injects `() => this.reconnect()`
so engine-level batch writes survive a mid-cycle disconnect by something
else in the same process. Same release: `gbrain capture` no longer trails
a `'No database connection'` stderr line from a background facts:absorb
worker firing after CLI exit — the op-dispatch finally block awaits
`getFactsQueue().drainPending({timeout: 1000})` before
`engine.disconnect()`. To find which code path is still calling
disconnect mid-process, run `gbrain doctor --json | jq '.checks[] |
select(.id=="batch_retry_health")'`; the extended check now surfaces
24h disconnect-call count and the most-recent caller frame from a new
`~/.gbrain/audit/db-disconnect-YYYY-Www.jsonl` audit. (Closes #1570.)

**`gbrain brainstorm` returning `judge_failed: true` with 0 scored
ideas?** v0.41.21.0 closes the two bugs that caused it. The judge
hard-coded a 4K-token output cap; for any run past ~40 ideas the call
truncated mid-JSON and the parser threw. Same release closes a slash-
form pricing miss: `gbrain brainstorm --judge-model
anthropic/claude-sonnet-4-6 --max-cost 5` failed with
`BudgetExhausted reason=no_pricing` because every pricing site only
matched the colon form. Both shapes work now. No config change, no
schema migration — `gbrain upgrade` is the whole fix.

**`gbrain reindex --markdown` wiped your auto/dream/signal-detector
tags?** v0.41.37.0 makes tag reconciliation add-only. Re-import and
`reindex --markdown` now ADD current frontmatter tags and never delete,
so enrichment tags written to the DB (auto-tag, dream synthesize,
signal-detector) survive a re-chunk. The reindex DB-only fallback also
reconstructs the full markdown (frontmatter + body + timeline) before
re-chunking, so a page with no on-disk source keeps its frontmatter,
title, and timeline instead of getting overwritten with empty
frontmatter. Trade-off: removing a tag from a page's frontmatter no
longer removes it from the DB on the next sync (frontmatter-tag removal
needs a provenance column, deferred). (Closes #1621.)

**`gbrain sync` wedges on a large brain (no progress, high CPU)?**
v0.41.37.0 ships three things. First, name the stalling file:

```bash
GBRAIN_SYNC_TRACE=1 gbrain sync --no-pull --no-embed --yes
```

The last `[sync] begin import: <path>` line with no following completion
is the file being processed when the hang hit. Second, if you suspect a
schema-pack `inference.regex` with catastrophic backtracking, complete
the sync with the pack disabled and re-run extraction later:

```bash
gbrain sync --no-schema-pack --no-pull --no-embed --yes
```

`gbrain schema lint` now warns on the classic nested-quantifier ReDoS
shapes (`(a+)+`, `(a*)*`, …) in pack regexes, and the runtime caps
inference-regex input length (override via `GBRAIN_MAX_REGEX_INPUT_CHARS`).
Third, on a PGLite brain, stop `gbrain serve` before a large sync —
PGLite is single-writer and a live MCP server contends for the write
lock. See [`docs/architecture/serve-sync-concurrency.md`](docs/architecture/serve-sync-concurrency.md)
for the full triage. (Closes #1569.)

**`gbrain init --migrate-only` / a schema migration fails on Windows
with `getaddrinfo ENOTFOUND`?** v0.41.37.0 runs the 9 schema-bring-up
phases in-process instead of spawning a child `gbrain init
--migrate-only` per phase. The spawned child died on
Windows + bun + Supabase pooler with a DNS-resolution failure even
though the parent connected fine; running in-process removes the spawn
entirely. The v0.13.1 grandfather migration that hung 70+ minutes on an
82K-page PGLite brain is also fixed — it now runs as a chunked bulk SQL
pass (keyed on the page PK, soft-delete-filtered, source-safe) that
completes in ~1-2 seconds. (Closes #1605, #1581.)

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — every install path, end to end
- [`docs/architecture/brain-repo-layout.md`](docs/architecture/brain-repo-layout.md): editable Markdown layout, managed/generated content, schema-pack expectations, and backup implications
- [`docs/what-schemas-unlock.md`](docs/what-schemas-unlock.md) — why schemas matter: 7 killer use cases, the structural argument for typed page kinds, the agent-co-curates pattern (v0.40.7.0)
- [`docs/schema-author-tutorial.md`](docs/schema-author-tutorial.md) — 5-minute walkthrough: fork the bundled pack, add a custom type, backfill existing pages, prove the wiring via `gbrain whoknows`
- [`docs/architecture/`](docs/architecture/) — system design, topologies, retrieval theory
- [`docs/guides/`](docs/guides/) — how-to runbooks (sub-agent routing, minion deployment, skill development, brain-first lookup, idea capture, diligence ingestion)
- [`docs/integrations/`](docs/integrations/) — connecting external data sources (voice, email, calendar, embedding providers)
- [`docs/mcp/`](docs/mcp/) — per-client MCP setup (Claude Desktop, Code, Cursor, ChatGPT, Perplexity, Cowork)
- [`docs/eval/`](docs/eval/) — eval framework, metric glossary, methodology
- [`docs/ethos/`](docs/ethos/) — philosophy (thin harness, fat skills, markdown as recipes, origin story)
- [`AGENTS.md`](AGENTS.md) — entry point for non-Claude agents
- [`CLAUDE.md`](CLAUDE.md) — entry point for Claude Code (deep operating context)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor guide, test discipline, eval-capture mode
- [`SECURITY.md`](SECURITY.md) — OAuth threat model, hardening defaults

## Contributing

Run `bun run test` for the fast loop, `bun run verify` for the pre-push gate, `bun run ci:local` to run the full Docker-backed CI stack locally. Detailed test discipline in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Community PRs are batched into release waves rather than merged one-by-one — see the "PR wave workflow" section in [`CLAUDE.md`](CLAUDE.md). Contributor attribution stays attached via `Co-Authored-By:` trailers. We credit every accepted contribution in [`CHANGELOG.md`](CHANGELOG.md).

If you find a bug or want a feature: open an issue first. Quick fixes (typo, doc bug, obvious regression) can go straight to a PR. Anything touching schema, retrieval ranking, MCP protocol, or the security boundary needs a design discussion in the issue first.

## License + credit

MIT. I built GBrain to run my OpenClaw and Hermes deployments — the production brain behind my AI agents.

Origin story: [`docs/ethos/ORIGIN.md`](docs/ethos/ORIGIN.md).

Community PR contributors are credited in `CHANGELOG.md` per release. ZeroEntropy ([@zeroentropy](https://zeroentropy.dev)) for the embedding + reranker stack that ships as the default. Voyage AI for the asymmetric-encoding recipe template. Ramp Labs for the search quality improvements lineage.
