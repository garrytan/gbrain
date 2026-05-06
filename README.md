# GBrain

Your AI agent is smart but forgetful. GBrain gives it a brain.

Built by the President and CEO of Y Combinator to run his actual AI agents. The production brain powering his OpenClaw and Hermes deployments: **17,888 pages, 4,383 people, 723 companies**, 21 cron jobs running autonomously, built in 12 days. The agent ingests meetings, emails, tweets, voice calls, and original ideas while you sleep. It enriches every person and company it encounters. It fixes its own citations and consolidates memory overnight. You wake up and the brain is smarter than when you went to bed.

The brain wires itself. Every page write extracts entity references and creates typed links (`attended`, `works_at`, `invested_in`, `founded`, `advises`) with zero LLM calls. Hybrid search. Self-wiring knowledge graph. Structured timeline. Backlink-boosted ranking. Ask "who works at Acme AI?" or "what did Bob invest in this quarter?" and get answers vector search alone can't reach. Benchmarked side-by-side against the category: gbrain lands **P@5 49.1%, R@5 97.9%** on a 240-page Opus-generated rich-prose corpus, beating its own graph-disabled variant by **+31.4 points P@5** and ripgrep-BM25 + vector-only RAG by a similar margin. The graph layer plus v0.12 extract quality together carry the gap. Full BrainBench scorecards + corpus live in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo.

GBrain is those patterns, generalized. 34 skills. Install in 30 minutes. Your agent does the work. As Garry's personal agent gets smarter, so does yours.

**New in v0.25.0 — BrainBench-Real (session capture, contributor opt-in):** with `GBRAIN_CONTRIBUTOR_MODE=1` set in your shell, every real `query` + `search` call through MCP, CLI, or the subagent tool-bridge gets captured (PII-scrubbed) into an `eval_candidates` table. Snapshot with `gbrain eval export`, replay against your code change with `gbrain eval replay`. Three numbers come back: mean Jaccard@k between captured and current retrieved slugs, top-1 stability, and latency Δ. **Off by default** for production users — no surprise data accumulation. Walkthrough: [docs/eval-bench.md](docs/eval-bench.md). NDJSON wire format: [docs/eval-capture.md](docs/eval-capture.md).

> **~30 minutes to a fully working brain.** Database ready in 2 seconds (PGLite, no server). You just answer questions about API keys.

