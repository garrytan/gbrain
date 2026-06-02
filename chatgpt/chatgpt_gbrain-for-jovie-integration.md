---
title: "GBrain for Jovie Integration"
type: essay
created: 2026-05-27
updated: 2026-05-27
source: chatgpt-export
conversation_id: 6a165a0c-757c-83e8-9420-719327319ff1
message_count: 15
tags: [chatgpt, import, code, long-form]
---
# GBrain for Jovie Integration

> Conversation ID: 6a165a0c-757c-83e8-9420-719327319ff1
> Created: 2026-05-27T02:42:21Z
> Updated: 2026-05-27T03:07:09Z
> Messages: 15

---

## User

gbrain

---

## Assistant

urlGBrain GitHubhttps://github.com/garrytan/gbrain is Garry Tan’s open-source “brain” layer for AI agents — effectively a persistent memory + knowledge graph system for long-running agents like Hermes/OpenClaw. citeturn0search7turn0search0

For Jovie specifically, GBrain is relevant because your product thesis is fundamentally:

- persistent artist context
- relationship memory
- lifecycle/event memory
- cross-platform identity resolution
- proactive suggestions
- long-term compounding behavior

That maps almost perfectly to a graph-memory architecture.

Core concepts in GBrain:
- Markdown-native entity storage
- Hybrid retrieval (vector + structured graph)
- Entity-centric memory (`people/`, `companies/`, `concepts/`, etc.)
- Continuous enrichment loops
- MCP-compatible tooling
- Local-first with Postgres/pgvector scaling path citeturn0search6turn0search7

For Jovie, the equivalent entities become:
- artists
- collaborators
- tracks
- releases
- events
- venues
- fans
- campaigns
- merch drops
- milestones
- cultural moments
- memories/photos/videos
- opportunities

Example:
```txt
artist/
  deadmau5.md
release/
  ghosts-n-stuff.md
event/
  edc-2026.md
relationship/
  deadmau5-x-rob-swire.md
moment/
  10-year-anniversary-ghosts-n-stuff.md
```

Then the agent can reason:
- “This song’s anniversary is next Friday”
- “Fan engagement spikes every time acoustic content drops”
- “This collaborator birthday historically performs well”
- “EDC audience overlaps with prior merch buyers”
- “You met Randy Jackson 3 years ago today”

That is where graph memory becomes materially more powerful than plain RAG/chat history.

My recommendation for Jovie:

## Near-term
Do NOT overengineer memory yet.

Use:
- Postgres
- pgvector
- structured relational tables
- lightweight embeddings
- event logs
- deterministic triggers

This gets you 80% there.

You already have natural graph structure:
- artists ↔ releases
- artists ↔ collaborators
- fans ↔ actions
- releases ↔ campaigns
- songs ↔ anniversaries

A clean relational schema plus embeddings is enough initially.

## Medium-term
Introduce:
- entity memory layer
- timeline/event memory
- relationship scoring
- opportunity graph

This is where a GBrain-like layer becomes valuable.

Especially:
- “career memory”
- “fan memory”
- “relationship memory”
- “context continuity”

## Long-term
You likely want:
- operational DB
- plus graph-memory layer
- plus vector retrieval
- plus event stream

Not “everything in vector DB.”

Likely architecture:
```txt
Postgres = source of truth
pgvector = semantic retrieval
Graph layer = relationships/reasoning
Object storage = media/artifacts
Event bus = triggers/automation
```

I would not use:
- pure vector memory
- pure markdown repos
- Obsidian-style PKM systems

for core production artist memory.

Those are excellent for agent operators and founders internally. Less ideal for a multi-tenant production SaaS.

For internal Jovie ops/HUD though? GBrain is actually a very strong fit.

Especially for:
- accelerator applications
- investor memory
- roadmap continuity
- changelog intelligence
- GTM research
- artist relationship tracking
- autonomous agent coordination

You could realistically run your internal “Chief of Staff” stack on GBrain/Hermes while keeping customer-facing Jovie memory in structured infra.

Biggest insight:
The future moat is not “AI generates content.”

The moat is:
- persistent context
- relationship continuity
- temporal memory
- compounding identity graph
- execution history
- fan behavioral memory

That is the actual “artist operating system.”

---

## User




Step-by-step walkthroughs for getting the most out of GBrain. Each one takes you from zero to a working outcome, with concrete commands and real numbers.

Set up your personal AI agent + brain from zero — the canonical full-stack install. Two GitHub repos, a Telegram bot, AlphaClaw on Render, OpenClaw + GBrain + Supabase. End-to-end in about 2 hours.
Set up GBrain as your company brain — federated, multi-user, OAuth-scoped institutional memory for a 10-50 person team. About 90 minutes end-to-end.
More walkthroughs in progress: connecting an existing agent (Claude Code, Cursor, OpenClaw, Hermes) to a GBrain memory layer; setting up GBrain for VC dealflow with founder scorecards and meeting prep; migrating an existing Notion or Obsidian vault; indexing a codebase as a queryable code brain. Full tutorial index: docs/tutorials/.

