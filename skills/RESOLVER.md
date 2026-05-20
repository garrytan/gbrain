# GBrain Skill Resolver

This is the dispatcher. Skills are the implementation. **Read the skill file before acting.** If two skills could match, read both. They are designed to chain (e.g., ingest then enrich for each entity).

## Always-on (every message)

| Trigger | Skill |
|---------|-------|
| Every inbound message (spawn parallel, don't block) | `skills/signal-detector/SKILL.md` |
| Any brain read/write/lookup/citation | `skills/brain-ops/SKILL.md` |

## Brain operations

| Trigger | Skill |
|---------|-------|
| "What do we know about", "tell me about", "search for", "who is", "background on", "notes on" | `skills/query/SKILL.md` |
| "Who knows who", "relationship between", "connections", "graph query" | `skills/query/SKILL.md` (use graph-query) |
| Creating/enriching a person or company page | `skills/enrich/SKILL.md` |
| Where does a new file go? Filing rules | `skills/repo-architecture/SKILL.md` |
| Fix broken citations in brain pages | `skills/citation-fixer/SKILL.md` |
| "citation audit", "check citations", "fix citations" | `skills/citation-fixer/SKILL.md` (focused fix). For broader brain health, chain into `skills/maintain/SKILL.md` |
| "Research", "track", "extract from email", "investor updates", "donations" | `skills/data-research/SKILL.md` |
| Share a brain page as a link | `skills/publish/SKILL.md` |
| "validate frontmatter", "check frontmatter", "fix frontmatter", "frontmatter audit", "brain lint" | `skills/frontmatter-guard/SKILL.md` |
| "what search mode", "is my cache hot", "tune my retrieval", "compare search modes", "clear search overrides" | `gbrain search modes/stats/tune` directly. See `skills/conventions/search-modes.md` |
| "eval results", "search benchmark", "haters-immune methodology", "regression check on retrieval" | `gbrain eval run-all` / `gbrain eval compare`. See `docs/eval/SEARCH_MODE_METHODOLOGY.md` |

## Content & media ingestion

| Trigger | Skill |
|---------|-------|
| User shares a link, article, tweet, or idea | `skills/idea-ingest/SKILL.md` |
| "watch this video", "process this YouTube link", "ingest this PDF", "save this podcast", "process this book", "summarize this book", "PDF book", "ingest it into my brain", "what's in this screenshot", "check out this repo" | `skills/media-ingest/SKILL.md` |
| Meeting transcript received | `skills/meeting-ingestion/SKILL.md` |
| Generic "ingest this" (auto-routes to above) | `skills/ingest/SKILL.md` |

## Thinking skills (from GStack)

| Trigger | Skill |
|---------|-------|
| "Brainstorm", "I have an idea", "office hours" | GStack: office-hours |
| "Review this plan", "CEO review", "poke holes" | GStack: ceo-review |
| "Debug", "fix", "broken", "investigate" | GStack: investigate |
| "Retro", "what shipped", "retrospective" | GStack: retro |

> These skills come from GStack. If GStack is installed, the agent reads them directly.
> If not, brain-only mode still works (brain skills function without thinking skills).

## Operational

| Trigger | Skill |
|---------|-------|
| Task add/remove/complete/defer/review | `skills/daily-task-manager/SKILL.md` |
| Morning prep, meeting context, day planning | `skills/daily-task-prep/SKILL.md` |
| Daily briefing, "what's happening today" | `skills/briefing/SKILL.md` |
| Cron scheduling, quiet hours, job staggering | `skills/cron-scheduler/SKILL.md` |
| Save or load reports | `skills/reports/SKILL.md` |
| "Create a skill", "improve this skill" | `skills/skill-creator/SKILL.md` |
| "Skillify this", "is this a skill?", "make this proper" | `skills/skillify/SKILL.md` |
| "Compress my resolver", "AGENTS.md too large", "RESOLVER.md too big", "functional area dispatcher", "shrink routing table" | `skills/functional-area-resolver/SKILL.md` |
| "Is gbrain healthy?", morning health check, skillpack-check | `skills/skillpack-check/SKILL.md` |
| "harvest this skill into gbrain", "publish this skill to gbrain", "lift this skill upstream", "share this skill with other gbrain clients", "promote my skill to gbrain" | `skills/skillpack-harvest/SKILL.md` |
| Post-restart health + auto-fix, "did the container restart break anything", smoke test | `skills/smoke-test/SKILL.md` |
| Cross-modal review, second opinion | `skills/cross-modal-review/SKILL.md` |
| "Validate skills", skill health check | `skills/testing/SKILL.md` |
| Webhook setup, external event processing | `skills/webhook-transforms/SKILL.md` |
| "Spawn agent", "background task", "parallel tasks", "steer agent", "pause/resume agent", "gbrain jobs submit", "submit a gbrain job", "submit a shell job", "shell job" | `skills/minion-orchestrator/SKILL.md` |
| "present options", "ask before proceeding", "choice gate", "user decision" | `skills/ask-user/SKILL.md` |

## Setup & migration

| Trigger | Skill |
|---------|-------|
| "Set up GBrain", first boot | `skills/setup/SKILL.md` |
| "Now what?", "fill my brain", "cold start", "bootstrap", "import my data", "what should I import first" | `skills/cold-start/SKILL.md` |
| "Migrate from Obsidian/Notion/Logseq" | `skills/migrate/SKILL.md` |
| Brain health check, maintenance run | `skills/maintain/SKILL.md` |
| "Extract links", "build link graph", "populate timeline" | `skills/maintain/SKILL.md` (extraction sections) |
| "Run dream", "process today's session", "synthesize my conversations", "consolidate yesterday's conversations", "what patterns did you see", "did the dream cycle run" | `skills/maintain/SKILL.md` (dream cycle section) |
| "Brain health", "what features am I missing", "brain score" | Run `gbrain features --json` |
| "Set up autopilot", "run brain maintenance", "keep brain updated" | Run `gbrain autopilot --install --repo ~/brain` |
| Agent identity, "who am I", customize agent | `skills/soul-audit/SKILL.md` |
| "Populate links", "extract links", "backfill graph" | `skills/maintain/SKILL.md` (graph population phase) |
| "Populate timeline", "extract timeline entries" | `skills/maintain/SKILL.md` (graph population phase) |

## Identity & access (always-on)

| Trigger | Skill |
|---------|-------|
| Non-owner sends a message | Check `ACCESS_POLICY.md` before responding |
| Agent needs to know its identity/vibe | Read `SOUL.md` |
| Agent needs user context | Read `USER.md` |
| Operational cadence (what to check and when) | Read `HEARTBEAT.md` |

## Disambiguation rules

When multiple skills could match:
1. Prefer the most specific skill (meeting-ingestion over ingest)
2. If the user mentions a URL, route by content type (link → idea-ingest, video → media-ingest)
3. If the user mentions a person/company, check if enrich or query fits better
4. Chaining is explicit in each skill's Phases section
5. When in doubt, ask the user (see `skills/ask-user/SKILL.md` for the choice-gate pattern)

## Conventions (cross-cutting)

These apply to ALL brain-writing skills:
- `skills/conventions/quality.md` — citations, back-links, notability gate
- `skills/conventions/brain-first.md` — check brain before external APIs
- `skills/conventions/brain-routing.md` — which brain (DB) and which source (repo) to target; cross-brain federation is latent-space only
- `skills/conventions/subagent-routing.md` — when to use Minions vs inline work
- `skills/ask-user/SKILL.md` — choice-gate pattern for human input at decision points
- `skills/_brain-filing-rules.md` — where files go
- `skills/_output-rules.md` — output quality standards

## Uncategorized

| Trigger | Skill |
|---------|-------|
| "personalized version of this book", "mirror this book", "two-column book analysis", "apply this book to my life", "how does this book apply to me" | `skills/book-mirror/SKILL.md` |
| "enrich this article", "enrich brain pages", "batch enrich", "make brain pages useful" | `skills/article-enrichment/SKILL.md` |
| "strategic reading", "read this through the lens of", "apply this to my problem", "what can I learn from this about", "extract a playbook from" | `skills/strategic-reading/SKILL.md` |
| "concept synthesis", "synthesize my concepts", "find patterns across my notes", "build my intellectual map", "trace idea evolution" | `skills/concept-synthesis/SKILL.md` |
| "perplexity research", "what's new about", "current state of", "web research", "what changed about" | `skills/perplexity-research/SKILL.md` |
| "crawl my archive", "find gold in my archive", "archive crawler", "scan my dropbox for", "mine my old files for" | `skills/archive-crawler/SKILL.md` |
| "verify this academic claim", "check this study", "academic verify", "validate citation", "is this study real" | `skills/academic-verify/SKILL.md` |
| "make pdf from brain", "brain pdf", "convert brain page to pdf", "publish this page as pdf", "export brain page" | `skills/brain-pdf/SKILL.md` |
| "voice note", "ingest this voice memo", "transcribe and file", "voice note ingest", "save this audio note" | `skills/voice-note-ingest/SKILL.md` |

## KOS-Jarvis extensions (fork-only, append-only)

Lucien's KOS-flavored quality pack. See `skills/kos-jarvis/README.md`
for boundary and upgrade policy. Triggers must not collide with
upstream sections above; KOS extensions are append-only by policy.

| Trigger | Skill |
|---------|-------|
| Daily patrol + staleness + gap detection + MEMORY digest | `skills/kos-jarvis/kos-patrol/SKILL.md` |
| Weekly push KOS digest → OpenClaw MEMORY.md 近期层 | `skills/kos-jarvis/digest-to-memory/SKILL.md` |
| Notion → gbrain 5-min incremental sync | `skills/kos-jarvis/notion-ingest-delta/SKILL.md` |
| Batch scan brain, extract entities, create people/company stubs (G1 payoff) | `skills/kos-jarvis/enrich-sweep/SKILL.md` |

These chain into upstream skills: digest-to-memory reads patrol output;
enrich-sweep wraps upstream `skills/enrich/` in bulk mode.

> **Archived (2026-05-05)**: `feishu-bridge` + `pending-enrich` skills
> moved to `skills/kos-jarvis/_archived/`. Phase 2 Feishu signal-fork
> design was superseded by retiring the OpenClaw extension; brain-side
> contract docs survive at `_archived/` for historical reference.
>
> **Archived (2026-05-10, M1)**: `kos-lint` (six-check lint — checks 1-3
> covered by upstream `frontmatter-guard` + `gbrain doctor` + BrainWriter
> linkValidator, check 4 by `gbrain orphans` + dream-cycle; checks 5-6
> not yet rehomed), `frontmatter-ref-fix` (one-shot, ran 2026-04-27),
> `slug-normalize` (one-shot, ran 2026-04-23). All under
> `skills/kos-jarvis/_archived/`.
>
> **Archived (2026-05-10, M2-A)**: `dikw-compile` + `evidence-gate` +
> `confidence-score` (the KOS quality triplet). Production probe
> 2026-05-04 confirmed they were 100% dead code: `frontmatter.dikw_layer`
> set on 0 / 2477 pages, `evidence_level` on 1 / 2477, `confidence` on
> 2470 / 2477 but values are hardcoded template strings from
> `kos-compat-api.ts` (not script-computed). No production caller in
> `kos-compat-api.ts` / `workers/_archived/notion-poller/` / `kos-patrol/run.ts`
> ever spawned the triplet's `run.ts`. Replacement for cross-page
> synthesis: upstream `gbrain dream` + `concept-synthesis` skill (v0.25.1).
>
> **Archived (2026-05-10, M3)**: `gemini-embed-shim`. v0.27 ships a
> native Vercel AI SDK gateway with first-class Google embedding
> support, removing the need for the OpenAI-shaped shim that
> intercepted gateway calls and translated them to Google
> `batchEmbedContents`. Production cutover: 5 plists carry
> `GOOGLE_GENERATIVE_AI_API_KEY` + `GBRAIN_EMBEDDING_MODEL=google:gemini-embedding-001` +
> `GBRAIN_EMBEDDING_DIMENSIONS=1536`; all 2718 pages re-embedded into
> a clean native vector space; shim launchd service bootout'd. See
> `docs/JARVIS-ARCHITECTURE.md` §6.23 for the full cutover narrative.
