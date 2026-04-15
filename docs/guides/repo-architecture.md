# Two-Repo Architecture: Agent Behavior vs World Knowledge

## Goal

Separate agent behavior (replaceable) from world knowledge (permanent) into two repos with strict boundaries.

## What the User Gets

Without this: agent config and world knowledge are mixed together. Switch agents
and you lose your knowledge. Switch knowledge tools and you lose your agent setup.

With this: your brain (14,700+ files of people, companies, meetings, ideas)
survives any agent swap. Your agent config survives any knowledge tool swap.

## Implementation

### The Boundary Test

**"Is this about how the agent operates, or is this knowledge about the world?"**

| Question | If YES -> Agent Repo | If YES -> Brain Repo |
|----------|---------------------|---------------------|
| Would this file transfer if you switched AI agents? | YES | -- |
| Would this file transfer if you switched to a different person? | -- | YES |
| Is this about how the agent behaves? | YES | -- |
| Is this about a person, company, deal, meeting, or idea? | -- | YES |

### Quick Decision Tree

```
New file to create?
  |-- About a person, company, deal, project, meeting, idea? -> brain/
  |-- A spec, research doc, or strategic analysis? -> brain/
  |-- An original idea or observation? -> brain/originals/
  |-- A daily session log or heartbeat state? -> agent-repo/
  |-- A skill, config, cron, or ops file? -> agent-repo/
  |-- A task or todo? -> agent-repo/tasks/
```

### Agent Repo (operational config)

How the agent works. Identity, configuration, operational state.

```
agent-repo/
├── AGENTS.md              # Agent identity + operational rules
├── SOUL.md                # Persona, voice, values
├── USER.md                # User preferences + context
├── HEARTBEAT.md           # Daily ops flow
├── TOOLS.md               # Available tools + credentials
├── MEMORY.md              # Operational memory (preferences, decisions)
├── skills/                # Agent capabilities (SKILL.md files)
│   ├── ingest/SKILL.md
│   ├── query/SKILL.md
│   ├── enrich/SKILL.md
│   └── ...
├── cron/                  # Scheduled jobs
│   └── jobs.json
├── tasks/                 # Current task list
│   └── current.md
├── hooks/                 # Event hooks + transforms
├── scripts/               # Operational scripts (collectors, gates)
└── memory/                # Session logs, state files
    ├── heartbeat-state.json
    └── YYYY-MM-DD.md      # Daily session logs
```

### Brain Repo (world knowledge)

What you know. People, companies, deals, meetings, ideas, media.
This is the repo GBrain indexes.

```
brain/
├── people/                # Person dossiers (compiled truth + timeline)
├── companies/             # Company profiles
├── deals/                 # Deal tracking
├── meetings/              # Meeting transcripts + analysis
├── originals/             # YOUR original thinking (highest value)
├── concepts/              # World concepts and frameworks
├── systems/               # Codebase and subsystem architecture maps
├── ideas/                 # Product and business ideas
├── media/                 # Video transcripts, books, articles
│   ├── youtube/
│   ├── podcasts/
│   └── articles/
├── sources/               # Source material summaries
├── daily/                 # Daily data (calendar, logs)
│   └── calendar/
│       └── YYYY/
│           └── YYYY-MM-DD.md
├── projects/              # Project specs and docs
├── writing/               # Essays, drafts, published work
├── diligence/             # Investment diligence materials
│   └── company-name/
│       ├── index.md
│       ├── pitch-deck.md
│       └── .raw/          # Original PDFs/files
└── Apple Notes/           # Imported Apple Notes archive
```

### The Hard Rule

**Never write knowledge to the agent repo.** If a skill, sub-agent, or cron
job needs to create a file about a person, company, deal, meeting, project,
or idea, it MUST write to the brain repo, never to the agent repo.

The brain is the permanent record. The agent repo is replaceable.

### Why Two Repos

**Independence.** You can switch AI agents (OpenClaw -> Hermes -> custom) without
losing your knowledge. You can switch knowledge tools (GBrain -> something else)
without losing your agent setup.

**Scale.** The brain grows large (10,000+ files). The agent repo stays small
(< 100 files). Different backup strategies, different sync cadences.

**Privacy.** The brain contains sensitive information (people, deals, personal
notes). The agent repo contains operational config. Different access controls.

**GBrain indexes the brain repo.** Run `gbrain sync --repo ~/brain/` to keep
the search index current. The agent repo is never indexed by GBrain.

## Tricky Spots

1. **Never write knowledge to the agent repo.** This is the most common
   violation. A skill that creates a person page, a cron job that saves
   meeting notes, a sub-agent that captures an idea -- all of these MUST
   write to the brain repo. If it's about the world, it goes in the brain.

2. **The brain is the permanent record.** When in doubt, ask: "Would this
   file survive switching to a completely different AI agent?" If yes, it
   belongs in the brain. Agent configs, skills, cron jobs, and operational
   state are replaceable. People, companies, ideas, and meetings are not.

3. **Don't index the agent repo.** GBrain indexes the brain repo only.
   Running `gbrain sync` against the agent repo pollutes search results
   with operational config instead of world knowledge.

## How to Verify

1. **Check file placement.** After any skill or cron job creates a file,
   verify it landed in the correct repo. Person/company/idea/meeting files
   should be in `brain/`. Skill/config/cron/state files should be in the
   agent repo. Any knowledge file in the agent repo is a boundary violation.

2. **Run the boundary test.** Pick 5 recently created files and ask: "Would
   this transfer if I switched AI agents?" and "Would this transfer if I
   switched to a different person?" If the answers don't match the file's
   location, it's in the wrong repo.

3. **Verify GBrain only indexes brain.** Run `gbrain stats` and check the
   indexed paths. None should point to the agent repo directory. If agent
   config files appear in search results, the sync target is misconfigured.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