---

## Assistant

This is the important part for you, Mr. White:

GBrain is no longer just “vector memory.” It is becoming an operational substrate for autonomous agents. The architecture aligns almost perfectly with where Jovie is headed. citeturn0search1turn0search0turn0search5

The stack they are converging on is essentially:

```txt
Telegram / UI
        ↓
AlphaClaw (deployment harness)
        ↓
OpenClaw / Hermes (agent runtime)
        ↓
GBrain (memory + graph + skills)
        ↓
Supabase / pgvector (retrieval layer)
```

For Jovie, the equivalent becomes:

```txt
Jovie App
      ↓
Jovie Agents
      ↓
Artist Brain
      ↓
Timeline / Relationship Graph
      ↓
Embeddings + Structured DB
```

Key insight:
you should probably separate:

1. Internal founder/company brain
2. Customer-facing artist memory

Those are different systems.

# What I would do for Jovie

## Layer 1 — Operational truth
Use:
- Postgres
- Drizzle
- pgvector
- structured relational data

This remains the source of truth.

Examples:
```txt
artists
releases
campaigns
fans
events
merch
relationships
notifications
```

This is your production SaaS data.

---

## Layer 2 — Event/timeline memory
This is the actual moat.

Store:
- anniversaries
- interactions
- release history
- collaborator relationships
- cultural moments
- engagement spikes
- audience reactions
- touring patterns
- fan cohorts
- personal memories
- photos/videos
- milestones

This becomes the “artist career graph.”

---

## Layer 3 — Agent cognition
This is where GBrain concepts become useful.

Not necessarily GBrain itself.

But:
- entity memory
- auto-linking
- relationship inference
- timeline stitching
- cron enrichment
- opportunity detection
- persistent context

That part is extremely aligned with Jovie.

---

# The most important thing in the tutorials

This line:

> “The brain reads them for you and writes the answer.” citeturn0search8turn0search1

That is the shift.

Traditional SaaS:
- database
- dashboard
- search

Agentic SaaS:
- memory
- context
- synthesis
- proactive execution

That is what Jovie actually is.

---

# The strongest Jovie implementation

Not:
“AI music tools.”

Instead:

```txt
Persistent artist operating memory.
```

Example:

```txt
Artist:
RUFUS DU SOL

Known:
- Last merch spike happened during Coachella
- Fans engage most with analog synth studio clips
- Acoustic edits outperform remixes on TikTok
- Collaborator birthdays drive above-average engagement
- Purple/black visuals correlate with higher CTR
- NYC fan cluster converts best to vinyl
- Last release cadence gap longer than 45 days hurt Spotify velocity
```

Now the agent can reason continuously.

That is much harder to replace than:
“generate a t-shirt.”

---

# My actual recommendation

## Short term
Do NOT deploy full GBrain architecture to production users yet.

You are still:
- iterating fast
- changing schemas
- changing product direction
- changing workflows

A giant autonomous memory graph becomes operational drag too early.

---

## Instead

Build:
- deterministic event memory
- timeline system
- relationship tables
- embeddings
- lightweight retrieval

Then expose that through:
- agents
- tasks
- suggestions
- automations

---

# Where GBrain *is* immediately useful

Internal Jovie ops.

Very strong fit for:
- fundraising memory
- YC application continuity
- investor tracking
- GTM research
- artist outreach memory
- changelog intelligence
- autonomous cron agents
- internal SOP memory
- roadmap continuity
- “Chief of Staff” orchestration

That use case is nearly perfect today.

---

# The biggest architectural lesson from GBrain

The graph matters more than the vector DB.

Most startups overfocus on:
- embeddings
- semantic search
- RAG

The real moat is:
- entities
- relationships
- timelines
- causality
- persistent identity
- historical context

That is why the “artist brain” concept is powerful.

Because careers are graph-shaped, not chat-shaped.

Relevant links:

- urlGBrain GitHubhttps://github.com/garrytan/gbrain
- urlPersonal Brain Tutorialhttps://github.com/garrytan/gbrain/blob/master/docs/tutorials/personal-brain.md
- urlCompany Brain Tutorialhttps://github.com/garrytan/gbrain/blob/master/docs/tutorials/company-brain.md
- urlRender OpenClaw + GBrain Templatehttps://github.com/render-examples/openclaw-gbrain

---

## User

So just for context, right now I am purely working on our internal setup to run the company. Obviously, we want to eventually extract these principles and help it inform how we build Jovie itself to help artists run their companies. Right now, we want to just run our company really well with this, so help me out.

I'm trying to figure out how best to use this, so we're using Aramys agent instead of Open Claw. My question now is, are we better off going to Open Claw, or are we better off using Aramys agent?  
  
We have the MacBook Air and Tailscale, and they connect to each other. Do we run g-brane on both, or do we run g-brane on one? Should we set up a company brain or a personal brain? The company right now is only one person, obviously, but eventually it'll be more. Do we need this Open Claw on render or alpha claw harness thing, or not? Should we use Aramys agent or Open Claw? We've previously been using Aramys agent. Should we use it with g-brane in super base? Do we need super base, or does that benefit us or whatnot?  
  