> **LLMs:** fetch [`llms.txt`](llms.txt) for the documentation map, or [`llms-full.txt`](llms-full.txt) for the same map with core docs inlined in one fetch. **Agents:** start with [`AGENTS.md`](AGENTS.md) (or [`CLAUDE.md`](CLAUDE.md) if you're Claude Code).

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

That's it. The agent clones the repo, installs GBrain, sets up the brain, loads 34 skills, and configures recurring jobs. You answer a few questions about API keys. ~30 minutes.

If your agent doesn't auto-read `AGENTS.md`, point it at that file first:
`https://raw.githubusercontent.com/garrytan/gbrain/master/AGENTS.md` is the non-Claude
agent operating protocol (install, read order, trust boundary, common tasks). For
the full doc map, use `llms.txt` at the same URL root.

### Standalone CLI (no agent)

```bash
git clone https://github.com/garrytan/gbrain.git && cd gbrain && bun install && bun link
gbrain init                     # local brain, ready in 2 seconds
gbrain import ~/notes/          # index your markdown
gbrain query "what themes show up across my notes?"
```

**Do NOT use `bun install -g github:garrytan/gbrain`.** Bun blocks the top-level
postinstall hook on global installs, so schema migrations never run and the CLI
aborts with `Aborted()` the first time it opens PGLite. Use `git clone + bun install
&& bun link` as shown above. See [#218](https://github.com/garrytan/gbrain/issues/218).

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

### Remote MCP with OAuth 2.1 (ChatGPT, Claude Desktop, Cowork, Perplexity)

`gbrain serve --http` starts a production-grade OAuth 2.1 server with an embedded admin dashboard. Zero external infrastructure. Every major AI client connects, every request is scoped, every action is logged.

```bash
# Start the HTTP server (prints admin bootstrap token on first start)
gbrain serve --http --port 3131

# Open the admin dashboard, paste the bootstrap token, register a client
open http://localhost:3131/admin

# Expose publicly (set --public-url so the OAuth issuer matches)
ngrok http 3131 --url your-brain.ngrok.app
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app

# ChatGPT and other OAuth-aware clients can also connect:
claude mcp add gbrain -t http https://your-brain.ngrok.app/mcp -H "Authorization: Bearer TOKEN"
```

Register OAuth clients from the `/admin` dashboard — click **Register client**,
pick scopes, save the credentials shown once in the reveal modal. Programmatic
registration via `oauthProvider.registerClientManual(...)` and the
`gbrain auth register-client` CLI are also available.

- **OAuth 2.1 via the MCP SDK** — client credentials (machine-to-machine: Perplexity, Claude), authorization code + PKCE (browser-based: ChatGPT), refresh token rotation, revocation, protected resource metadata. Optional Dynamic Client Registration behind `--enable-dcr` (DCR redirect_uris must be `https://` or loopback per RFC 6749 §3.1.2.1).
- **Scoped operations** — 30 operations tagged `read | write | admin`. `sync_brain` and `file_upload` are `localOnly`, rejected over HTTP.
- **React admin dashboard** — 7 screens baked into the binary (~65KB gzip). Live SSE activity feed, agents table, credential reveal, filterable request log, per-client config export.
- **Legacy bearer tokens still work** — pre-v0.26 `gbrain auth create` tokens continue to authenticate as `read+write+admin`. v0.22.7's simpler `src/mcp/http-transport.ts` path stays compiled in for backward compat callers; v0.26+ deployments use the OAuth-aware `serve-http.ts`.

Per-client guides: [`docs/mcp/`](docs/mcp/DEPLOY.md). Hardening defaults, env vars, and threat model: [SECURITY.md](SECURITY.md).

### Using gbrain with GStack

If your engineering agent runs on [GStack](https://github.com/garrytan/gstack), point it at gbrain for code lookup instead of grep+read. Cathedral II (v0.21.0) ships call-graph edges and two-pass retrieval — `/investigate`, `/review`, `/plan-eng-review`, and `/office-hours` all benefit when the agent walks the symbol graph instead of scanning files line by line.

The five magical-moment commands:

```bash
gbrain code-callers searchKeyword           # who calls this symbol?
gbrain code-callees searchKeyword           # what does this symbol call?
gbrain code-def BrainEngine                 # where is X defined?
gbrain code-refs BrainEngine                # all reference sites
gbrain query "how does N+1 handling work" --near-symbol BrainEngine.searchKeyword --walk-depth 2
```

All five auto-emit JSON on non-TTY (gh-CLI convention) so a GStack subagent shelling out via bash gets a clean parseable response. Run `gbrain sources add <repo> --strategy code` to index a repo, then your agent's brain-first lookup covers code, not just markdown. ([Cathedral II release notes](CHANGELOG.md#0210---2026-04-25))

## The 34 Skills

GBrain ships 34 skills organized by `skills/RESOLVER.md` (or your OpenClaw's `AGENTS.md` — both filenames are supported as of v0.19). The resolver tells your agent which skill to read for any task. v0.25.1 added 9 research-flavored skills (`book-mirror` flagship plus 8 pairings); see the new "Research and synthesis" section below.

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
| **voice-note-ingest** | Voice notes captured verbatim — exact phrasing preserved, never paraphrased. Routes to originals/concepts/people/companies/ideas/personal/voice-notes based on content. |
| **article-enrichment** | Raw article dumps become structured pages with executive summary, verbatim quotes, key insights, and why-it-matters. |

### Research and synthesis (v0.25.1)

| Skill | What it does |
|-------|-------------|
| **book-mirror** | Flagship. Hand the agent a book, get a personalized two-column chapter-by-chapter analysis. Left column preserves the chapter's actual content; right column maps every idea to your life using your words from the brain. ~$6 for a 20-chapter book at Opus. Pairs with `gbrain book-mirror` CLI for the trusted runtime. |
| **strategic-reading** | Read a book / article / case study through ONE specific problem-lens. Output: applied playbook with do / avoid / watch-for and short / medium / long-term recommendations. |
| **concept-synthesis** | Deduplicate thousands of concept stubs into a tiered intellectual map (T1 Canon to T4 Riff). Trace how ideas evolved across years of notes. |
| **perplexity-research** | Brain-augmented web research. Sends brain context to Perplexity so the search focuses on what's NEW vs already-known. Output: Executive Summary + Key New Developments + Confirming Signals + Contradictions or Updates + Recommended Brain Updates + Citations. |
| **archive-crawler** | Universal archivist for personal file archives (Dropbox / Backblaze / Gmail-takeout / hard-drive dumps). REFUSES to run unless `archive-crawler.scan_paths:` is set in `gbrain.yml`. Safe-by-default safety fence. |
| **academic-verify** | Trace a research claim through publication → methodology → raw data → independent replication. Routes through perplexity-research; produces a verdict (verified / partial / unverifiable / misattributed / retracted). |
| **brain-pdf** | Render any brain page to publication-quality PDF via the gstack `make-pdf` binary. Strips frontmatter, sanitizes emoji, applies running headers. |

### Brain operations

| Skill | What it does |
|-------|-------------|
| **enrich** | Tiered enrichment (Tier 1/2/3). Creates and updates person/company pages with compiled truth and timelines. |
| **query** | 3-layer search with synthesis and citations. Says "the brain doesn't have info on X" instead of hallucinating. |
| **maintain** | Periodic health: stale pages, orphans, dead links, citation audit, back-link enforcement, tag consistency. v0.23 adds the dream cycle's synthesize + patterns phases ... overnight conversation transcripts become reflections, originals, and 25-year patterns. |
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
| **skillify** | The "skillify it!" meta-skill. Orchestrates the 10-step loop so failures become durable skills: scaffold the stubs via `gbrain skillify scaffold`, write the real logic, gate with `gbrain skillify check` + `gbrain check-resolvable`. |
| **skillpack-check** | Agent-readable gbrain health report. Exit code for CI; JSON for debugging. Cron-friendly. |
| **smoke-test** | 8 post-restart health checks with auto-fix (Bun, CLI, DB, worker, Zod CJS, gateway, API key, brain repo). Drop-in user tests at `~/.gbrain/smoke-tests.d/*.sh`. |
| **minion-orchestrator** | Background work in one skill. Shell jobs via `gbrain jobs submit shell` (operator/CLI, MCP blocks protected names) and LLM subagents via `gbrain agent run`. Parent-child DAGs, `child_done` inbox, durability across worker restarts. |

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
  -> Auto-link: typed relationships extracted on every write (zero LLM calls)
  -> Sync: gbrain indexes changes for next query
```

Every cycle adds knowledge. The agent enriches a person page after a meeting. Next time that person comes up, the agent already has context. The difference compounds daily.

The system gets smarter on its own. Entity enrichment auto-escalates: a person mentioned once gets a stub page (Tier 3). After 3 mentions across different sources, they get web + social enrichment (Tier 2). After a meeting or 8+ mentions, full pipeline (Tier 1). The brain learns who matters without being told. Deterministic classifiers improve over time via a fail-improve loop that logs every LLM fallback and generates better regex patterns from the failures. `gbrain doctor` shows the trajectory: "intent classifier: 87% deterministic, up from 40% in week 1."

> "Prep me for my meeting with Jordan in 30 minutes"
> ... pulls dossier, shared history, recent activity, open threads

> "What have I said about the relationship between shame and founder performance?"
> ... searches YOUR thinking, not the internet

## Minions: your sub-agents won't drop work anymore

A durable, Postgres-native job queue built into the brain. Every long-running agent task is now a job that survives gateway restarts, streams progress, gets paused / resumed / steered mid-flight, and shows up in `gbrain jobs list`. Zero infra beyond your existing brain.

### The production numbers that matter

Here's my personal OpenClaw deployment: one Render container. Supabase Postgres holding a 45,000-page brain. 19 cron jobs firing on schedule. Real gateway load from real daily work. The task: pull a month of my social posts from an external API and ingest them end-to-end into the brain as a structured page.

|              | Minions   | `sessions_spawn`               |
|---           |---        |---                             |
| Wall time    | **753ms** | **>10,000ms** (gateway timeout) |
| Token cost   | **$0.00** | ~$0.03 per run                 |
| Success rate | **100%**  | **0%** (couldn't even spawn)   |
| Memory/job   | ~2 MB     | ~80 MB                         |

Under that 19-cron load, sub-agent spawn couldn't clear the 10-second gateway wall. Minions landed it in under a second for zero tokens. **Scaling:** 19,240 posts across 36 months, single bash loop, ~15 min total, $0.00. Sub-agents: ~9 min best case, ~$1.08 in tokens, ~40% spawn failure. **Lab:** durability ∞ (SIGKILL mid-flight, 10/10 rescued), throughput ~10× faster, fan-out ~21× with no failure wall, memory ~400× less.

Full benchmarks live in [gbrain-evals](https://github.com/garrytan/gbrain-evals/tree/main/docs/benchmarks).

### The routing rule

> **Deterministic** (same input → same steps → same output) → **Minions**
> **Judgment** (input requires assessment or decision) → **Sub-agents**

Pull posts, parse JSON, write a brain page, run a sync — deterministic. $0 tokens, survives restart, millisecond runtime. Triage the inbox, assess meeting priority, decide if a cold email deserves a reply — judgment. What sub-agents are actually good at. `minion_mode: pain_triggered` (the default) automates the routing.

### What's fixed

The six daily pains — spawn storms, agents that stop responding, forgotten dispatches, gateway crashes mid-run, runaway grandchildren, debugging soup — all belonged to the "deterministic work through a reasoning model" mistake. Minions fixes them by not making that mistake: `max_children` cap, `timeout_ms` + AbortSignal, `child_done` inbox, full `parent_job_id`/`depth`/transcript per job, Postgres durability with stall detection, cascade cancel via recursive CTE. Plus idempotency keys, attachment validation, `removeOnComplete`, and `gbrain jobs smoke` that proves the install in half a second.

```bash
gbrain jobs smoke                        # verify install
gbrain jobs submit sync --params '{}'    # fire a background job
gbrain jobs stats                        # health dashboard
gbrain jobs supervisor --concurrency 4   # canonical: auto-restarting worker (Postgres only)
gbrain jobs work --concurrency 4         # raw worker (no crash recovery — prefer `supervisor`)
```

`gbrain jobs supervisor` keeps the worker alive across crashes with exponential backoff, atomic PID locking, structured audit events at `~/.gbrain/audit/supervisor-*.jsonl`, and a `start --detach` / `status --json` / `stop` subcommand surface for agents. In containers it runs as PID 1; on systemd hosts it's the child of `gbrain-worker.service`. Full deployment guide: [`docs/guides/minions-deployment.md`](docs/guides/minions-deployment.md).

Read [`skills/minion-orchestrator/SKILL.md`](skills/minion-orchestrator/SKILL.md) for parent-child DAGs, fan-in collection, steering via inbox.

**Minions is not incrementally better than sub-agents for background work. It's categorically different.** 753ms vs gateway timeout. $0 vs tokens. 100% vs couldn't-spawn. If your agent does deterministic work on a schedule, it runs on Minions now.

### Health check and self-heal

Minions is canonical as of v0.11.1 — every `gbrain upgrade` runs the migration automatically (schema → smoke → prefs → host rewrites → env-aware autopilot install). If you ever want to verify manually or wire a cron into your morning briefing:

```bash
gbrain doctor                    # half-migrated state? prints loud banner + exits non-zero
gbrain skillpack-check --quiet    # exit 0/1/2 for pipeline gating
gbrain skillpack-check | jq       # full JSON: {healthy, summary, actions[], doctor, migrations}
```

If anything's off, `actions[]` tells you the exact command to run. For deeper troubleshooting: [`docs/guides/minions-fix.md`](docs/guides/minions-fix.md).

Moving gateway crons to Minions (deterministic scripts, zero LLM tokens per fire): [`docs/guides/minions-shell-jobs.md`](docs/guides/minions-shell-jobs.md).

## Durable agents: `gbrain agent` (v0.15)

Your subagent runs survive crashes now. OpenClaw died mid-run? The worker re-claims on restart and replays from the last committed turn. Fan-out across 50 shards, one shard crashes — the aggregator still claims after every child reaches a terminal state and writes a mixed-outcome summary. Tool calls persist as a two-phase ledger (`pending` → `complete | failed`) so replay is safe by construction, not by hope.

```bash
# Submit a single-subagent run
gbrain agent run "summarize my last 10 journal pages"

# Fan out N prompts across N subagent children + 1 aggregator
gbrain agent run "analyze every page" \
  --fanout-manifest manifests/pages.json \
  --subagent-def analyzer

# Tail a running job (heartbeat per turn + full transcript on completion)
gbrain agent logs 1247 --follow --since 5m
```

Durability is the point: every Anthropic turn commits to `subagent_messages`, every tool call to `subagent_tool_executions`. Worker kills, OpenClaw crashes, timeouts — all resumable. Host repos (your OpenClaw, etc.) ship their own subagent definitions via `GBRAIN_PLUGIN_PATH` + a `gbrain.plugin.json` manifest: see [`docs/guides/plugin-authors.md`](docs/guides/plugin-authors.md). Requires `ANTHROPIC_API_KEY` on the worker.

## Skillify: say "skillify it!" and the bug becomes structurally impossible to repeat

Your OpenClaw hit a new failure. You fix it once in conversation. You say "skillify it!"
And now the fix is permanent: a SKILL.md with triggers, a deterministic script with tests, a
routing fixture the agent re-evaluates daily, a filing audit that keeps the output from
drifting. Ten items. Every one required. The bug can't recur.

Hermes and similar agent frameworks auto-create skills as a background behavior. Fine until
you don't know what the agent shipped. Checklists decay. Tests drift. Resolver entries get
stale. Six months later it's an opaque pile nobody has read, nobody has tested, and nobody
is sure still works. GBrain ships the same capability except the human stays in the loop
and every step is a command you can run.

### The four verbs you need (v0.19)

```bash
# 1. Scaffold all 5 stub files for a new skill in one shot.
gbrain skillify scaffold webhook-verify \
  --description "verify ngrok webhooks" \
  --triggers "verify the webhook,check tunnel" \
  --writes-pages --writes-to people/,companies/

# 2. Replace the SKILLIFY_STUB sentinels with real logic + real tests.
$EDITOR skills/webhook-verify/scripts/webhook-verify.mjs
$EDITOR test/webhook-verify.test.ts

# 3. Run the 10-item audit: SKILL.md exists, script exists, unit + E2E tests,
#    LLM evals, resolver entry, trigger eval, check-resolvable gate, brain filing.
gbrain skillify check skills/webhook-verify/scripts/webhook-verify.mjs

# 4. Verify the whole tree: reachability, MECE overlap, DRY, routing gaps,
#    filing audit, SKILLIFY_STUB sentinels (fails if any skill still has one).
gbrain check-resolvable              # warnings advisory, errors block
gbrain check-resolvable --strict     # warnings block too (CI opt-in)
```

Idempotent re-runs. `--force` regenerates stub files but NEVER duplicates a resolver row.
Scaffold completes in under 2 seconds. The real work (your rule, your script, your tests)
is what you spend time on. Everything else is boilerplate the CLI writes for you.

### `gbrain routing-eval` — catch the routing gaps your users actually hit

Drop a `routing-eval.jsonl` fixture next to any skill. Each line is `{intent, expected_skill,
ambiguous_with?}`. `gbrain check-resolvable` runs the structural layer by default; `gbrain
routing-eval` runs the same structural layer as a dedicated CI verb. The `--llm` flag is
accepted as a placeholder for a future LLM tie-break layer; in this release it emits a stderr
notice and runs structural only. False positives (wrong skill matched), missed routes (no
skill matched), and tautological fixtures (intent copies trigger verbatim) all surface as
specific advisories with the exact file:line to fix.

### Works on your OpenClaw, not just gbrain's repo

v0.19 teaches `gbrain check-resolvable` to accept `AGENTS.md` as a resolver file alongside
`RESOLVER.md`, at either the skills directory OR one level up (OpenClaw-native workspace-root
layout). The skill manifest auto-derives from walking `skills/*/SKILL.md` when `manifest.json`
is missing. Set `OPENCLAW_WORKSPACE=~/your-openclaw/workspace` and everything just works:

```bash
export OPENCLAW_WORKSPACE=~/your-openclaw/workspace
gbrain check-resolvable --verbose
# Auto-detects: AGENTS.md at workspace root, 107 skills derived from SKILL.md walk,
# 15 unreachable errors surfaced, 108 advisory warnings for overlaps and gaps.
```

First run on a real OpenClaw deployment found 15 unreachable skills out of 102 — about 15%
of the tree was dark. The essay's "skills the agent can never reach" footgun, now visible.

### `gbrain skillpack install` — drop 25 curated skills into your OpenClaw

The skills gbrain ships are a curated bundle. Install them into your workspace with
dependency closure (shared conventions come along), per-file diff protection (your local
edits are never clobbered without `--overwrite-local`), a file lock that serializes
concurrent installers, and an atomic managed-block update to your AGENTS.md so you can
see exactly what gbrain wrote.

```bash
gbrain skillpack list                          # 25 curated skills
gbrain skillpack install brain-ops             # one skill + its shared conventions
gbrain skillpack install --all                 # the full bundle
gbrain skillpack install brain-ops --dry-run   # preview; no writes
gbrain skillpack diff brain-ops                # compare bundle vs your local copy
```

Re-running is safe. The managed-block markers in your AGENTS.md let `skillpack install`
accumulate rows across separate single-skill installs instead of overwriting each other.
A receipt comment inside the fence (`<!-- gbrain:skillpack:manifest cumulative-slugs="..." -->`)
tracks what gbrain has installed across runs. `install --all` is the only path that prunes;
per-skill install never deletes what it didn't install. If you hand-add a row inside the fence,
gbrain preserves it on reinstall and emits a stderr notice telling your agent to investigate.

**Skillify is the piece that makes the skills tree survive six months of compounding work.**
Read [`skills/skillify/SKILL.md`](skills/skillify/SKILL.md) for the full 10-item checklist
and the anti-patterns it catches.

## Storage tiering: keep bulk content out of git (v0.22.11)

When your brain crosses 100K files and bulk machine-generated content (tweets, articles, transcripts)
becomes the size driver, declare which directories belong in git and which live in the database only.

```yaml
# gbrain.yml at the brain repo root
storage:
  db_tracked:
    - people/
    - companies/
    - deals/
  db_only:
    - media/x/
    - media/articles/
    - meetings/transcripts/
```

`gbrain sync` auto-manages your `.gitignore` for `db_only` paths. `gbrain export --restore-only --repo .`
repopulates missing files from the database (container restart, fresh clone, accidental rm).
`gbrain storage status` shows the tier breakdown.

Full guide: [docs/storage-tiering.md](docs/storage-tiering.md).

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
│  markdown files  │───>│  Postgres +   │<──>│  29 skills       │
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

## Knowledge Graph

Pages aren't just text. Every mention of a person, company, or concept becomes a typed link in a structured graph. The brain wires itself.

```
Write a meeting page mentioning Alice and Acme AI
  -> Auto-link extracts entity refs from content (zero LLM calls)
  -> Infers types: meeting page + person ref => `attended`
                   "CEO of X" pattern        => `works_at`
                   "invested in"             => `invested_in`
                   "advises", "advisor"      => `advises`
                   "founded", "co-founded"   => `founded`
  -> Reconciles stale links: edits remove links no longer in content
  -> Backlinks rank well-connected entities higher in search
```

```bash
gbrain graph-query people/alice --type attended --depth 2
# returns who Alice met with, transitively
```

The graph powers questions vector search can't: "who works at Acme AI?", "what has Bob invested in?", "find the connection between Alice and Carol". Backfill an existing brain in one command:

```bash
gbrain extract links --source db        # wire up the existing 29K pages
gbrain extract timeline --source db     # extract dated events from markdown timelines
```

Then ask graph questions or watch the search ranking improve. Benchmarked side-by-side against ripgrep-BM25, vector-only RAG (same embedder), and gbrain-with-graph-disabled: gbrain lands **P@5 49.1%, R@5 97.9%** on a 240-page Opus-generated rich-prose corpus, beating hybrid-nograph by **+31.4 points P@5**. Isolate the contribution: v0.11→v0.12 moved the same gbrain codebase from P@5 22.1% → 49.1% on identical inputs, so typed-link extract quality is load-bearing. Full scorecards + reproducible corpus: [gbrain-evals](https://github.com/garrytan/gbrain-evals).

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

## Why it works: many strategies in concert

The brain isn't one trick. Every retrieval question goes through ~20 deterministic
techniques layered together. No single one is magic; the win comes from stacking
them so each layer covers what the others miss.

```
Question
  │
  ├─ INGESTION (every put_page)
  │    ├─ Recursive markdown chunking (or semantic / LLM-guided)
  │    ├─ Embedding cache invalidation on edit
  │    └─ Idempotent imports (content-hash dedup)
  │
  ├─ GRAPH EXTRACTION (auto-link post-hook, zero LLM)
  │    ├─ Entity-ref regex (markdown links + bare slugs)
  │    ├─ Code-fence stripping (no false-positive slugs in code blocks)
  │    ├─ Typed inference cascade (FOUNDED → INVESTED → ADVISES → WORKS_AT)
  │    ├─ Page-role priors (partner-bio language → invested_in)
  │    ├─ Within-page dedup (same target collapses to one link)
  │    ├─ Stale-link reconciliation (edits remove dropped refs)
  │    └─ Multi-type link constraint (same person can works_at AND advises)
  │
  ├─ SEARCH PIPELINE (every query)
  │    ├─ Intent classifier (entity / temporal / event / general — auto-routes)
  │    ├─ Multi-query expansion (Haiku rephrases the question 3 ways)
  │    ├─ Vector search (HNSW cosine over OpenAI embeddings)
  │    ├─ Keyword search (Postgres tsvector + websearch_to_tsquery)
  │    ├─ Source-aware ranking (curated dirs outrank chat/daily swamp at SQL layer)
  │    ├─ Hard-exclude (test/ archive/ attachments/ .raw/ filtered before retrieval)
  │    ├─ Reciprocal Rank Fusion (score = sum 1/(60+rank) across both)
  │    ├─ Cosine re-scoring (re-rank chunks against actual query embedding)
  │    ├─ Compiled-truth boost (assessments outrank timeline noise)
  │    ├─ Backlink boost (well-connected entities rank higher)
  │    └─ Source-aware dedup (one CT chunk per page guaranteed)
  │
  ├─ GRAPH TRAVERSAL (relational queries)
  │    ├─ Recursive CTE with cycle prevention (visited-array check)
  │    ├─ Type-filtered edges (--type works_at, attended, etc.)
  │    ├─ Direction control (in / out / both)
  │    └─ Depth-capped (≤10 for remote MCP; DoS prevention)
  │
  └─ AGENT WORKFLOW (graph-confident hybrid)
       ├─ Graph-query first (high-precision typed answers)
       ├─ Grep fallback when graph returns nothing
       └─ Graph hits ranked first in top-K (better P@K and R@K)
```

End-to-end on the BrainBench v1 corpus (240 rich-prose pages, before/after PR #188):

| Metric                  | BEFORE PR #188 | AFTER PR #188 | Δ           |
|-------------------------|----------------|---------------|-------------|
| **Precision@5**         | 39.2%          | **44.7%**     | **+5.4 pts**|
| **Recall@5**            | 83.1%          | **94.6%**     | **+11.5 pts**|
| Correct in top-5        | 217            | 247           | **+30**     |
| Graph-only F1 (ablation)| 57.8% (grep)   | **86.6%**     | **+28.8 pts**|

Plus 5 orthogonal capability checks (identity resolution, temporal queries,
performance at 10K-page scale, robustness to malformed input, MCP operation
contract). All pass. Full report: [gbrain-evals](https://github.com/garrytan/gbrain-evals).

The point: each technique handles a class of inputs the others miss. Vector
search misses exact slug refs; keyword catches them. Keyword misses conceptual
matches; vector catches them. RRF picks the best of both. Compiled-truth boost
keeps assessments above timeline noise. Auto-link extraction wires the graph
that lets backlink boost rank well-connected entities higher. Graph traversal
answers questions search alone can't reach. The agent picks graph-first for
precision and falls back to keyword for recall. **All deterministic, all in
concert, all measured.**

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
  gbrain import <dir> [--no-embed] [--workers N]
                                        Import markdown (idempotent)
  gbrain sync [--repo <path>] [--workers N]
                                        Git-to-brain incremental sync
                                        (>100-file diffs auto-parallelize 4 workers on Postgres)
  gbrain export [--dir ./out/]          Export to markdown

FILES
  gbrain files list|upload|sync|verify  File storage operations

EMBEDDINGS
  gbrain embed [<slug>|--all|--stale]   Generate/refresh embeddings

LINKS + GRAPH
  gbrain link|unlink|backlinks          Cross-reference management
  gbrain extract links|timeline|all     Batch backfill from existing pages
                                        (--source db|fs, --type, --since, --dry-run)
  gbrain graph-query <slug>             Typed traversal (--type T --depth N
                                        --direction in|out|both)

JOBS (Minions)
  gbrain jobs submit <name> [--params JSON] [--follow]  Submit a background job
  gbrain jobs list [--status S] [--queue Q]             List jobs with filters
  gbrain jobs get|cancel|retry|delete <id>              Manage job lifecycle
  gbrain jobs prune [--older-than 30d]                  Clean completed/dead jobs
  gbrain jobs stats                                     Job health dashboard
  gbrain jobs smoke                                     One-command health check
  gbrain jobs work [--queue Q] [--concurrency N]        Start worker daemon

SKILLS (v0.19)
  gbrain skillify scaffold <name>       Create 5 stub files + idempotent resolver row
  gbrain skillify check [path]          10-item audit of a skill
  gbrain skillpack list                 Print the 25 curated skills in the bundle
  gbrain skillpack install <name>       Copy one skill + its shared conventions into target
  gbrain skillpack install --all        Install the full curated bundle
  gbrain skillpack diff <name>          Per-file diff: bundle vs target workspace
  gbrain check-resolvable [--strict]    Resolver audit (reachability, MECE, DRY, routing, filing,
                                        SKILLIFY_STUB). Accepts RESOLVER.md OR AGENTS.md.
  gbrain routing-eval [--llm] [--json]  Intent→skill routing accuracy on fixtures

ADMIN
  gbrain doctor [--json] [--fast]       Health checks (resolver, skills, DB, embeddings)
  gbrain doctor --fix [--dry-run]       Auto-fix DRY violations (delegate inlined rules to conventions)
  gbrain doctor --locks                 List idle-in-tx backends (57014 diagnostic, Postgres only)
  gbrain stats                          Brain statistics
  gbrain serve                          MCP server (stdio)
  gbrain serve --http [--port 3131]     HTTP MCP server with OAuth 2.1 + admin dashboard
                                        [--token-ttl 3600] [--enable-dcr]
                                        [--public-url URL] [--log-full-params]
  gbrain auth create|list|revoke|test   Legacy bearer token management
  gbrain auth register-client <name>    Register an OAuth 2.1 client
        --grant-types client_credentials,authorization_code
        --scopes "read write admin"
  gbrain auth revoke-client <client_id> Revoke an OAuth 2.1 client (cascade purges
                                        active tokens + auth codes via FK CASCADE)
  # OAuth 2.1 clients can also be registered from the /admin dashboard or
  # programmatically via oauthProvider.registerClientManual() for host-repo wrappers.
  gbrain integrations                   Integration recipe dashboard
  gbrain sources list|add|remove|...    Multi-source brain management (v0.18)
  gbrain dream [--dry-run] [--phase N]  8-phase maintenance cycle (lint→backlinks→sync→synthesize
                                        →extract→patterns→embed→orphans). v0.23 added synthesize +
                                        patterns: transcripts → reflections + cross-session themes.
  gbrain dream --input <file>           Ad-hoc transcript synthesis (implies --phase synthesize)
  gbrain dream --date YYYY-MM-DD        Synthesize a single day; --from/--to for backfill ranges
  gbrain check-backlinks check|fix      Back-link enforcement
  gbrain lint [--fix]                   LLM artifact detection
  gbrain repair-jsonb [--dry-run]       Repair v0.12.0 double-encoded JSONB (Postgres)
  gbrain orphans [--json] [--count]     Find pages with zero inbound wikilinks
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
- [Individual skill files](skills/) ... 28 standalone instruction sets (25 ship in the curated `gbrain skillpack install` bundle)
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

**Benchmarks:**
- [gbrain-evals](https://github.com/garrytan/gbrain-evals) ... BrainBench, the sibling repo that holds the eval harness, corpus, scorecards, and 4-adapter comparisons. Depends on gbrain; not installed alongside gbrain.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `bun run test` for the parallel unit-test fast loop (~85s on a Mac dev box, 3700+ tests) or `bun run verify` for the pre-push gate (privacy + jsonb + progress + test-isolation + wasm + admin-build + typecheck). For the full local CI gate (gitleaks + unit + all 29 E2E files in Docker, the same checks GH Actions runs), use `bun run ci:local` ... or `bun run ci:local:diff` for the diff-aware subset during fast iteration.

If you're working on retrieval or any of the search/embedding/ranking surface, set `GBRAIN_CONTRIBUTOR_MODE=1` in your shell rc and use `gbrain eval replay` to gate your changes against a snapshot of real captured queries — the dev loop is documented in [`docs/eval-bench.md`](docs/eval-bench.md). Capture is **off by default** for production users (no surprise data accumulation); the env var is the contributor opt-in.

PRs welcome for: new enrichment APIs, performance optimizations, additional engine backends, new skills following the conformance standard in `skills/skill-creator/SKILL.md`.

## License

MIT
