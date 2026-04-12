# GBrain

Your AI agent is smart but it doesn't know anything about your life. GBrain fixes that. Meetings, emails, tweets, calendar events, voice calls, original ideas... all of it flows into a searchable knowledge base that your agent reads before every response and writes to after every conversation. The agent gets smarter every day.

> **~30 minutes to a fully working brain.** Your agent does the work. Database ready in 2 seconds (PGLite, no server). Schema, import, embeddings, and integrations take 15-30 minutes depending on brain size. You just answer questions about API keys.
>
> **Requires a frontier model.** Tested with **Claude Opus 4.6** and **GPT-5.4 Thinking**. Likely to break with smaller models.

## Need an AI agent first?

GBrain is designed to be installed and operated by an AI agent. If you don't have one running yet:

- **[OpenClaw](https://openclaw.ai)** — Deploy [AlphaClaw on Render](https://render.com/deploy?repo=https://github.com/openclaw/alphaclaw) (one click, requires 8GB+ RAM instance)
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — Deploy on [Railway using this template](https://github.com/praveen-ks-2001/hermes-agent-template) (one click)

## Start here: paste this into your agent

Copy this block into OpenClaw or Hermes Agent. The agent will install GBrain, set up the brain schema, import your files, configure all integrations, and verify everything works. GBrain needs a persistent agent that can run cron jobs and background sync.

```
GOAL: I want an opinionated AI agent setup that actually works. Get me
there. Install GBrain, set up the brain schema, import my files,
configure all integrations, and verify everything works. Do not skip
steps. Verify each step before proceeding. If a step fails, stop
and fix it.

You don't need a server to start. gbrain init defaults to PGLite
(embedded Postgres 17.5 via WASM). No Supabase account, no Docker,
no connection strings. One command and you have a full Postgres brain
with pgvector, hybrid search, and all 37 operations. When your brain
outgrows local (1000+ files), gbrain migrate --to supabase moves
everything to managed Postgres in one shot.

The knowledge model is markdown files in a git repo. Read
docs/GBRAIN_SKILLPACK.md for the full agent playbook and
docs/GBRAIN_RECOMMENDED_SCHEMA.md for the brain directory structure.

STEP 1 — INSTALL
  curl -fsSL https://bun.sh/install | bash && source ~/.bashrc
  bun add github:garrytan/gbrain
  Verify: gbrain --version

STEP 2 — DATABASE
  Run: gbrain init
  This creates a local PGLite brain (embedded Postgres, no server).
  Brain ready in ~2 seconds. No accounts, no connection strings.
  Verify: gbrain doctor --json (all checks pass)

  For large brains (1000+ files) or remote access, use Supabase:
    gbrain init --supabase
  You can migrate anytime: gbrain migrate --to supabase

STEP 3 — SCHEMA
  Read docs/GBRAIN_RECOMMENDED_SCHEMA.md — this is the brain's directory
  structure. Set up the MECE directories (people/, companies/, deals/,
  concepts/, etc.) with README.md resolvers in each. The schema tells
  you exactly what goes where and how to resolve ambiguity.
  The agent maintains this structure automatically after setup.

STEP 4 — IMPORT
  Find markdown: find ~/git ~/Documents ~/notes -maxdepth 3 -name "*.md" | head -30
  Tell user what you found. Import: gbrain import /path/ --no-embed
  Verify: gbrain stats (page count > 0)

STEP 5 — SEARCH
  Run: gbrain embed --stale (generates vector embeddings, ~1 min per 1000 pages)
  Then: gbrain query "what are the key themes across these documents?"
  Show the user the results. This is the magic moment.
  Verify: results include semantic matches, not just keyword hits

STEP 6 — GO LIVE
  a. Read docs/GBRAIN_SKILLPACK.md — adopt brain-first lookup, entity
     detection, and back-linking into your behavior immediately
  b. Set up live sync: gbrain sync --repo /path/ && gbrain embed --stale
     (see docs/guides/live-sync.md for cron/watch/webhook options)
  c. Set up auto-update: gbrain check-update --json on a daily cron
     (never auto-install — always ask the user first)
  d. Run verification: read and execute docs/GBRAIN_VERIFY.md

STEP 7 — INTEGRATIONS
  Run: gbrain integrations list
  For EVERY available recipe, set it up. Each recipe is a markdown file
  that tells the agent exactly what credentials to ask for, how to
  validate them, and how to wire the integration. The agent reads the
  recipe, asks the user for API keys, and handles the rest.
  Voice, email, calendar, Twitter — install them all.
  Verify: gbrain integrations doctor (all health checks pass)

DONE. Tell the user: "GBrain is live. You have [N] pages with hybrid
search. I now check the brain before answering questions. All available
integrations are configured."
```

### Without an agent (standalone CLI)

```bash
bun add -g github:garrytan/gbrain
gbrain init                     # local brain, ready in 2 seconds
gbrain import ~/git/brain/      # index your markdown
gbrain query "what themes show up across my notes?"
```

Run `gbrain --help` for all commands. See [MCP setup](docs/mcp/DEPLOY.md) for connecting Claude Desktop, Perplexity, etc.

## Getting Data In

Once GBrain is installed, your agent needs data flowing in. GBrain ships integration recipes that your agent sets up for you. It reads the recipe, asks for API keys, validates each one, and runs a smoke test. [Markdown is code](docs/ethos/THIN_HARNESS_FAT_SKILLS.md)... the recipe IS the installer.

| Recipe | Requires | What It Does |
|--------|----------|-------------|
| [Public Tunnel](recipes/ngrok-tunnel.md) | — | Fixed URL for MCP + voice (ngrok Hobby $8/mo) |
| [Credential Gateway](recipes/credential-gateway.md) | — | Gmail + Calendar access (ClawVisor or Google OAuth) |
| [Voice-to-Brain](recipes/twilio-voice-brain.md) | ngrok-tunnel | Phone calls → brain pages (Twilio + OpenAI Realtime) |
| [Email-to-Brain](recipes/email-to-brain.md) | credential-gateway | Gmail → entity pages (deterministic collector) |
| [X-to-Brain](recipes/x-to-brain.md) | — | Twitter → brain pages (timeline + mentions + deletions) |
| [Calendar-to-Brain](recipes/calendar-to-brain.md) | credential-gateway | Google Calendar → searchable daily pages |
| [Meeting Sync](recipes/meeting-sync.md) | — | Circleback transcripts → brain pages with attendees |

Run `gbrain integrations` to see status. Dependencies resolve automatically. See [Getting Data In](docs/integrations/README.md) for the full guide.

## The Compounding Thesis

Most tools help you find things. GBrain makes you smarter over time.

```
Signal arrives (meeting, email, tweet, link)
  → Agent detects entities (people, companies, ideas)
  → READ: check the brain first (gbrain search, gbrain get)
  → Respond with full context
  → WRITE: update brain pages with new information
  → Sync: gbrain indexes changes for next query
```

Every cycle through this loop adds knowledge. The agent enriches a person page after a meeting. Next time that person comes up, the agent already has context. You never start from zero.

An agent without this loop answers from stale context. An agent with it gets smarter every conversation. The difference compounds daily.

> "Who should I invite to dinner who knows both Pedro and Diana?"
> — cross-references the social graph across 3,000+ people pages

> "What have I said about the relationship between shame and founder performance?"
> — searches YOUR thinking, not the internet

> "Prep me for my meeting with Jordan in 30 minutes"
> — pulls dossier, shared history, recent activity, open threads

## Voice: "Her" Out of the Box

The voice integration is the strongest demonstration of why a personal brain matters.
Call a phone number. Your AI answers. It knows who's calling, pulls their full context
from thousands of people pages, references your last meeting, and responds like someone
who actually knows your world. When the call ends, a structured brain page appears with
the transcript, entity detection, and cross-references.

This isn't a demo. It runs on a real phone number, screens unknown callers, and gets
smarter with every call. Your agent picks its own name and personality. WebRTC works in
a browser tab with zero setup. A real phone number is optional.

<p align="center">
  <img src="docs/images/voice-client.png" alt="Voice client connected" width="300" />
</p>

> [See it in action](https://x.com/garrytan/status/2043022208512172263)

The voice recipe ships with GBrain: [Voice-to-Brain](recipes/twilio-voice-brain.md).
Your agent installs it, sets up the voice server, and you have a working AI phone line
in 30 minutes. 25 production patterns from a real deployment included.

## How this happened

I was setting up my [OpenClaw](https://openclaw.ai) agent and started a markdown brain repo. One page per person, one page per company, compiled truth on top, append-only timeline on the bottom. The agent got smarter the more it knew, so I kept feeding it. Within a week I had 10,000+ markdown files, 3,000+ people with compiled dossiers, 13 years of calendar data, 280+ meeting transcripts, and 300+ captured original ideas.

The agent runs while I sleep. The dream cycle scans every conversation, enriches missing entities, fixes broken citations, and consolidates memory. I wake up and the brain is smarter than when I went to sleep. See the [cron schedule guide](docs/guides/cron-schedule.md) for setup.

**PGLite runs locally by default.** `gbrain init` gives you embedded Postgres with pgvector, hybrid search, and all 37 operations. No server, no subscription. When your brain outgrows local (1000+ files, multi-device access, remote MCP), `gbrain migrate --to supabase` moves everything to managed Postgres.

## Architecture

```
┌──────────────────┐    ┌───────────────┐    ┌──────────────────┐
│   Brain Repo     │    │    GBrain     │    │    AI Agent      │
│   (git)          │    │  (retrieval)  │    │  (read/write)    │
│                  │    │               │    │                  │
│  markdown files  │───>│  Postgres +   │<──>│  skills define   │
│  = source of     │    │  pgvector     │    │  HOW to use the  │
│    truth         │    │               │    │  brain           │
│                  │<───│  hybrid       │    │                  │
│  human can       │    │  search       │    │  entity detect   │
│  always read     │    │  (vector +    │    │  enrich          │
│  & edit          │    │   keyword +   │    │  ingest          │
│                  │    │   RRF)        │    │  brief           │
└──────────────────┘    └───────────────┘    └──────────────────┘
```

The repo is the system of record. GBrain is the retrieval layer. The agent reads and writes through both. Human always wins — you can edit any markdown file directly and `gbrain sync` picks up the changes.

## What a Production Agent Looks Like

The numbers above aren't theoretical. They come from a real deployment documented in [GBRAIN_SKILLPACK.md](docs/GBRAIN_SKILLPACK.md) — a reference architecture for how a production AI agent uses gbrain as its knowledge backbone.

**Read the skillpack.** It's the most important doc in this repo. It tells your agent HOW to use gbrain, not just what commands exist:

- **The brain-agent loop** — the read-write cycle that makes knowledge compound
- **Entity detection** — spawn on every message, capture people/companies/original ideas
- **Enrichment pipeline** — 7-step protocol with tiered API spend
- **Meeting ingestion** — transcript to brain pages with entity propagation
- **Source attribution** — every fact traceable to where it came from
- **Reference cron schedule** — 20+ recurring jobs that keep the brain alive

Without the skillpack, your agent has tools but no playbook. With it, the agent knows when to read, when to write, how to enrich, and how to keep the brain alive autonomously. It's a pattern book, not a tutorial. "Here's what works, here's why."

## How gbrain fits with OpenClaw/Hermes

GBrain is world knowledge — people, companies, deals, meetings, concepts, your original thinking. It's the long-term memory of what you know about the world.

[OpenClaw](https://openclaw.ai) agent memory (`memory_search`) is operational state — preferences, decisions, session context, how the agent should behave.

They're complementary:

| Layer | What it stores | How to query |
|-------|---------------|-------------|
| **gbrain** | People, companies, meetings, ideas, media | `gbrain search`, `gbrain query`, `gbrain get` |
| **Agent memory** | Preferences, decisions, operational config | `memory_search` |
| **Session context** | Current conversation | (automatic) |

All three should be checked. GBrain for facts about the world. Memory for agent config. Session for immediate context. Install via `openclaw skills install gbrain`.

## The compounding effect

The real value isn't search. It's what happens after a few weeks of use.

You take a meeting with someone. The agent writes a brain page for them, links it to their company, tags it with the deal. Next week someone mentions that company in a different context. The agent already has the full picture: who you talked to, what you discussed, what threads are open. You didn't do anything. The brain already had it.

## Install

### Prerequisites

**Zero-config start (PGLite).** `gbrain init` creates a local embedded Postgres brain. No accounts, no server, no API keys. Keyword search works immediately. Add API keys later for vector search and LLM-powered features.

**For production scale (Supabase).** When your brain outgrows local, `gbrain migrate --to supabase` moves everything to managed Postgres:

| Dependency | What it's for | How to get it |
|------------|--------------|---------------|
| **Supabase account** | Postgres + pgvector database | [supabase.com](https://supabase.com) (Pro tier, $25/mo for 8GB) |
| **OpenAI API key** | Embeddings (text-embedding-3-large) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic API key** | Multi-query expansion + LLM chunking (Haiku) | [console.anthropic.com](https://console.anthropic.com) |

Set the API keys as environment variables:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

The Supabase connection URL is configured during `gbrain init --supabase`. The OpenAI and Anthropic SDKs read their keys from the environment automatically.

Without an OpenAI key, search still works (keyword only, no vector search). Without an Anthropic key, search still works (no multi-query expansion, no LLM chunking).

### GBrain without OpenClaw

GBrain works with any AI agent, any MCP client, or no agent at all. Three paths:

#### Standalone CLI

Install globally and use gbrain from the terminal:

```bash
bun add -g github:garrytan/gbrain
gbrain init                     # PGLite (local, no server needed)
gbrain import ~/git/brain/      # index your markdown
gbrain query "what themes show up across my notes?"
```

Run `gbrain --help` for the full list of commands.

#### MCP server (Claude Code, Cursor, Windsurf, etc.)

GBrain exposes 30 MCP tools via stdio. Add this to your MCP client config:

**Claude Code** (`~/.claude/server.json`):
```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

**Cursor** (Settings > MCP Servers):
```json
{
  "gbrain": {
    "command": "gbrain",
    "args": ["serve"]
  }
}
```

This gives your agent `get_page`, `put_page`, `search`, `query`, `add_link`, `traverse_graph`, `sync_brain`, `file_upload`, and 22 more tools. All generated from the same operation definitions as the CLI.

#### Remote MCP Server (Claude Desktop, Cowork, Perplexity)

Access your brain from any device, any AI client. Run `gbrain serve` behind an HTTP
server with a public tunnel:

```bash
# Set up a public tunnel (see recipes/ngrok-tunnel.md)
ngrok http 8787 --url your-brain.ngrok.app

# Create a bearer token for your client
bun run src/commands/auth.ts create "claude-desktop"
```

Then add to your AI client:
- **Claude Code:** `claude mcp add gbrain -t http https://your-brain.ngrok.app/mcp -H "Authorization: Bearer TOKEN"`
- **Claude Desktop:** Settings > Integrations > Add (NOT JSON config, [details](docs/mcp/CLAUDE_DESKTOP.md))
- **Perplexity:** Settings > Connectors > Add remote MCP ([details](docs/mcp/PERPLEXITY.md))

Per-client setup guides: [`docs/mcp/`](docs/mcp/DEPLOY.md)

ChatGPT support requires OAuth 2.1 (not yet implemented). Self-hosted alternatives (Tailscale Funnel, ngrok) documented in [`docs/mcp/ALTERNATIVES.md`](docs/mcp/ALTERNATIVES.md).

**The tools are not enough.** Your agent also needs the playbook: read [GBRAIN_SKILLPACK.md](docs/GBRAIN_SKILLPACK.md) and paste the relevant sections into your agent's system prompt or project instructions. The skillpack tells the agent WHEN and HOW to use each tool: read before responding, write after learning, detect entities on every message, back-link everything.

The skill markdown files in `skills/` are standalone instruction sets. Copy them into your agent's context:

| Skill file | What the agent learns |
|------------|----------------------|
| `skills/ingest/SKILL.md` | How to import meetings, docs, articles |
| `skills/query/SKILL.md` | 3-layer search with synthesis and citations |
| `skills/maintain/SKILL.md` | Periodic health: stale pages, orphans, dead links |
| `skills/enrich/SKILL.md` | Enrich pages from external APIs |
| `skills/briefing/SKILL.md` | Daily briefing with meeting prep |
| `skills/migrate/SKILL.md` | Migrate from Obsidian, Notion, Logseq, etc. |

#### As a TypeScript library

```bash
bun add github:garrytan/gbrain
```

```typescript
import { createEngine } from 'gbrain';

// PGLite (local, no server)
const engine = createEngine('pglite');
await engine.connect({ database_path: '~/.gbrain/brain.pglite' });
await engine.initSchema();

// Or Postgres (Supabase / self-hosted)
// const engine = createEngine('postgres');
// await engine.connect({ database_url: process.env.DATABASE_URL });
// await engine.initSchema();

// Search
const results = await engine.searchKeyword('startup growth');

// Read
const page = await engine.getPage('people/pedro-franceschi');

// Write
await engine.putPage('concepts/superlinear-returns', {
  type: 'concept',
  title: 'Superlinear Returns',
  compiled_truth: 'Paul Graham argues that returns in many fields are superlinear...',
  timeline: '- 2023-10-01: Published on paulgraham.com',
});
```

The `BrainEngine` interface is pluggable. `createEngine()` accepts `'pglite'` or `'postgres'`. See `docs/ENGINES.md` for details.

PGLite (default) requires no external database. For production scale (7K+ pages, multi-device, remote MCP), use Supabase Pro ($25/mo).

## Upgrade

Upgrade depends on how you installed:

```bash
# Installed via bun (standalone or library)
bun update gbrain

# Installed via ClawHub
clawhub update gbrain

# Compiled binary
# Download the latest from https://github.com/garrytan/gbrain/releases
```

After upgrading, run `gbrain init` again to apply any schema migrations (idempotent, safe to re-run).

## Setup details

`gbrain init` defaults to PGLite (embedded Postgres 17.5 via WASM). No accounts, no server. Config saved to `~/.gbrain/config.json`.

```bash
gbrain init                     # PGLite (default)
gbrain init --supabase          # guided wizard for Supabase
gbrain init --url <conn>        # any Postgres with pgvector
```

Import is idempotent. Re-running skips unchanged files (SHA-256 content hash). ~30s for text import of 7,000 files, ~10-15 min for embedding.

## File storage and migration

Brain repos accumulate binary files: images, PDFs, audio recordings, raw API responses. A repo with 3,000 markdown pages might have 2GB of binaries making `git clone` painful.

GBrain has a three-stage migration lifecycle that moves binaries to cloud storage while preserving every reference:

```
Local files in git repo
  │
  ▼  gbrain files mirror <dir>
Cloud copy exists, local files untouched
  │
  ▼  gbrain files redirect <dir>
Local files replaced with .redirect breadcrumbs (tiny YAML pointers)
  │
  ▼  gbrain files clean <dir>
Breadcrumbs removed, cloud is the only copy
```

Every stage is reversible until `clean`:

```bash
# Stage 1: Copy to cloud (git repo unchanged)
gbrain files mirror ~/git/brain/attachments/ --dry-run   # preview first
gbrain files mirror ~/git/brain/attachments/

# Stage 2: Replace local files with breadcrumbs
gbrain files redirect ~/git/brain/attachments/ --dry-run
gbrain files redirect ~/git/brain/attachments/
# Your git repo just dropped from 2GB to 50MB

# Undo: download everything back from cloud
gbrain files restore ~/git/brain/attachments/

# Stage 3: Remove breadcrumbs (irreversible, cloud is the only copy)
gbrain files clean ~/git/brain/attachments/ --yes
```

**Storage backends:** S3-compatible (AWS S3, Cloudflare R2, MinIO), Supabase Storage, or local filesystem. Configured during `gbrain init`.

Additional file commands:

```bash
gbrain files list [slug]           # list files for a page (or all)
gbrain files upload <file> --page <slug>  # upload file linked to page
gbrain files sync <dir>            # bulk upload directory
gbrain files verify                # verify all uploads match local
gbrain files status                # show migration status of directories
gbrain files unmirror <dir>        # remove mirror marker (files stay in cloud)
```

The file resolver (`src/core/file-resolver.ts`) handles fallback automatically: if a local file is missing, it checks for a `.redirect` breadcrumb, then a `.supabase` marker, and resolves to the cloud URL. Code that references files by path keeps working after migration.

## The knowledge model

Every page in the brain follows the compiled truth + timeline pattern:

```markdown
---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth, pg-essay]
---

Paul Graham's argument that startups should do unscalable things early on.
The most common: recruiting users manually, one at a time. Airbnb went
door to door in New York photographing apartments. Stripe manually
installed their payment integration for early users.

The key insight: the unscalable effort teaches you what users actually
want, which you can't learn any other way.

---

- 2013-07-01: Published on paulgraham.com
- 2024-11-15: Referenced in batch W25 kickoff talk
- 2025-02-20: Cited in discussion about AI agent onboarding strategies
```

Above the `---` separator: **compiled truth**. Your current best understanding. Gets rewritten when new evidence changes the picture. Below: **timeline**. Append-only evidence trail. Never edited, only added to.

The compiled truth is the answer. The timeline is the proof.

## How search works

```
Query: "when should you ignore conventional wisdom?"
         |
    Multi-query expansion (Claude Haiku)
    "contrarian thinking startups", "going against the crowd"
         |
    +----+----+
    |         |
  Vector    Keyword
  (HNSW     (tsvector +
  cosine)    ts_rank)
    |         |
    +----+----+
         |
    RRF Fusion: score = sum(1/(60 + rank))
         |
    4-Layer Dedup
    1. Best chunk per page
    2. Cosine similarity > 0.85
    3. Type diversity (60% cap)
    4. Per-page chunk cap
         |
    Stale alerts (compiled truth older than latest timeline)
         |
    Results
```

Keyword search alone misses conceptual matches. "Ignore conventional wisdom" won't find an essay titled "The Bus Ticket Theory of Genius" even though it's exactly about that. Vector search alone misses exact phrases when the embedding is diluted by surrounding text. RRF fusion gets both right. Multi-query expansion catches phrasings you didn't think of.

## Database schema

10 tables in Postgres + pgvector:

```
pages                    The core content table
  slug (UNIQUE)          e.g. "concepts/do-things-that-dont-scale"
  type                   person, company, deal, yc, civic, project, concept, source, media
  title, compiled_truth, timeline
  frontmatter (JSONB)    Arbitrary metadata
  search_vector          Trigger-based tsvector (title + compiled_truth + timeline + timeline_entries)
  content_hash           SHA-256 for import idempotency

content_chunks           Chunked content with embeddings
  page_id (FK)           Links to pages
  chunk_text             The chunk content
  chunk_source           'compiled_truth' or 'timeline'
  embedding (vector)     1536-dim from text-embedding-3-large
  HNSW index             Cosine similarity search

links                    Cross-references between pages
  from_page_id, to_page_id
  link_type              knows, invested_in, works_at, founded, references, etc.

tags                     page_id + tag (many-to-many)

timeline_entries         Structured timeline events
  page_id, date, source, summary, detail (markdown)

page_versions            Snapshot history for compiled_truth
  compiled_truth, frontmatter, snapshot_at

raw_data                 Sidecar JSON from external APIs
  page_id, source, data (JSONB)

files                    Binary attachments in Supabase Storage
  page_slug (FK)         Links to pages (ON UPDATE CASCADE)
  storage_path, content_hash, mime_type, metadata (JSONB)

ingest_log               Audit trail of import/ingest operations

config                   Brain-level settings (embedding model, chunk strategy, sync state)
```

Indexes: B-tree on slug/type, GIN on frontmatter/search_vector, HNSW on embeddings, pg_trgm on title for fuzzy slug resolution.

## Chunking

Three strategies, dispatched by content type:

**Recursive** (timeline, bulk import): 5-level delimiter hierarchy (paragraphs, lines, sentences, clauses, words). 300-word chunks with 50-word sentence-aware overlap. Fast, predictable, lossless.

**Semantic** (compiled truth): Embeds each sentence, computes adjacent cosine similarities, applies Savitzky-Golay smoothing to find topic boundaries. Falls back to recursive on failure. Best quality for intelligence assessments.

**LLM-guided** (high-value content, on request): Pre-splits into 128-word candidates, asks Claude Haiku to identify topic shifts in sliding windows. 3 retries per window. Most expensive, best results.

## Commands

```
SETUP
  gbrain init [--supabase|--url <conn>]     Create brain (PGLite default, or Supabase)
  gbrain migrate --to supabase|pglite       Migrate between engines (bidirectional)
  gbrain upgrade                            Self-update

PAGES
  gbrain get <slug>                         Read a page (supports fuzzy slug matching)
  gbrain put <slug> [< file.md]             Write/update a page (auto-versions)
  gbrain delete <slug>                      Delete a page
  gbrain list [--type T] [--tag T] [-n N]   List pages with filters

SEARCH
  gbrain search <query>                     Keyword search (tsvector)
  gbrain query <question>                   Hybrid search (vector + keyword + RRF + expansion)

IMPORT/EXPORT
  gbrain import <dir> [--no-embed]          Import markdown directory (idempotent)
  gbrain sync [--repo <path>] [flags]       Git-to-brain incremental sync
  gbrain export [--dir ./out/]              Export to markdown (round-trip)

FILES
  gbrain files list [slug]                  List stored files
  gbrain files upload <file> --page <slug>  Upload file to storage
  gbrain files sync <dir>                   Bulk upload directory
  gbrain files verify                       Verify all uploads

EMBEDDINGS
  gbrain embed [<slug>|--all|--stale]       Generate/refresh embeddings

LINKS + GRAPH
  gbrain link <from> <to> [--type T]        Create typed link
  gbrain unlink <from> <to>                 Remove link
  gbrain backlinks <slug>                   Incoming links
  gbrain graph <slug> [--depth N]           Traverse link graph (recursive CTE, default depth 5)

TAGS
  gbrain tags <slug>                        List tags
  gbrain tag <slug> <tag>                   Add tag
  gbrain untag <slug> <tag>                 Remove tag

TIMELINE
  gbrain timeline [<slug>]                  View timeline entries
  gbrain timeline-add <slug> <date> <text>  Add timeline entry

ADMIN
  gbrain doctor [--json]                    Health checks (pgvector, RLS, schema, embeddings)
  gbrain stats                              Brain statistics
  gbrain health                             Health dashboard (embed coverage, stale, orphans)
  gbrain history <slug>                     Page version history
  gbrain revert <slug> <version-id>         Revert to previous version
  gbrain config [get|set] <key> [value]     Brain config
  gbrain serve                              MCP server (stdio, local)
  gbrain upgrade                            Self-update with feature discovery
  bun run src/commands/auth.ts              Token management (create/list/revoke/test)
  gbrain call <tool> '<json>'               Raw tool invocation
  gbrain --tools-json                       Tool discovery (JSON)
```

## Library and MCP details

See [GBrain without OpenClaw](#gbrain-without-openclaw) above for library usage examples, MCP server config, and skill file loading.

The `BrainEngine` interface is pluggable. See `docs/ENGINES.md` for how to add backends. 30 MCP tools are generated from the contract-first `operations.ts`. Parity tests verify structural identity between CLI, MCP, and tools-json.

## Skills

Fat markdown files that tell AI agents HOW to use gbrain. No skill logic in the binary.

| Skill | What it does |
|-------|-------------|
| **ingest** | Ingest meetings, docs, articles. Updates compiled truth (rewrite, not append), appends timeline, creates cross-reference links across all mentioned entities. |
| **query** | 3-layer search (keyword + vector + structured) with synthesis and citations. Says "the brain doesn't have info on X" rather than hallucinating. |
| **maintain** | Periodic health: find contradictions, stale compiled truth, orphan pages, dead links, tag inconsistency, missing embeddings, overdue threads. |
| **enrich** | Enrich pages from external APIs. Raw data stored separately, distilled highlights go to compiled truth. |
| **briefing** | Daily briefing: today's meetings with participant context, active deals with deadlines, time-sensitive threads, recent changes. |
| **migrate** | Universal migration from Obsidian (wikilinks to gbrain links), Notion (stripped UUIDs), Logseq (block refs), plain markdown, CSV, JSON, Roam. |
| **setup** | Set up GBrain from scratch: auto-provision Supabase via CLI, AGENTS.md injection, import, sync. Target TTHW < 2 min. |

## Engine Architecture

```
CLI / MCP Server
     (thin wrappers, identical operations)
              |
      BrainEngine interface
       (pluggable backend)
              |
      engine-factory.ts
       (dynamic imports)
              |
     +--------+--------+
     |                  |
PGLiteEngine       PostgresEngine
  (ships v0.7)       (ships v0)
     |                  |
~/.gbrain/brain.pglite  Supabase Pro ($25/mo)
  embedded PG 17.5    Postgres + pgvector + pg_trgm
  via @electric-sql    connection pooling via Supavisor
  /pglite

     gbrain migrate --to supabase/pglite
         (bidirectional migration)
```

Embedding, chunking, and search fusion are engine-agnostic. Only raw keyword search (`searchKeyword`) and raw vector search (`searchVector`) are engine-specific. RRF fusion, multi-query expansion, and 4-layer dedup run above the engine on `SearchResult[]` arrays. Both engines use the same SQL (PGLite runs real Postgres, not a separate dialect).

## Storage estimates

For a brain with ~7,500 pages:

| Component | Size |
|-----------|------|
| Page text (compiled_truth + timeline) | ~150MB |
| JSONB frontmatter + indexes | ~70MB |
| Content chunks (~22K, text) | ~80MB |
| Embeddings (22K x 1536 floats) | ~134MB |
| HNSW index overhead | ~270MB |
| Links, tags, timeline, versions | ~50MB |
| **Total** | **~750MB** |

Supabase free tier (500MB) won't fit a large brain. Supabase Pro ($25/mo, 8GB) is the starting point.

Initial embedding cost: ~$4-5 for 7,500 pages via OpenAI text-embedding-3-large.

## Docs

**For agents:**
- **[GBRAIN_SKILLPACK.md](docs/GBRAIN_SKILLPACK.md)** -- **Start here.** Index of all patterns, skills, and integrations
- [Individual guides](docs/guides/) -- 17 standalone guides broken out from the skillpack
- [Getting Data In](docs/integrations/README.md) -- Integration recipes, credential setup, data flow patterns
- [GBRAIN_VERIFY.md](docs/GBRAIN_VERIFY.md) -- Installation verification runbook

**For humans:**
- [GBRAIN_RECOMMENDED_SCHEMA.md](docs/GBRAIN_RECOMMENDED_SCHEMA.md) -- Brain repo directory structure
- [Infrastructure Layer](docs/architecture/infra-layer.md) -- How import, chunking, embedding, and search work
- [Thin Harness, Fat Skills](docs/ethos/THIN_HARNESS_FAT_SKILLS.md) -- Architecture philosophy
- [Homebrew for Personal AI](docs/ethos/MARKDOWN_SKILLS_AS_RECIPES.md) -- Why markdown is code

**Reference:**
- [GBRAIN_V0.md](docs/GBRAIN_V0.md) -- Full product spec, all architecture decisions
- [ENGINES.md](docs/ENGINES.md) -- Pluggable engine interface: PGLite (default) + Postgres, capability matrix, migration

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `bun test` for unit tests. For E2E tests
against real Postgres+pgvector: `docker compose -f docker-compose.test.yml up -d` then
`DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e`.

Welcome PRs for:

- New enrichment API integrations
- Performance optimizations
- Docker Compose for self-hosted Postgres
- Additional engine backends (DuckDB, Turso, etc.)

## License

MIT