Right now we just need to be accessible locally. The other hack I'm doing is I want to report voice memos when I take walks and stuff, and I want those voice memos to automatically sync. They already do with Apple, and they will automatically sync them to both machines and it will automatically transcribe them. We just want to automate the transcriptions getting ingested into g-brane and all of that knowledge being used to inform things. If I mention an issue or something in linear, then it would open up an issue and our coding agent would radically tackle it and all that kind of shit, you know what I mean.  
  
We have Wispr Flow, and Wispr Flow has memory and stuff too. Should we use our own database for vector search, or I don't really know anything about this vector search brain memory stuff? Should we use Honcho? Is Honcho better? Should we host Honcho locally?  
  
Help me think about all these things. I guess the main thing is I like g-brane because it's YC, so I know that it's going to be kind of built and continue to be worked on by YC companies. We will probably contribute back to it and stuff, so I know it's going to be built for the forefront of startups that are moving quickly. That's why I am leaning on g-brane and G Stack more than other things, but I also want to use the best thing it's going to get us moving the fastest. It's very important that all our company knowledge lives in a central database, so just help me figure out what the setup is.

---

## Assistant

Mr. White, your instincts are mostly correct already.

You are not building:
- “AI chat with memory”

You are building:
- an operational cognition layer for a startup

That means the architecture priorities are:

1. reliability
2. low friction
3. compounding memory
4. structured retrieval
5. agent interoperability
6. cheap iteration
7. local-first development

Not:
- enterprise scalability
- multi-tenant SaaS infra
- distributed cloud orchestration

yet.

So your setup should stay MUCH simpler than the full “Garry Tan demo stack.”

---

# Short answer

## What I would do right now

Use:
- Hermes/Aramys Agent
- GBrain
- Supabase
- pgvector
- one shared company brain
- MacBook Air as always-on “brain server”
- Tailscale
- local-first deployment

Do NOT:
- migrate to OpenClaw yet
- deploy AlphaClaw
- deploy Render
- overbuild infra
- use Honcho
- run multiple brains
- host complicated vector infra yourself

Yet.

---

# Your actual architecture

This is probably your ideal setup TODAY:

```txt id="q7sl5n"
MacBook Air (always-on)
│
├── GBrain MCP server
├── Supabase sync
├── pgvector retrieval
├── cron ingestion jobs
├── voice memo ingestion
├── Linear automation
├── GitHub automation
└── Tailscale access
       │
       ▼
Main MacBook Pro
│
├── Claude Code
├── Codex
├── Hermes
├── Wispr Flow
├── Cursor
└── internal tools
```

The Air becomes:
```txt id="ghg63x"
The memory + automation node.
```

The MBP becomes:
```txt id="58dwhs"
The execution workstation.
```

That is the correct split.

---

# Biggest mistake to avoid

Do NOT run separate brains on separate machines.

You want:
```txt id="4pdqyf"
ONE canonical company brain.
```

Not:
```txt id="yb8zwr"
Tim brain
MacBook Air brain
Hermes brain
OpenClaw brain
```

That becomes catastrophic entropy.

---

# Company brain vs personal brain

You want:
## Company brain

Even though you are solo.

Because the data model you want is:
- institutional memory
- project memory
- roadmap memory
- investor memory
- GTM memory
- release memory
- coding decisions
- architecture rationale
- customer intelligence
- research
- ops

NOT:
- personal journaling
- life notes
- random PKM

You are effectively building:
```txt id="c4z4r2"
Jovie Operating System
```

internally first.

---

# Should you use OpenClaw?

## My answer:
No. Not yet.

OpenClaw is opinionated around:
- orchestration
- harnessing
- skills
- runtime management

You already have:
- Hermes
- Claude Code
- Codex
- GStack
- MCP workflows

Your bottleneck is NOT:
```txt id="uyk0ik"
agent runtime orchestration
```

Your bottleneck is:
```txt id="x6twci"
persistent organizational memory
```

So fix memory first.

---

# Should you use AlphaClaw?

No.

Not locally.

AlphaClaw exists primarily for:
- hosted deployment
- remote runtime management
- team access
- Telegram agent workflows
- cloud orchestration

You do not need that.

Your MacBook Air IS your AlphaClaw right now.

---

# Should you use Supabase?

YES.

Strong yes.

Not because “cloud vector DB magic.”

Because:
- pgvector works
- Postgres works
- stable ecosystem
- easy backups
- easy querying
- easy migration
- easy debugging
- works with everything
- future production compatibility

GBrain itself strongly assumes this direction for larger/shared brains. citeturn0search0turn0search1

---

# Why NOT local-only vector DB

You absolutely do not want:
- Chroma
- random SQLite vector DBs
- weird local-only memory stores
- embedded proprietary formats

You will regret it.

You want:
```txt id="9o1z4p"
Postgres + pgvector
```

because:
- every tool supports it
- every agent stack supports it
- easy exports
- SQL access
- inspectable
- durable
- composable

