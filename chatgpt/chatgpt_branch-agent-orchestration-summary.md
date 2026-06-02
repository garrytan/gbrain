---
title: "Branch · Agent Orchestration Summary"
type: essay
created: 2026-05-07
updated: 2026-05-07
source: chatgpt-export
conversation_id: 69fbd9ac-136c-83e8-8945-9cfac4196326
message_count: 12
tags: [chatgpt, import, code, long-form]
---
# Branch · Agent Orchestration Summary

> Conversation ID: 69fbd9ac-136c-83e8-8945-9cfac4196326
> Created: 2026-05-07T00:15:41Z
> Updated: 2026-05-07T00:58:00Z
> Messages: 12

---

## User

This is the whole conversation I was having with the coding agent today, and I lost a bunch of context. Can you basically throw it in and summarize everything from today that is essential to how our agent orchestration should work? Kind of map it out based on what was in here so that I can give all the instructions back to the Aramys agent so we can continue building out the setup? 

---

## Assistant

I’ll synthesize the transcript into a practical Aramys handoff covering agent hierarchy, routing/delegation, model-cost policy, HUD architecture, repo/UI rules, commands, cadence, and active build priorities.

---

## User

hermes 

---

## Assistant

I’ll prioritize today’s context and include only older transcript details that materially affect the orchestration setup.

---

## User

pull in https://github.com/ruvnet/ruflo and gary tans gbrain. And then analyze all this and then harden the plan. And walk me through the steps of how I should orchestrate to the chief of staff to get all of this implemented and rolling and optimized so that things are moving. Basically, the plan should be sorted by what increases velocity. Acceleration is the most important, right? If doing one setup means that all of a sudden five agents are doing the next set of things and then they're working on something that unlocks ten people doing the next set of things, I mean, then compounding. I'd rather defer building product for two hours to set up some always-on agents than have four times the output every hour, because we'll get that time back by our two. You know what I mean? That's what I'm trying to work on right now. 

---

## Assistant

I’ll consolidate the lost context around Hermes as chief-of-staff, fold in Ruflo and GBrain as reference patterns, and produce velocity-ranked orchestration instructions for Aramys.

---

## User

armays is hermes thats A speech-to-text failure and then also just brought it in like any other recommendations. We are using the local memory and stuff and all that. 

---

## Assistant

I’ll treat Aramys/Armays/Aramuse as Hermes, assume local memory is already chosen, and frame the HUD as the control plane for spawning, tracking, and steering work.

---

## Assistant

I’ll order the stack around compounding capability: memory durability first, safer Claude/Codex engineering workflow second, then swarm/background-agent parallelism once the base is reliable.

---

## Assistant

Mr. White, use this as the hardened plan for **Hermes**.

The core synthesis is: **GBrain is memory, GStack is process, Ruflo is swarm/runtime, Hermes is the chief-of-staff router, and the HUD is the control tower.** The transcript already established Hermes as a cheap, delegating parent agent; Coder Orchestrator as the senior planner; local-first memory/HUD as mandatory; and GStack-style `/autoplan → /QA → /review → /ship` as the coding loop. fileciteturn0file0

## What changes after pulling in Ruflo + GBrain

### 1. GBrain should be installed first

GBrain is the local brain. It gives Hermes and every subagent durable recall over your markdown/docs/repos, with PGLite as the default no-server setup, optional Postgres/pgvector for scale, MCP tools, skills, graph links, timelines, recurring sync, and agent-facing brain ops. The install guide specifically says the three most important immediate skills are signal detection on every inbound message, brain-first lookup before external calls, and conventions for citations/backlinking. citeturn277261view1turn277261view2

**Recommendation:** install GBrain before scaling agents. Without shared memory, every additional agent increases context drift. With shared memory, every agent improves the system.

### 2. GStack should be the coding process layer

GStack is Garry Tan’s Claude Code workflow layer: CEO review, engineering review, design review, QA, review, security, shipping, browser QA, Codex second opinion, and `/autoplan`. Its own README frames the sprint as **Think → Plan → Build → Review → Test → Ship → Reflect**, and it explicitly supports Claude Code, Codex, OpenClaw, Hermes, and GBrain hosts. citeturn433198view0

