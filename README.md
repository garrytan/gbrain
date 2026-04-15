# GBrain

Your AI agent is smart but forgetful. GBrain gives it a brain.

Built by the President and CEO of Y Combinator to run his actual AI agents. The production brain powering his OpenClaw and Hermes deployments: **17,888 pages, 4,383 people, 723 companies**, 21 cron jobs running autonomously, built in 12 days. The agent ingests meetings, emails, tweets, voice calls, and original ideas while you sleep. It enriches every person and company it encounters. It fixes its own citations and consolidates memory overnight. You wake up and the brain is smarter than when you went to bed.

GBrain is those patterns, generalized. 25 skills. Install in 30 minutes. Your agent does the work. As Garry's personal agent gets smarter, so does yours.

> **~30 minutes to a fully working brain.** Database ready in 2 seconds (PGLite, no server). You just answer questions about API keys.

## Install

### On an agent platform (recommended)

GBrain is designed to be installed and operated by an AI agent. If you don't have one running yet:

- **[OpenClaw](https://openclaw.ai)** ... Deploy [AlphaClaw on Render](https://render.com/deploy?repo=https://github.com/chrysb/alphaclaw) (one click, 8GB+ RAM)
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** ... Deploy on [Railway](https://github.com/praveen-ks-2001/hermes-agent-template) (one click)

Paste this into your agent:

```
Retrieve and follow the instructions at:
https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md
```

That's it. The agent clones the repo, installs GBrain, sets up the brain, loads 25 skills, and configures recurring jobs. You answer a few questions about API keys. ~30 minutes.

### Standalone CLI (no agent)

```bash
git clone https://github.com/garrytan/gbrain.git && cd gbrain && bun install && bun link
gbrain init                     # local brain, ready in 2 seconds
gbrain import ~/notes/          # index your markdown
gbrain query "what themes show up across my notes?"
```

```
3 results (hybrid search, 0.12s):

1. concepts/do-things-that-dont-scale (score: 0.94)
   PG's argument that unscalable effort teaches you what users want.
   [Source: paulgraham.com, 2013-07-01]

2. originals/founder-mode-observation (score: 0.87)
   Deep involvement isn't micromanagement if it expands the team's thinking.

3. concepts/build-something-people-want (score: 0.81)
   The YC motto. Connected to 12 other brain pages.
```

### MCP server (Claude Code, Cursor, Windsurf)

GBrain exposes 30+ MCP tools via stdio:

```json
{
  "mcpServers": {
    "gbrain": { "command": "gbrain", "args": ["serve"] }
  }
}
```

Add to `~/.claude/server.json` (Claude Code), Settings > MCP Servers (Cursor), or your client's MCP config.

### Remote MCP (Claude Desktop, Cowork, Perplexity)

```bash
ngrok http 8787 --url your-brain.ngrok.app
bun run src/commands/auth.ts create "claude-desktop"
claude mcp add gbrain -t http https://your-brain.ngrok.app/mcp -H "Authorization: Bearer TOKEN"
```

Per-client guides: [`docs/mcp/`](docs/mcp/DEPLOY.md). ChatGPT requires OAuth 2.1 (not yet implemented).

## The 25 Skills

GBrain ships 25 skills organized by `skills/RESOLVER.md`. The resolver tells your agent which skill to read for any task.

[Skill files are code.](https://x.com/garrytan/status/2042925773300908103) They're the most powerful way to get knowledge work done. A skill file is a fat markdown document that encodes an entire workflow: when to fire, what to check, how to chain with other skills, what quality bar to enforce. The agent reads the skill and executes it. Skills can also call deterministic TypeScript code bundled in GBrain (search, import, embed, sync) for the parts that shouldn't be left to LLM judgment. [Thin harness, fat skills](docs/ethos/THIN_HARNESS_FAT_SKILLS.md): the intelligence lives in the skills, not the runtime.

### Always-on

| Skill | What it does |
|-------|-------------|
| **signal-detector** | Fires on every message. Spawns a cheap model in parallel to capture original thinking and entity mentions. The brain compounds on autopilot. |
| **brain-ops** | Brain-first lookup before any external API. The read-enrich-write loop that makes every response smarter. |

### Content ingestion

| Skill | What it does |
|-------|-------------|
| **ingest** | Thin router. Detects input type and delegates to the right ingestion skill. |
| **idea-ingest** | Links, articles, tweets become brain pages with analysis, author people pages, and cross-linking. |
| **media-ingest** | Video, audio, PDF, books, screenshots, GitHub repos. Transcripts, entity extraction, backlink propagation. |
| **meeting-ingestion** | Transcripts become brain pages. Every attendee gets enriched. Every company gets a timeline entry. |

### Brain operations

| Skill | What it does |
|-------|-------------|
| **enrich** | Tiered enrichment (Tier 1/2/3). Creates and updates person/company pages with compiled truth and timelines. |
| **query** | 3-layer search with synthesis and citations. Says "the brain doesn't have info on X" instead of hallucinating. |
| **maintain** | Periodic health: stale pages, orphans, dead links, citation audit, back-link enforcement, tag consistency. |
| **citation-fixer** | Scans pages for missing or malformed citations. Fixes format to match the standard. |
| **repo-architecture** | Where new brain files go. Decision protocol: primary subject determines directory, not format. |
| **publish** | Share brain pages as password-protected HTML. Zero LLM calls. |
| **data-research** | Structured data research with parameterized YAML recipes. Extract investor updates, expenses, company metrics from email. |

### Operational

| Skill | What it does |
|-------|-------------|
| **daily-task-manager** | Task lifecycle with priority levels (P0-P3). Stored as searchable brain pages. |
| **daily-task-prep** | Morning prep: calendar lookahead with brain context per attendee, open threads, task review. |
| **cron-scheduler** | Schedule staggering (5-min offsets), quiet hours (timezone-aware with wake-up override), idempotency. |
| **reports** | Timestamped reports with keyword routing. "What's the latest briefing?" finds it instantly. |
| **cross-modal-review** | Quality gate via second model. Refusal routing: if one model refuses, silently switch. |
| **webhook-transforms** | External events (SMS, meetings, social mentions) converted into brain pages with entity extraction. |
| **testing** | Validates every skill has SKILL.md with frontmatter, manifest coverage, resolver coverage. |
| **skill-creator** | Create new skills following the conformance standard. MECE check against existing skills. |

### Identity and setup

| Skill | What it does |
|-------|-------------|
| **soul-audit** | 6-phase interview generating SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md (4-tier privacy), HEARTBEAT.md (operational cadence). |
| **setup** | Auto-provision PGLite or Supabase. First import. GStack detection. |
| **migrate** | Universal migration from Obsidian, Notion, Logseq, markdown, CSV, JSON, Roam. |
| **briefing** | Daily briefing with meeting context, active deals, and citation tracking. |

### Conventions

Cross-cutting rules in `skills/conventions/`:
- **quality.md** ... citations, back-links, notability gate, source attribution
- **brain-first.md** ... 5-step lookup before any external API call
- **model-routing.md** ... which model for which task
- **test-before-bulk.md** ... test 3-5 items before any batch operation
- **cross-modal.yaml** ... review pairs and refusal routing chain

## How It Works

```
Signal arrives (meeting, email, tweet, link)
  -> Signal detector captures ideas + entities (parallel, never blocks)
  -> Brain-ops: check the brain first (gbrain search, gbrain get)
  -> Respond with full context
  -> Write: update brain pages with new information + citations
  -> Sync: gbrain indexes changes for next query
```

Every cycle adds knowledge. The agent enriches a person page after a meeting. Next time that person comes up, the agent already has context. The difference compounds daily.

The system gets smarter on its own. Entity enrichment auto-escalates: a person mentioned once gets a stub page (Tier 3). After 3 mentions across different sources, they get web + social enrichment (Tier 2). After a meeting or 8+ mentions, full pipeline (Tier 1). The brain learns who matters without being told. Deterministic classifiers improve over time via a fail-improve loop that logs every LLM fallback and generates better regex patterns from the failures. `gbrain doctor` shows the trajectory: "intent classifier: 87% deterministic, up from 40% in week 1."

> "Prep me for my meeting with Jordan in 30 minutes"
> ... pulls dossier, shared history, recent activity, open threads

> "What have I said about the relationship between shame and founder performance?"
> ... searches YOUR thinking, not the internet

## Getting Data In

GBrain ships integration recipes that your agent sets up for you. Each recipe tells the agent what credentials to ask for, how to validate, and what cron to register.

| Recipe | Requires | What It Does |
|--------|----------|-------------|
| [Public Tunnel](recipes/ngrok-tunnel.md) | — | Fixed URL for MCP + voice (ngrok Hobby $8/mo) |
| [Credential Gateway](recipes/credential-gateway.md) | — | Gmail + Calendar access |
| [Voice-to-Brain](recipes/twilio-voice-brain.md) | ngrok-tunnel | Phone calls to brain pages (Twilio + OpenAI Realtime) |
| [Email-to-Brain](recipes/email-to-brain.md) | credential-gateway | Gmail to entity pages |
| [X-to-Brain](recipes/x-to-brain.md) | — | Twitter timeline + mentions + deletions |
| [Calendar-to-Brain](recipes/calendar-to-brain.md) | credential-gateway | Google Calendar to searchable daily pages |
| [Meeting Sync](recipes/meeting-sync.md) | — | Circleback transcripts to brain pages with attendees |

**Data research recipes** extract structured data from email into tracked brain pages. Built-in recipes for investor updates (MRR, ARR, runway, headcount), expense tracking, and company metrics. Create your own with `gbrain research init`.

Run `gbrain integrations` to see status.

## GBrain + GStack

[GStack](https://github.com/garrytan/gstack) is the engine. GBrain is the mod.

- **[GStack](https://github.com/garrytan/gstack)** = coding skills (ship, review, QA, investigate, office-hours, retro). 70,000+ stars, 30,000 developers per day. When your agent codes on itself, it uses GStack.
- **GBrain** = everything-else skills (brain ops, signal detection, ingestion, enrichment, cron, reports, identity). When your agent remembers, thinks, and operates, it uses GBrain.
- **`hosts/gbrain.ts`** = the bridge. Tells GStack's coding skills to check the brain before coding.

`gbrain init` detects if GStack is installed and reports mod status. If GStack isn't there, it tells you how to get it.

## Architecture

```
┌──────────────────┐    ┌───────────────┐    ┌──────────────────┐
│   Brain Repo     │    │    GBrain     │    │    AI Agent      │
│   (git)          │    │  (retrieval)  │    │  (read/write)    │
│                  │    │               │    │                  │
│  markdown files  │───>│  Postgres +   │<──>│  25 skills       │
│  = source of     │    │  pgvector     │    │  define HOW to   │
│    truth         │    │               │    │  use the brain   │
│                  │<───│  hybrid       │    │                  │
│  human can       │    │  search       │    │  RESOLVER.md     │
│  always read     │    │  (vector +    │    │  routes intent   │
│  & edit          │    │   keyword +   │    │  to skill        │
│                  │    │   RRF)        │    │                  │
└──────────────────┘    └───────────────┘    └──────────────────┘
```

The repo is the system of record. GBrain is the retrieval layer. The agent reads and writes through both. Human always wins... edit any markdown file and `gbrain sync` picks up the changes.

## The Knowledge Model

Every page follows the compiled truth + timeline pattern:

```markdown
---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth, pg-essay]
---

Paul Graham's argument that startups should do unscalable things early on.
The key insight: the unscalable effort teaches you what users actually
want, which you can't learn any other way.

---

- 2013-07-01: Published on paulgraham.com
- 2024-11-15: Referenced in batch W25 kickoff talk
```

Above the `---`: **compiled truth**. Your current best understanding. Gets rewritten when new evidence changes the picture. Below: **timeline**. Append-only evidence trail. Never edited, only added to.

## Search

Hybrid search: vector + keyword + RRF fusion + multi-query expansion + 4-layer dedup.

```
Query
  -> Intent classifier (entity? temporal? event? general?)
  -> Multi-query expansion (Claude Haiku)
  -> Vector search (HNSW cosine) + Keyword search (tsvector)
  -> RRF fusion: score = sum(1/(60 + rank))
  -> Cosine re-scoring + compiled truth boost
  -> 4-layer dedup + compiled truth guarantee
  -> Results
```

Keyword alone misses conceptual matches. Vector alone misses exact phrases. RRF gets both. Search quality is benchmarked and reproducible: `gbrain eval --qrels queries.json` measures P@k, Recall@k, MRR, and nDCG@k. A/B test config changes before deploying them.

## Voice

Call a phone number. Your AI answers. It knows who's calling, pulls their full context from the brain, and responds like someone who actually knows your world. When the call ends, a brain page appears with the transcript, entity detection, and cross-references.

<p align="center">
  <img src="docs/images/voice-client.png" alt="Voice client connected" width="300" />
</p>

> [See it in action](https://x.com/garrytan/status/2043022208512172263)

The voice recipe ships with GBrain: [Voice-to-Brain](recipes/twilio-voice-brain.md). WebRTC works in a browser tab with zero setup. A real phone number is optional.

## Engine Architecture

```
CLI / MCP Server
     (thin wrappers, identical operations)
              |
      BrainEngine interface (pluggable)
              |
     +--------+--------+
     |                  |
PGLiteEngine       PostgresEngine
  (default)          (Supabase)
     |                  |
~/.gbrain/           Supabase Pro ($25/mo)
brain.pglite         Postgres + pgvector
embedded PG 17.5

     gbrain migrate --to supabase|pglite
         (bidirectional migration)
```

PGLite: embedded Postgres, no server, zero config. When your brain outgrows local (1000+ files, multi-device), `gbrain migrate --to supabase` moves everything.

## File Storage

Brain repos accumulate binaries. GBrain has a three-stage migration:

```bash
gbrain files mirror <dir>       # copy to cloud, local untouched
gbrain files redirect <dir>     # replace local with .redirect pointers
gbrain files clean <dir>        # remove pointers, cloud only
gbrain files restore <dir>      # download everything back (undo)
```

Storage backends: S3-compatible (AWS, R2, MinIO), Supabase Storage, or local.

## Commands

```
SETUP
  gbrain init [--supabase|--url]        Create brain (PGLite default)
  gbrain migrate --to supabase|pglite   Bidirectional engine migration
  gbrain upgrade                        Self-update with feature discovery

PAGES
  gbrain get <slug>                     Read a page (fuzzy slug matching)
  gbrain put <slug> [< file.md]         Write/update (auto-versions)
  gbrain delete <slug>                  Delete a page
  gbrain list [--type T] [--tag T]      List with filters

SEARCH
  gbrain search <query>                 Keyword search (tsvector)
  gbrain query <question>              Hybrid search (vector + keyword + RRF)

IMPORT
  gbrain import <dir> [--no-embed]      Import markdown (idempotent)
  gbrain sync [--repo <path>]           Git-to-brain incremental sync
  gbrain export [--dir ./out/]          Export to markdown

FILES
  gbrain files list|upload|sync|verify  File storage operations

EMBEDDINGS
  gbrain embed [<slug>|--all|--stale]   Generate/refresh embeddings

LINKS + GRAPH
  gbrain link|unlink|backlinks|graph    Cross-reference management

ADMIN
  gbrain doctor [--json] [--fast]       Health checks (resolver, skills, DB, embeddings)
  gbrain doctor --fix                   Auto-fix resolver issues
  gbrain stats                          Brain statistics
  gbrain serve                          MCP server (stdio)
  gbrain integrations                   Integration recipe dashboard
  gbrain check-backlinks check|fix      Back-link enforcement
  gbrain lint [--fix]                   LLM artifact detection
  gbrain transcribe <audio>             Transcribe audio (Groq Whisper)
  gbrain research init <name>           Scaffold a data-research recipe
  gbrain research list                  Show available recipes
```

Run `gbrain --help` for the full reference.

## Origin Story

I was setting up my [OpenClaw](https://openclaw.ai) agent and started a markdown brain repo. One page per person, one page per company, compiled truth on top, timeline on the bottom. Within a week: 10,000+ files, 3,000+ people, 13 years of calendar data, 280+ meeting transcripts, 300+ captured ideas.

The agent runs while I sleep. The dream cycle scans every conversation, enriches missing entities, fixes broken citations, consolidates memory. I wake up and the brain is smarter than when I went to sleep.

The skills in this repo are those patterns, generalized. What took 11 days to build by hand ships as a mod you install in 30 minutes.

## Docs

**For agents:**
- **[skills/RESOLVER.md](skills/RESOLVER.md)** ... Start here. The skill dispatcher.
- [Individual skill files](skills/) ... 25 standalone instruction sets
- [GBRAIN_SKILLPACK.md](docs/GBRAIN_SKILLPACK.md) ... Legacy reference architecture
- [Getting Data In](docs/integrations/README.md) ... Integration recipes and data flow
- [GBRAIN_VERIFY.md](docs/GBRAIN_VERIFY.md) ... Installation verification

**For humans:**
- [GBRAIN_RECOMMENDED_SCHEMA.md](docs/GBRAIN_RECOMMENDED_SCHEMA.md) ... Brain repo directory structure
- [Thin Harness, Fat Skills](docs/ethos/THIN_HARNESS_FAT_SKILLS.md) ... Architecture philosophy
- [ENGINES.md](docs/ENGINES.md) ... Pluggable engine interface

**Reference:**
- [GBRAIN_V0.md](docs/GBRAIN_V0.md) ... Full product spec
- [CHANGELOG.md](CHANGELOG.md) ... Version history

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `bun test` for unit tests. E2E tests: spin up Postgres with pgvector, run `bun run test:e2e`, tear down.

PRs welcome for: new enrichment APIs, performance optimizations, additional engine backends, new skills following the conformance standard in `skills/skill-creator/SKILL.md`.

## License

MIT