---

# Should you use Honcho?

No.

At least not now.

Honcho is:
- more abstracted
- more agent-memory-oriented
- less transparent
- less graph-centric
- less operationally inspectable

Your use case requires:
- visibility
- structured memory
- graph relationships
- deterministic retrieval
- inspectable storage

GBrain is actually closer to your operating philosophy.

---

# Should Wispr Flow memory matter?

No.

Treat Wispr memory like:
```txt id="7yrmww"
autocomplete convenience memory
```

NOT:
```txt id="1rm2iw"
canonical company intelligence
```

You want ONE source of truth.

Otherwise:
- fragmentation
- conflicting memories
- duplicated embeddings
- inconsistent retrieval
- agent hallucinations

---

# Your voice memo pipeline

THIS is actually one of your strongest ideas.

You should absolutely build this.

Architecture:

```txt id="5s7z6v"
Apple Voice Memos
        ↓
iCloud sync
        ↓
MacBook Air watcher
        ↓
Transcription parser
        ↓
Entity extraction
        ↓
GBrain ingest
        ↓
Task extraction
        ↓
Linear/GitHub issue generation
        ↓
Agent execution
```

That is VERY strong.

That is exactly the kind of “ambient cognition layer” that becomes a moat.

---

# What should be embedded?

Do NOT embed everything.

Very important.

You want layers:

## Layer 1 — Structured operational DB
Examples:
- issues
- releases
- roadmap items
- architecture decisions
- investor notes
- contacts
- prompts
- skills
- SOPs

Relational first.

---

## Layer 2 — Semantic retrieval
Examples:
- transcripts
- brainstorms
- meeting notes
- voice memos
- research
- docs

These get embeddings.

---

## Layer 3 — Graph memory
Examples:
- Tim ↔ Randy Jackson
- artist ↔ collaborator
- feature ↔ bug
- investor ↔ intro source
- issue ↔ architecture rationale

This becomes relationship intelligence.

That is the important layer long term.

---

# What GBrain is ACTUALLY good at

Not:
```txt id="m2k18m"
chatbot memory
```

Good at:
```txt id="6h01qm"
institutional graph memory
```

That aligns VERY closely with your long-term thesis.

---

# What I would implement this week

## Phase 1
Do THIS ONLY:

### Machine setup
- MacBook Air always-on node
- Tailscale
- GBrain
- Supabase
- pgvector

### Ingestion
- voice memos
- Linear
- GitHub
- meeting notes
- docs

### Retrieval
- MCP access from:
  - Claude Code
  - Codex
  - Hermes
  - Cursor

### Automation
- issue extraction
- TODO extraction
- architecture note linking

That alone is massive leverage.

---

# What NOT to do yet

Avoid:
- Telegram bots
- OpenClaw migration
- AlphaClaw
- multi-agent swarms
- custom vector infrastructure
- self-hosting Postgres
- distributed memory clusters
- advanced RAG tuning
- graph databases

Keep it boring.

---

# The biggest conceptual shift

Your company is becoming:
```txt id="w99ivv"
an accumulating memory system
```

not:
```txt id="i0hmg9"
a set of chats
```

That distinction matters enormously.

The companies that win in the agent era will likely have:
- persistent operational memory
- timeline intelligence
- relationship graphs
- autonomous execution loops
- compounding organizational context

You are correctly aiming at that layer early.

---

## User

The Alpha Claw thing. Yeah, but if you actually look at it, can you actually go and search the GBrain set ups, because it does mention personal brain versus company brain? And also, just really look at these and decide if we would benefit from... Do we really not? Also, if we use Supabase, then how does that work? Do we have to pay for that? 

---

## Assistant

I’ll verify the current GBrain docs rather than infer from memory, then give you a concrete setup decision: AlphaClaw/OpenClaw/Aramys, personal vs company brain, and Supabase cost/role.

---

## Assistant

I found the key distinction: GBrain’s own docs say personal/company is about access and source topology, while local/remote is a separate deployment topology. Your two-Mac + Tailscale setup maps most closely to their “cross-machine thin client” model, not the full Render/AlphaClaw tutorial.

---

## Assistant

Mr. White, after looking at the actual GBrain docs: my answer changes slightly.

You **do benefit from the company-brain model**, but you probably **do not need the full AlphaClaw + OpenClaw + Render path yet**.

# Recommended setup

```txt
MacBook Air = canonical brain host + ingestion daemon
MacBook Pro = thin client + execution workstation
Supabase = shared Postgres/pgvector backend if you want durable multi-machine memory
Aramys/Hermes = keep as current agent runtime
OpenClaw/AlphaClaw = optional later gateway, not core requirement
```

## 1. Personal brain vs company brain

Use a **company brain** now.

GBrain’s docs define a **brain** as the database and a **source** as a named repo/folder inside that database. Their rule of thumb is: if the data owner changes, use a different brain; if the same owner has different topics/repos, use different sources. For Jovie, the owner is the company, even if the company is currently just you. So make **one Jovie company brain** with multiple sources. citeturn380656view0