**Recommendation:** install GStack immediately for Claude Code/Codex/Hermes and make Coder Orchestrator use it by default.

### 3. Ruflo should be sandboxed, then promoted

Ruflo is a full multi-agent runtime for Claude Code: swarms, memory, MCP, hooks, daemon, loop workers, workflows, cost tracker, observability, browser testing, test generation, and autonomous coordination. Its docs distinguish a lite plugin install from the full loop; the full loop includes 98 agents, 60+ commands, 30 skills, MCP server, hooks, and daemon. citeturn178571view0turn178571view1

**Recommendation:** do **not** make Ruflo the first thing that takes over the main repo. First install GBrain + GStack + HUD observability. Then install Ruflo in a sandbox worktree and promote only the parts that create velocity: `ruflo-core`, `ruflo-swarm`, `ruflo-autopilot`, `ruflo-loop-workers`, `ruflo-workflows`, `ruflo-cost-tracker`, `ruflo-observability`, `ruflo-testgen`, and `ruflo-browser`.

### 4. DeepSeek V4 Flash is a good Hermes candidate

DeepSeek V4 Flash is now listed on OpenRouter as `deepseek/deepseek-v4-flash`, released April 24, 2026, with 1,048,576 context and pricing of `$0.14/M` input tokens and `$0.28/M` output tokens. OpenRouter describes it as suited for coding assistants, chat systems, and agent workflows where responsiveness and cost efficiency matter. citeturn393739view0

**Recommendation:** Hermes can run on DeepSeek V4 Flash for routing, summarization, status synthesis, issue drafting, and delegation. Use stronger models only for Coder Orchestrator planning, architecture review, and high-stakes debugging.

---

# Hardened velocity-first architecture

```txt
Tim
  ↓
Hermes
Cheap chief-of-staff router
Brain-first, delegating, cost-aware
  ↕
GBrain
Local memory, canon docs, decisions, people, companies, tasks, timelines
  ↓
Specialist orchestrators
  ├── Coder Orchestrator
  │     Uses GStack
  │     Owns /office-hours, /autoplan, /plan-eng-review, /review, /qa, /ship
  │
  ├── Operations Agent
  │     Local processes, crons, memory sync, cost, OpenRouter burn, HUD events
  │
  ├── PR / Ship Agent
  │     Open PRs, comments, CI, branch updates, merge readiness
  │
  ├── QA / Test Agent
  │     Missing tests, Playwright, regression tests, backend wiring checks
  │
  ├── Performance Loop Agent
  │     Gmail-test/Lighthouse loop until green
  │
  ├── Design-System Auditor
  │     Jovie UI rules, excessive cards, duplicate borders, component drift
  │
  ├── GTM Agent
  │     Scraping, ICP, Instantly, funnel metrics
  │
  └── Fundraising / Content Agents
        YC, investor system, canon-safe content
```

The HUD sits beside this as the local control tower:

```txt
Hermes / agents / worktrees / Linear / GitHub / crons / cost / memory sync
                              ↓
                        local event log
                              ↓
                        Jovie HUD
```

The local event log can start as `.hermes/events.jsonl` or SQLite. Every agent writes lifecycle events: `created`, `assigned`, `running`, `blocked`, `needs_review`, `qa_failed`, `qa_green`, `pr_opened`, `merged`, `cost_warning`.

---

# Velocity-ranked implementation plan

## Rank 1 — Stop token bleed and define Hermes’ role

**Time:** 10–20 minutes  
**Velocity unlock:** prevents cash burn and forces delegation.

Hermes should immediately adopt this policy:

```md
Hermes does not do heavy work directly.

Hermes routes, delegates, tracks, summarizes, and escalates.

Default model:
- DeepSeek V4 Flash or equivalent cheap high-context model for routing/status.
- Local model only for simple summarization/status extraction if reliable.
- Strong planner model only for Coder Orchestrator planning and architecture.
- Claude Code/Codex subscription usage should be preferred for coding.

Every task must have:
- owner
- model/tool
- worktree/branch, if coding
- Linear issue, if non-trivial
- success condition
- cost budget
- status heartbeat
- next unlock
```

This is the highest-leverage first move because Hermes was already burning OpenRouter spend while doing work that should be delegated. fileciteturn0file0

---

## Rank 2 — Install GBrain and import local memory

