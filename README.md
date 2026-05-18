# GBrain

Your AI agent is smart but forgetful. GBrain gives it a brain.

Built by the President and CEO of Y Combinator to run his actual AI agents. The production brain behind his OpenClaw and Hermes deployments: **17,888 pages, 4,383 people, 723 companies**, 21 cron jobs running autonomously, built in 12 days. The agent ingests meetings, emails, tweets, voice calls, and original ideas while you sleep. It enriches every person and company it encounters. It fixes its own citations and consolidates memory overnight. You wake up smarter than when you went to bed.

The brain wires itself. Every page write extracts entity references and creates typed links (`attended`, `works_at`, `invested_in`, `founded`, `advises`) with zero LLM calls. Hybrid search. Self-wiring knowledge graph. Structured timeline. Backlink-boosted ranking. Ask "who works at Acme AI?" or "what did Bob invest in this quarter?" and get answers vector search alone can't reach. Benchmarked side-by-side: gbrain lands **P@5 49.1%, R@5 97.9%** on a 240-page Opus-generated rich-prose corpus, beating its graph-disabled variant by **+31.4 points P@5** and ripgrep-BM25 + vector-only RAG by a similar margin. Full BrainBench scorecards live in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo.

**New default in v0.36.0.0: ZeroEntropy** for both embedding (`zembed-1` at 1280d via Matryoshka) and reranker (`zerank-2`). On a real-corpus benchmark vs OpenAI and Voyage: **2.2× faster** (442ms vs OpenAI 973ms), **2.6× cheaper at regular pricing** ($0.05/M vs OpenAI $0.13), wins 11 of 20 queries head-to-head, reshuffles 60% of top-1 results when used as a second-pass reranker. Bring your own key from [zeroentropy.dev](https://dashboard.zeroentropy.dev), or stay on OpenAI/Voyage via `gbrain config set embedding_model <provider:model>` — your choice is sticky.

GBrain is those patterns, generalized. Install in 30 minutes. Your agent does the work. As Garry's personal agent gets smarter, so does yours.

> **~30 minutes to a fully working brain.** Database ready in 2 seconds (PGLite, no server). You just answer questions about API keys.

> **LLMs:** fetch [`llms.txt`](llms.txt) for the documentation map, or [`llms-full.txt`](llms-full.txt) for the same map with core docs inlined in one fetch. **Agents:** start with [`AGENTS.md`](AGENTS.md) (or [`CLAUDE.md`](CLAUDE.md) if you're Claude Code).

## Install

GBrain runs in three shapes. Pick the one that matches how you use AI agents today.

### Run with your agent platform

Already using [OpenClaw](https://github.com/garrytan/openclaw) or [Hermes](https://github.com/garrytan/hermes)? GBrain installs as a skillpack into your agent's workspace.

```bash
gbrain init --pglite
gbrain skillpack install
```

That's it. Your agent picks up 43 skills (signal detection, brain-ops, ingest, enrich, citation-fixer, daily-task-manager, cron-scheduler, eval framework, and 35 more). Routing lives in `skills/RESOLVER.md` — the agent reads it once per request, picks the right skill, executes.

### CLI standalone

Use gbrain from any shell, no agent platform required.

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite   # 2 seconds; no server, no Docker
gbrain doctor          # verify health
```

Then point any MCP-aware client (Claude Code, Cursor, Windsurf) at it, or use it from your shell:

```bash
gbrain search "who works at acme AI?"
gbrain query "what did bob invest in this quarter?"
gbrain graph-query people/garry-tan --depth 2
```

Detailed setup paths (Postgres at scale, Supabase, thin-client mode) live in [`docs/INSTALL.md`](docs/INSTALL.md).

### MCP server (any MCP client)

```bash
gbrain serve              # stdio MCP (Claude Desktop / Code / Cursor)
gbrain serve --http       # HTTP MCP with OAuth 2.1 + admin dashboard
                          # at /admin, SSE activity feed at /admin/events
```

Per-client guides (Claude Desktop, Code, Cursor, ChatGPT, Perplexity, Cowork) live under [`docs/mcp/`](docs/mcp/). HTTP server supports DCR-style client registration, scope-gated access (`read`/`write`/`admin`), and built-in rate limiting.

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

**Hybrid search.** Vector (HNSW on pgvector) + BM25 keyword + reciprocal-rank fusion + source-tier boost + intent-aware query rewriting. Three named search modes (`conservative`, `balanced`, `tokenmax`) bundle the cost/quality knobs into a single config key. Live cost/recall comparisons in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md). Default: `balanced` with ZeroEntropy reranker on.

**Self-wiring knowledge graph.** Every `put_page` extracts entity refs from markdown/wikilinks/typed-link syntax and writes edges with zero LLM calls. Typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, …). Multi-hop traversal via `gbrain graph-query`. The graph is what produces the +31.4 P@5 lift over vector-only RAG.

**Job queue (Minions).** BullMQ-shaped, Postgres-native job queue. Durable subagents (LLM tool loops that survive crashes via two-phase pending→done persistence), shell jobs with audit, child jobs with cascading timeouts, rate leases for outbound providers, attachments via S3/Supabase storage. Replaces "spawn subagent as fire-and-forget Promise" with something that recovers from anything.

**43 curated skills.** Routing lives in [`skills/RESOLVER.md`](skills/RESOLVER.md). Covers signal capture, ingest (idea / media / meeting), enrichment, querying, brain ops, citation fixing, daily task management, cron scheduling, reports, voice, soul audit, skill creation, eval framework, and migrations. Skills are markdown files (tool-agnostic), packaged as a single skillpack the installer drops into your agent workspace.

**Eval framework.** `gbrain eval longmemeval` runs the public [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) benchmark against your hybrid retrieval. `gbrain eval export` + `gbrain eval replay` capture real queries and replay them against code changes (set `GBRAIN_CONTRIBUTOR_MODE=1`). `gbrain eval cross-modal` cross-checks an output against the task using three different-provider frontier models. Full methodology in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md).

**Brain consistency.** `gbrain eval suspected-contradictions` samples retrieval pairs, layered date pre-filter, query-conditioned LLM judge, persistent cache. Surfaces conflicts between takes + facts the agent has written. Wired into the daily dream cycle.

## Integrations

Data flowing into the brain. Each integration is a recipe — markdown + setup hints — that ships in `recipes/` and is discoverable via `gbrain integrations list`.

- **Voice**: Whisper or Groq voice-to-brain capture. Setup in [`docs/integrations/voice.md`](docs/integrations/voice.md).
- **Email + calendar**: webhook handlers that route to brain signals. [`docs/integrations/meeting-webhooks.md`](docs/integrations/meeting-webhooks.md).
- **Embedding providers**: 14 recipes covering OpenAI (default fallback), Voyage, ZeroEntropy (default), Google Gemini, Azure OpenAI, MiniMax, Alibaba DashScope, Zhipu, Ollama (local), llama.cpp llama-server (local), LiteLLM proxy. Pricing matrix + decision tree in [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md).
- **Credential gateway**: vault-aware secret distribution. [`docs/integrations/credential-gateway.md`](docs/integrations/credential-gateway.md).
- **MCP clients**: every major MCP client is supported. [`docs/mcp/`](docs/mcp/) per-client setup.

## Architecture

**Two engines, one contract.** PGLite (Postgres 17 via WASM, zero-config, default) for personal brains up to ~50K pages. Postgres + pgvector (Supabase or self-hosted) for shared / large / multi-machine deployments. The contract-first `BrainEngine` interface in [`src/core/engine.ts`](src/core/engine.ts) defines ~47 operations both engines implement; CLI and MCP server are generated from one source.

**Brain repo is the system of record.** Your knowledge lives in a regular git repo (your "brain repo") as markdown files. GBrain syncs the repo into Postgres for retrieval; deletes in git become soft-deletes in DB. You can publish public subsets, share team mounts, run thin-client setups pointing at a colleague's brain server. Topologies in [`docs/architecture/topologies.md`](docs/architecture/topologies.md).

**Two organizational axes (brain ⊥ source).** A *brain* is a database (your personal brain, a team mount you joined). A *source* is a repo inside that brain (wiki, gstack, an essay, a knowledge base). Routing lives in `.gbrain-source` dotfiles and resolves via a documented 6-tier precedence chain. Full diagrams in [`docs/architecture/brains-and-sources.md`](docs/architecture/brains-and-sources.md).

**Why the graph matters.** Vector search returns chunks that are semantically close. The graph returns chunks that are factually connected. Hybrid search pulls from both; auto-linking on every write keeps the graph fresh. Deep dive: [`docs/architecture/RETRIEVAL.md`](docs/architecture/RETRIEVAL.md).

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — every install path, end to end
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

MIT. Built by Garry Tan to run his OpenClaw and Hermes deployments — the production brain behind his actual AI agents.

Origin story: [`docs/ethos/ORIGIN.md`](docs/ethos/ORIGIN.md).

Community PR contributors are credited in `CHANGELOG.md` per release. ZeroEntropy ([@zeroentropy](https://zeroentropy.dev)) for the embedding + reranker stack that became the v0.36.0.0 default. Voyage AI for the asymmetric-encoding recipe template. Ramp Labs for the search quality improvements lineage.