Structure it like this:

```txt
brain: jovie-company

sources:
  canon
  voice-memos
  product
  engineering
  gtm
  fundraising
  investors
  meetings
  linear-github
  agents-sops
```

This keeps the future team path clean without creating separate “Tim brain,” “MacBook brain,” and “agent brain” chaos.

## 2. Run GBrain on one machine, not both

Run the real GBrain host on the **MacBook Air**.

Install the CLI on both machines if useful, but only the Air should own the canonical DB, ingestion, autopilot, and HTTP MCP server. The MBP should connect as a thin client. GBrain’s own topology docs call this **cross-machine thin client**: one brain host runs `gbrain serve --http`, other machines connect over HTTP MCP and do not create their own local DB. citeturn706928view0

Your version:

```txt
MacBook Air
  ├── gbrain serve --http
  ├── Supabase or PGLite backend
  ├── iCloud voice memo watcher
  ├── transcript ingestion
  ├── Linear/GitHub automation
  └── autopilot / enrichment

MacBook Pro
  ├── Aramys/Hermes
  ├── Claude Code
  ├── Codex
  ├── Cursor
  └── GBrain MCP thin client over Tailscale
```

This is cleaner than running two brains and trying to sync them.

## 3. Supabase: yes, probably

Use **Supabase if you want this to become real company infrastructure**.

GBrain can start with PGLite locally, and its install docs say you can migrate later with `gbrain migrate --to supabase`. The docs specifically suggest Supabase/Postgres for larger repos, shared deployments, multi-machine use, and HTTP MCP/OAuth setups. citeturn164295view0

Given your goals:

- two machines
- one canonical company database
- future team access
- voice memo ingestion
- Linear/GitHub automation
- long-term institutional memory

Supabase is the right default unless the cost is painful right now.

## 4. Supabase cost

Supabase has a free tier, but a real always-on company brain will likely end up on **Pro**.

Official Supabase docs say each organization has one plan, you get two active free projects, paid orgs cannot mix free and paid projects, and each project gets a dedicated Supabase instance. Their billing example shows a **$25 Pro plan**, default compute credit, and extra default projects adding roughly **$10/month each**. citeturn567760view1

Practical expectation:

```txt
Free: possible for testing
Pro: likely $25/month for one serious project
Extra projects: roughly +$10/month each on default compute
Usage overages: possible if you exceed quotas
Tax: possible depending on billing address
```

Supabase also has spend caps on Pro by default, so you can keep usage from silently exploding. citeturn567760view1

My call: use **one Supabase project** for `jovie-company-brain`. Avoid multiple projects.

## 5. AlphaClaw: useful, but optional

AlphaClaw is a harness/fleet manager for OpenClaw. It gives you setup UI, watchdog, crash recovery, Git backup, multi-agent management, Google Workspace setup, webhooks, cron visibility, and local-node routing. citeturn452415view0

That is useful if your main goal is:

```txt
I want a hosted OpenClaw assistant reachable from Telegram/Slack/etc.
I want watchdogs, browser UI, cron visibility, and low-devops deployment.
```

That is less useful if your main goal is:

```txt
I already have Aramys/Hermes and just need one central company brain.
```

GBrain’s own docs say it can be installed into existing agent platforms and MCP clients; they explicitly mention OpenClaw, Hermes, Codex, Claude Code, Cursor, and MCP use. citeturn520803view2

So: **do not migrate to OpenClaw just to use GBrain.**

Use:

```txt
Aramys/Hermes + GBrain + Supabase
```

Then later, if you want a phone-first Telegram agent with watchdog/UI, add:

```txt
OpenClaw + AlphaClaw as another client into the same GBrain
```

Treat AlphaClaw as a gateway/runtime layer, not the source of truth.

## 6. Honcho

Do not make Honcho your canonical company brain right now.

Honcho is strong for user-model memory: it models changing entities like users, agents, groups, sessions, and messages, and it reasons over them. Its Hermes integration gives prompt-time context injection, cross-session continuity, and durable writeback. citeturn165445view0turn165445view1

That is useful for:

```txt
“What does this agent know about Tim?”
“What preferences should it remember?”
“How should Hermes adapt over time?”
```

GBrain is better for:

```txt
company notes
voice memos
fundraising memory
Linear/GitHub context
markdown/git ownership
inspectable institutional memory
agent-readable company canon
```

Use Honcho later as a **personalization layer**. Use GBrain as the **company knowledge base**.

# Final decision

## Build this now

```txt
MacBook Air:
  gbrain host
  Supabase backend
  HTTP MCP server over Tailscale
  voice memo watcher
  transcript ingestion
  Linear/GitHub issue extraction
  nightly/autopilot enrichment

MacBook Pro:
  Aramys/Hermes
  Claude Code
  Codex
  Cursor
  GBrain thin client
```

## Defer

```txt
OpenClaw migration
AlphaClaw on Render
Honcho as canonical memory
multiple brains
self-hosted Postgres
multi-user OAuth complexity
```

## Add later