**Time:** 30–60 minutes  
**Velocity unlock:** every future agent gets shared context.

Hermes should run this as an Operations Agent task:

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install && bun link

gbrain init
gbrain doctor --json
```

Then import:

```bash
# Create or use local brain repo
mkdir -p ~/brain
cd ~/brain
git init

# Import key context
gbrain import ~/brain --no-embed
gbrain embed --stale

# Backfill graph/timeline once content exists
gbrain extract links --source db
gbrain extract timeline --source db
gbrain stats
```

Import these sources first:

```txt
1. Today’s Wispr/Flow transcript
2. Jovie canon docs from Ops repo
3. Jovie repo AGENTS.md / CLAUDE.md / design docs
4. Jovie UI/design-system notes
5. Investor/fundraising notes
6. GTM/scraper/ICP notes
7. Existing Hermes/agent prompts
8. Linear/GitHub decision logs, once wired
```

Add recurring jobs:

```txt
Every 15 minutes:
- gbrain sync --repo ~/brain
- gbrain embed --stale

Nightly:
- memory consolidation
- entity sweep
- citation/source cleanup
- conversation synthesis
- cross-session pattern detection

Weekly:
- gbrain doctor --json
- gbrain embed --stale
```

GBrain’s guide specifically calls out recurring live sync, nightly “dream cycle,” and weekly doctor/embed jobs as the compounding layer. citeturn277261view1

---

## Rank 3 — Install GStack for Claude Code, Codex, Hermes

**Time:** 20–40 minutes  
**Velocity unlock:** turns coding from ad hoc prompting into a repeatable factory.

Install:

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack
./setup
```

Then install for other hosts where available:

```bash
cd ~/.claude/skills/gstack
./setup --host codex
./setup --host hermes
./setup --host gbrain
```

Add this to the project agent instructions:

```md
## GStack

All meaningful coding work must use GStack process.

Use:
- /office-hours for ambiguous product framing
- /autoplan for reviewed implementation plans
- /plan-eng-review for architecture/data flow/testing
- /plan-design-review for UI/design-system work
- /review for changed branches
- /qa for browser/test verification
- /ship for PR creation/readiness
- /land-and-deploy only after approval
- /document-release after meaningful shipped changes
- /codex for independent second opinion on risky changes
```

GStack’s README gives this exact pattern: install, use `/office-hours`, `/plan-ceo-review`, `/review`, `/qa`, and for OpenClaw-style agents, route feature work through `/autoplan → implement → /ship`. citeturn338654view1

---

## Rank 4 — Build the local HUD event layer

**Time:** 45–90 minutes  
**Velocity unlock:** makes it safe to run multiple agents.

Before scaling agents, build the smallest useful HUD loop:

```txt
Jovie app shell
  ↓
Hermes HUD page
  ↓
Reads local event source
  ↓
Shows:
- active agents
- task queue
- current worktrees
- recent decisions
- PRs
- Linear issues
- cost/model usage
- memory sync status
- crons/loop workers
- blockers
```

Minimum viable version:

```txt
Hello Tim
Active agents: 0
Open tasks: 0
Open PRs: unknown
OpenRouter spend today: unknown
GBrain sync: unknown
```

Then wire data one column at a time.

The transcript is explicit that the HUD should be local-first, use the Jovie app shell and shared Jovie UI, show useful progress every 10–20 minutes, avoid dense TweetDeck clutter, and make mock data visibly mock. fileciteturn0file0

---

## Rank 5 — Create the Coder Orchestrator and worktree factory

**Time:** 45–90 minutes  
**Velocity unlock:** unlocks parallel implementation safely.

Hermes should create a **Coder Orchestrator** profile with this contract:

```md
You are Coder Orchestrator for Jovie.

You do not directly implement unless the task is tiny.
You plan, split work, assign worktrees, enforce GStack, and coordinate coding agents.

Every coding task must have:
- Linear issue
- branch/worktree
- owner
- scope boundaries
- files allowed
- success criteria
- tests required
- design-system requirements
- rollback plan
- PR target
```

Worktree rule:

```txt
One agent = one worktree = one branch = one clear scope.
No two agents edit the same files unless Coder Orchestrator explicitly assigns ownership.
```