```txt
AlphaClaw/OpenClaw if you want a hosted Telegram/Slack company operator.
Honcho if you want deeper user/agent personality memory.
Company-brain OAuth scoping when you add teammates.
```

The fastest sane path is:

```txt
One Jovie company brain.
One Supabase project.
One always-on MacBook Air host.
All agents connect to that.
```

That gets you moving without locking you out of the full GBrain company-brain path later.

---

## User

cost is prohibitve right now

---

## Assistant

Mr. White, then skip Supabase for now.

Use **local PGLite on the MacBook Air** as the canonical Jovie company brain. That is the cost-safe path, and it is still aligned with GBrain’s docs.

# Revised setup

```txt id="38ue7u"
MacBook Air
  ├── GBrain local PGLite brain
  ├── gbrain serve --http over Tailscale
  ├── iCloud voice memo watcher
  ├── transcript ingestion
  ├── Linear/GitHub automation
  └── local backups

MacBook Pro
  ├── Aramys/Hermes
  ├── Claude Code
  ├── Codex
  ├── Cursor
  └── remote MCP connection to Air
```

GBrain’s install docs explicitly support local standalone setup with:

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite
```

They also say the init flow only suggests Supabase for brains over roughly **1,000 markdown files**, and you can migrate later with `gbrain migrate --to supabase`. citeturn539024view0

# Decision

## Use this now

```txt id="tgvcd8"
Company brain concept
Local PGLite storage
MacBook Air as the always-on host
Tailscale for private access
Aramys/Hermes as the agent runtime
GStack/GBrain sync where useful
Git/iCloud/manual backups
```

## Do not use yet

```txt id="r7vkir"
Supabase Pro
AlphaClaw
OpenClaw migration
Render deployment
Honcho
multi-user OAuth
hosted Postgres
```

# Why this is safe

GBrain’s topology docs say the default single-brain setup can use **PGLite or Supabase**, with PGLite fitting small/local brains and Supabase fitting larger or multi-user setups. It also documents the exact pattern you need next: a **cross-machine thin client**, where a remote machine hosts the brain while the local agent connects to it. citeturn539024view2

So the cost-controlled version is:

```txt id="ait984"
MacBook Air = remote brain host
MacBook Pro = thin client
No cloud DB
No monthly infra bill
```

# Supabase later

Supabase is currently **$25/month for Pro** on the official pricing page. citeturn539024view3 Since cost is prohibitive, treat it as a migration target, not a dependency.

GStack’s GBrain docs also say switching later is supported: PGLite can migrate to Supabase, and the migration preserves pages, chunks, embeddings, links, tags, and timeline data. citeturn539024view1

# Practical plan

## Phase 1 — zero monthly infra

Set up:

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite
gbrain serve --http --port 3000
```

Then expose only over Tailscale:

```txt id="u0a31m"
http://macbook-air-tailscale-name:3000/mcp
```

Use this as the MCP target for Aramys/Hermes, Claude Code, Cursor, and Codex where supported. GBrain’s README shows stdio MCP for local tools and HTTP MCP for remote clients/admin access. citeturn539024view4

## Phase 2 — ingestion

Create local folders:

```txt id="p5q8d1"
~/JovieBrain/
  voice-memos/
  transcripts/
  product/
  engineering/
  fundraising/
  gtm/
  meetings/
  decisions/
```

Then ingest/watch:

```bash
gbrain import ~/JovieBrain
gbrain sync --watch
gbrain autopilot --install
```

Those commands are listed in the GBrain install docs as common follow-ups. citeturn539024view0

## Phase 3 — backups

Minimum viable backup:

```txt id="skrqv9"
1. Keep source markdown in a private GitHub repo.
2. Keep the local PGLite DB on the Air.
3. Nightly export/copy the GBrain directory to iCloud Drive or external disk.
4. Push curated transcripts/docs to Git.
```

Do not rely only on the local DB. The markdown source should be your durable, inspectable truth.

# My answer now

Use **GBrain local PGLite**, not Supabase.

Still set it up as a **Jovie company brain**, because that is a mental/data-ownership choice, not a cloud-cost requirement.

Keep **Aramys/Hermes**.

Use the **MacBook Air as your zero-cost brain server**.

Skip **AlphaClaw/OpenClaw/Render** until you need a hosted agent gateway.

---

## User

spec this out in a prompt that heermes can build

---

## Assistant

I’ll turn this into one build prompt with implementation boundaries, exact deliverables, and acceptance tests. The key is to make Hermes build a local-first brain host, not re-litigate OpenClaw/Supabase.

---

## Assistant

The current GBrain docs support the exact path we want: local PGLite init, existing-agent install, HTTP MCP serving, thin-client mode, and later migration from PGLite to Supabase if needed. citeturn405914view0turn405914view1turn405914view3 Tailscale MagicDNS also supports addressing the Air by machine name/full tailnet DNS name, so the MBP can hit the Air-hosted GBrain server privately. citeturn405914view4

Paste this into Hermes:

```txt
You are Hermes operating on Tim White’s local Jovie company-ops setup.

Goal:
Build a zero-monthly-cost, local-first GBrain setup for Jovie internal company memory.

Context:
- Tim is solo founder of Jovie.
- We are NOT setting up production Jovie user memory yet.
- This is internal company memory for operating Jovie.
- Cost is prohibitive, so do NOT use Supabase, Render, AlphaClaw, OpenClaw, paid hosting, or any paid service unless explicitly approved.
- We currently use Aramys/Hermes as the agent runtime. Keep it.
- MacBook Air is the always-on host.
- MacBook Pro is the main workstation/thin client.
- Both machines are connected via Tailscale.
- Voice memos already sync via Apple/iCloud and get transcribed. We need those transcriptions ingested into GBrain.
- Future path should allow migration to Supabase later, but do not implement Supabase now.

Primary architecture:
MacBook Air:
  - canonical Jovie company brain
  - GBrain local PGLite backend
  - GBrain HTTP MCP server over Tailscale
  - ingestion daemon/watchers
  - voice memo transcript watcher
  - Linear/GitHub extraction stubs
  - local backup jobs

MacBook Pro:
  - Hermes/Aramys client
  - Claude Code/Codex/Cursor client configs if available
  - no canonical local GBrain DB
  - connects to Air-hosted GBrain over HTTP MCP

Source docs to inspect before implementing:
- https://raw.githubusercontent.com/garrytan/gbrain/master/README.md
- https://raw.githubusercontent.com/garrytan/gbrain/master/docs/INSTALL.md
- https://raw.githubusercontent.com/garrytan/gbrain/master/docs/architecture/topologies.md
- https://raw.githubusercontent.com/garrytan/gbrain/master/docs/tutorials/company-brain.md
- https://tailscale.com/docs/features/magicdns

Hard constraints:
- No Supabase.
- No Render.
- No AlphaClaw.
- No OpenClaw migration.
- No cloud database.
- No external paid transcription service.
- Do not duplicate brains across machines.
- Do not create separate “Tim brain” and “Jovie brain.”
- Create one canonical local “jovie-company” brain on the MacBook Air.
- Prefer boring shell scripts, launchd jobs, markdown files, git backups, and GBrain CLI.
- Every script must be idempotent.
- Every destructive operation must require explicit confirmation.
- Do not store secrets in git.
- Do not ingest obvious secrets/API keys into GBrain.

Deliverables:
1. A repo/folder named something like:
   ~/jovie-company-brain

2. Folder structure:
   ~/jovie-company-brain/
     README.md
     bin/
       setup-air-host.sh
       setup-mbp-client.sh
       start-gbrain-http.sh
       stop-gbrain-http.sh
       doctor.sh
       ingest-now.sh
       watch-transcripts.sh
       backup-brain.sh
       redact-secrets.sh
     config/
       gbrain.air.example.json
       gbrain.client.example.json
       launchd/
         com.jovie.gbrain-server.plist
         com.jovie.gbrain-transcript-watcher.plist
         com.jovie.gbrain-backup.plist
     sources/
       canon/
       product/
       engineering/
       gtm/
       fundraising/
       investors/
       meetings/
       decisions/
       voice-memos/
       linear-github/
       agents-sops/
     inbox/
       voice-memos-transcripts/
       raw/
       processed/
       failed/
     logs/
     backups/

3. A MacBook Air setup script:
   bin/setup-air-host.sh

   It should:
   - detect macOS
   - check/install bun if missing, but ask first before installing
   - install or update GBrain from GitHub
   - initialize GBrain with PGLite only:
     gbrain init --pglite
   - run:
     gbrain doctor
   - create the folder structure above
   - create source README files explaining what belongs in each source
   - import/sync local markdown sources into GBrain
   - configure HTTP MCP serving on a local port, default 3131
   - bind to 0.0.0.0 only if Tailscale is active and user confirms
   - print the Tailscale hostname/IP and suggested MCP URL
   - create launchd plist for persistent GBrain server startup
   - do NOT expose anything to the public internet

4. A MacBook Pro setup script:
   bin/setup-mbp-client.sh

   It should:
   - verify Tailscale connectivity to the Air
   - configure thin-client connection to Air-hosted GBrain if GBrain supports `gbrain init --mcp-only`
   - otherwise generate a clear manual MCP config snippet for Hermes/Cursor/Claude Code
   - ensure no local canonical GBrain database is created on MBP unless explicitly approved
   - run a smoke test query against Air-hosted GBrain

5. GBrain server script:
   bin/start-gbrain-http.sh

   It should:
   - start:
     gbrain serve --http --port 3131 --bind 0.0.0.0
   - prefer Tailscale-only access
   - print:
     - health URL
     - MCP URL
     - admin URL if provided by GBrain
   - write logs to logs/gbrain-server.log

6. Transcript ingestion:
   bin/watch-transcripts.sh

   It should:
   - watch:
     ~/jovie-company-brain/inbox/voice-memos-transcripts
   - accept .txt, .md, .json, and .m4a-adjacent transcript files if present
   - convert each transcript into normalized markdown:
     sources/voice-memos/YYYY/MM/YYYY-MM-DD-HHMM-title.md
   - include frontmatter:
     ---
     source: voice-memo
     captured_at: ISO timestamp if available
     imported_at: ISO timestamp
     machine: hostname
     status: raw
     tags:
       - voice-memo
       - founder-notes
     ---
   - preserve original transcript text
   - add a short generated “extraction block” placeholder:
     ## Extracted Candidates
     - Decisions:
     - Tasks:
     - Linear candidates:
     - GitHub candidates:
     - Product ideas:
     - Fundraising notes:
   - move original file to inbox/processed after successful import
   - move failures to inbox/failed with an error log
   - run GBrain import/sync after processing
   - avoid duplicate imports by hashing file contents and storing hashes locally

7. Manual ingestion:
   bin/ingest-now.sh

   It should:
   - run secret redaction scan first
   - import/sync all sources
   - run gbrain doctor
   - run a test query:
     “What are the latest founder voice memo themes?”
   - print results or the exact command the user should run

8. Secret redaction:
   bin/redact-secrets.sh

   It should:
   - scan incoming files for likely secrets:
     - GitHub tokens
     - OpenAI/Anthropic keys
     - AWS keys
     - Stripe keys
     - Supabase URLs/keys
     - private keys
     - bearer tokens
     - JWT-looking strings
   - block ingestion if likely secrets are found
   - write blocked files to inbox/failed
   - never silently ingest secrets

9. Backup:
   bin/backup-brain.sh

   It should:
   - back up the local GBrain directory and the jovie-company-brain repo/source files
   - create timestamped backups under:
     ~/JovieBrainBackups/
   - optionally rsync to iCloud Drive if available
   - optionally git commit source markdown files if the folder is a git repo
   - never commit .env, logs with tokens, DB files, or secrets
   - keep the latest 14 daily backups by default
   - document restore steps

10. Linear/GitHub extraction stubs:
   Create a local markdown-based queue first. Do NOT call Linear/GitHub APIs yet unless tokens already exist and Tim explicitly approves.

   Add:
   sources/linear-github/queue/
     README.md

   Each extracted candidate should become markdown like:
   sources/linear-github/queue/YYYY-MM-DD-short-title.md

   Frontmatter:
   ---
   type: issue-candidate
   target: linear | github | unknown
   priority: low | medium | high
   source_voice_memo: path
   status: needs-review
   ---

   The agent should parse voice memos for language like:
   - “open an issue”
   - “make a Linear”
   - “bug”
   - “fix”
   - “Codex should”
   - “Claude should”
   - “Hermes should”
   - “we need to”
   - “ship”
   - “regressed”
   - “broken”
   - “audit”
   - “QA”
   - “performance”
   - “design gap”

   For now, create reviewable issue-candidate markdown files, not live Linear tickets.

11. README:
   Write a clean README explaining:
   - architecture
   - why PGLite now
   - how Supabase migration works later conceptually
   - how to start/stop the server
   - how to add transcripts
   - how to connect MBP clients
   - how to run doctor
   - how backups work
   - what NOT to do

12. Acceptance tests:
   Create and run a `bin/doctor.sh` that verifies:
   - GBrain installed
   - `gbrain doctor` passes or prints actionable errors
   - PGLite mode is active
   - Supabase is NOT configured
   - GBrain HTTP server can start
   - `/health` returns OK if available
   - Tailscale is active
   - Air hostname is resolvable from MBP if running there
   - transcript watcher can ingest a test transcript
   - duplicate transcript is skipped
   - secret-containing transcript is blocked
   - source markdown imports into GBrain
   - a basic query/search returns the test transcript

13. Build sequence:
   First inspect the machine and repo state.
   Then propose the exact files you will create.
   Then implement.
   Then run the doctor script.
   Then fix failures.
   Then print a concise final report with:
   - what was installed
   - where files live
   - server URL
   - MCP URL
   - backup path
   - next manual step for Tim

Implementation notes:
- Prefer POSIX shell or bash for scripts unless Node/TypeScript is materially better.
- Keep scripts readable.
- Include comments.
- Use `set -euo pipefail`.
- Avoid brittle Apple Voice Memos internal database scraping unless explicitly approved.
- The stable MVP path is a transcript drop-zone folder:
  ~/jovie-company-brain/inbox/voice-memos-transcripts
- If you find a reliable local Apple transcript export path, document it as optional only.
- Do not depend on it for MVP.
- Do not create any public tunnel.
- Do not use ngrok.
- Do not expose to WAN.
- Tailscale/private LAN only.

Final target state:
Tim can take a walk, dictate voice memos, get transcripts synced/exported into the inbox folder, and the MacBook Air automatically ingests them into the Jovie company brain. Hermes/Aramys on the MacBook Pro can query that same brain over Tailscale. If a transcript contains product tasks or bugs, the system creates reviewable issue-candidate markdown files first, then later we can wire those into Linear/GitHub with approval.
```

One tweak I would make before running it: tell Hermes the Air’s Tailscale machine name if you know it. That avoids it guessing the MCP URL.