Initial parallelism target: **3–5 agents**, then scale to 8–12 after the HUD and worktree locks are stable. GStack’s docs describe 10–15 parallel sprints as possible, but also state that the sprint structure is what prevents ten agents from becoming ten sources of chaos. citeturn433198view0

---

## Rank 6 — Start always-on agents

**Time:** 60–120 minutes  
**Velocity unlock:** recurring work keeps moving without Tim prompting.

Start these first:

| Agent | Cadence | Job | Why it compounds |
|---|---:|---|---|
| Memory Sync Agent | 15 min | Sync/import/embed GBrain | Every agent gets fresher context |
| Cost Governor | 10–15 min | Track OpenRouter, Claude, Codex, model routing | Prevents hidden burn |
| PR Captain | 15–30 min | Review PRs, comments, CI, merge readiness | Keeps shipped work moving |
| QA/Test Gap Agent | continuous batch | Find missing tests, add regression tests | Makes parallel work safer |
| Design-System Auditor | batch | Convert repeated UI complaints into rules/issues | Stops Tim from repeating feedback |
| Performance Loop Agent | long-running | Lighthouse/Gmail-test loop until green | Turns idle agent time into speed |
| Ops Cleanup Agent | hourly | Stale branches, local servers, crons, resource cleanup | Keeps machine usable |

Every always-on agent must write to HUD and GBrain.

---

## Rank 7 — Add Ruflo in a sandbox

**Time:** 60–120 minutes  
**Velocity unlock:** autonomous loop workers and swarms.

Run Ruflo only after GBrain, GStack, and HUD logging exist.

Sandbox plan:

```txt
1. Create a clean sandbox worktree.
2. Install Ruflo using the current README path.
3. Add MCP server only in sandbox Claude Code config.
4. Test non-destructive tasks:
   - summarize repo
   - create dummy plan
   - run test discovery
   - generate docs
   - write to sandbox event log
5. Verify:
   - no unexpected repo mutations
   - no runaway token burn
   - no hidden background workers
   - no broken Claude/Codex config
   - HUD receives status
6. Promote selected plugins only.
```

Plugins worth promoting first:

```txt
ruflo-core
ruflo-swarm
ruflo-autopilot
ruflo-loop-workers
ruflo-workflows
ruflo-agentdb
ruflo-rag-memory
ruflo-testgen
ruflo-browser
ruflo-observability
ruflo-cost-tracker
ruflo-adr
```

Ruflo’s own docs list loop workers, workflows, agent memory, RAG memory, test generation, browser automation, observability, and cost tracking as native plugins, which map directly to the missing pieces in the current Hermes setup. citeturn178571view1

---

# The exact orchestration sequence to give Hermes

Paste this into Hermes:

```md
Hermes, your current objective is to maximize Jovie’s shipping velocity.

Acceleration beats immediate product work for the next two hours. Do not prioritize product features until the orchestration foundation is green.

Definitions:
- You are Hermes, the chief-of-staff router.
- You delegate hard.
- You use GBrain as the local memory layer.
- You use GStack as the coding workflow layer.
- You evaluate Ruflo as the swarm/runtime layer in a sandbox before promotion.
- You keep the Jovie HUD as the control tower.
- You minimize OpenRouter spend.
- You prefer Claude Code/Codex subscription usage for coding.
- You use cheap models for routing/status/summarization.
- You use strong models only for planning, architecture, and high-stakes review.

Step 1 — Cost and role lock
Create or update Hermes operating policy:
- Hermes does not code directly.
- Hermes does not perform long research directly.
- Hermes delegates to specialist agents.
- Hermes tracks owner, model, cost, branch, worktree, status, blocker, and success criteria for every task.
- Hermes writes every important decision to local memory.

Step 2 — GBrain
Assign Operations Agent:
- Install GBrain locally.
- Initialize local PGLite brain.
- Import today’s transcript, Jovie canon docs, Ops docs, Jovie repo docs, design-system notes, agent prompts, and current project instructions.
- Run embed, links extraction, timeline extraction, and doctor.
- Set live sync every 15 minutes.
- Set nightly memory consolidation.
- Set weekly doctor/embed check.
- Add rule: every agent must query GBrain before acting and write back decisions after acting.

Step 3 — GStack
Assign Coder Orchestrator:
- Install GStack for Claude Code.
- Install GStack for Codex and Hermes if supported.
- Add GStack section to Jovie project instructions.
- Coding work must use /office-hours, /autoplan, /plan-eng-review, /plan-design-review, /review, /qa, /ship as appropriate.
- No major coding without a reviewed plan.
- No ship without review and QA.

Step 4 — HUD event log
Assign HUD Agent:
- Create local event source: .hermes/events.jsonl or SQLite.
- Every agent writes lifecycle events.
- Build local HUD inside Jovie app shell.
- Start with Hello Tim.
- Add columns for active agents, queue, decisions, worktrees, PRs, Linear issues, cost, model usage, GBrain sync, crons, blockers.
- Use Jovie shared components.
- Make mock data clearly mock.
- Show useful visual progress every 10–20 minutes.

Step 5 — Coder Orchestrator and worktrees
Assign Coder Orchestrator:
- Create agent profile.
- Create worktree factory.
- One agent per worktree/branch/scope.
- Create Linear issue per distinct task.
- Add success criteria and test requirements to every issue.
- Start with 3–5 parallel coding agents, then scale only after HUD shows stable status.

Step 6 — Always-on agents
Start these loops:
- Memory Sync Agent
- Cost Governor
- PR Captain
- QA/Test Gap Agent
- Design-System Auditor
- Performance Loop Agent
- Ops Cleanup Agent

Each loop must:
- have a clear success condition
- report to HUD
- write decisions to GBrain
- avoid asking Tim to say continue unless genuinely blocked

Step 7 — Ruflo sandbox
Assign Operations Agent:
- Install Ruflo in a sandbox worktree only.
- Test non-destructive tasks first.
- Verify hooks, MCP, daemon, cost, memory, and event visibility.
- Promote only useful plugins after verification:
  - core
  - swarm
  - autopilot
  - loop-workers
  - workflows
  - testgen
  - browser
  - observability
  - cost-tracker
  - ADR
- Do not give Ruflo broad write access to the main repo until HUD observability and cost controls are green.

Step 8 — First productive swarm
Once steps 1–6 are green, launch the first parallel sprint:
1. HUD Agent: build event-log-backed HUD in Jovie shell.
2. PR Captain: clean open PRs and address comments.
3. QA Agent: identify missing tests behind recent bugs.
4. Design Auditor: convert Tim’s repeated UI feedback into reusable codebase rules and Linear issues.
5. Performance Agent: build the long-running Gmail/Lighthouse loop.
6. Ops Agent: local services, stale branches, crons, GBrain sync, cost tracking.

Every 20 minutes, report:
- what shipped
- what unlocked more parallelism
- what is blocked
- current cost/model usage
- next highest-velocity unlock
```

---

# What to defer

Defer normal product feature work until these are green:

```txt
1. Hermes cost policy active
2. GBrain installed and synced
3. GStack installed
4. HUD visible locally
5. Event log working
6. Coder Orchestrator profile created
7. Worktree factory working
8. At least 3 always-on agents reporting status
```

This is the point where the system starts compounding. Before that, more product work creates more unmanaged threads.

---

# Highest-leverage first sprint

After the setup is green, run this first sprint:

```txt
Sprint name:
Hermes Velocity Foundation

Goal:
Make Jovie capable of running 3–5 parallel agents safely with shared memory, visible status, cost controls, and repeatable coding gates.

Agents:
1. Ops Agent
2. HUD Agent
3. Coder Orchestrator
4. PR Captain
5. QA/Test Gap Agent

Success criteria:
- HUD loads in Jovie shell
- GBrain can answer questions from today’s transcript and canon docs
- GStack commands are available
- Hermes has cost/model policy
- At least 3 agents can run in separate worktrees
- Every active task appears in HUD
- Every task has owner/status/success criteria
- OpenRouter spend is visible
- PR status is visible
- Memory sync status is visible
```

The practical answer: **yes, defer product for two hours**. The first two hours should create the operating system that lets five agents work cleanly. The goal is to reach the point where product work becomes a queue that Hermes continuously decomposes, assigns, reviews, tests, and ships.

---

## User

go wide and think of the world class 100x version of this and what we could be automating today that will get us to default alive faster.

---

## User

take repo context too
