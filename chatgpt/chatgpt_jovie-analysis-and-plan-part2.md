
Mr. White: **yes, use it; don’t hard-fork it as the core yet.**

Use Ruflo as an **upstream engine / vendor layer**, then build **Jovie AgentOS** around it. Fork only if it proves stable and strategically core after 7–14 days.

## Read

Ruflo is real enough to test: ~32k stars, ~3.6k forks, MIT license, TypeScript-heavy, active releases, Claude Code/Codex/MCP positioning, and v3.5 claims production-grade multi-agent orchestration after thousands of commits. citeturn847025search0turn847025search3

Risk: it also has a huge surface area: hundreds of MCP tools, many releases, many open issues/PRs, and likely lots of moving parts. That is powerful, but dangerous to make the spine of Jovie before it proves reliability in our stack. citeturn847025search0turn847025search7

## Recommendation

**Phase 1: Vendor, wrap, benchmark.**  
Do not fork-and-own yet.

Structure:

```text
Jovie AgentOS
  ├─ Linear = source of truth
  ├─ HUD = control plane
  ├─ Hermes = Chief of Staff / local agents
  ├─ GBrain = memory
  ├─ OpenRouter free swarm = cheap cognition
  ├─ Ruflo = optional orchestration engine
  └─ Codex/Claude Code = implementation workers
```

Ruflo should be an **adapter**, not the boss.

## Why

Use Ruflo for:
- multi-agent swarm patterns
- MCP/tool registry ideas
- agent role libraries
- memory patterns
- routing/fallback concepts
- CLI/command inspiration
- reusable orchestration primitives

Do not let Ruflo own:
- Linear truth
- approval gates
- deploy decisions
- production mutations
- billing/auth/security edits
- your company state
- cost controls

Your moat is not Ruflo. Your moat is **Jovie-specific orchestration around product, users, YC, cash, and founder decisions**.

## Fork decision

### Do this now
Create an internal repo/folder:

```text
ops/agent-os/adapters/ruflo/
```

Build:
1. `ruflo-eval.md`
2. `ruflo-wrapper`
3. `ruflo-job-runner`
4. `ruflo-output-normalizer`
5. `ruflo-risk-gate`
6. `ruflo-to-linear-manifest`

### Fork only if it passes these gates

| Gate | Pass condition |
|---|---|
| Reliability | 50+ runs with <5% unusable outputs |
| Cost | No hidden paid model leakage |
| Control | All outputs become manifests, not direct actions |
| Integration | Linear/HUD/GBrain output clean |
| Security | No secrets, no destructive commands, no uncontrolled MCP tools |
| Velocity | Saves more time than it consumes |
| Maintenance | Upstream changes are manageable |

## Best first use cases

1. **Linear triage swarm**
   - Input: current issues + recent PRs.
   - Output: issue clusters, duplicates, priority order.
   - Risk: low.

2. **QA swarm**
   - Input: routes, Sentry, CI failures.
   - Output: test plans and candidate issues.
   - Risk: medium-low.

3. **Docs/skills swarm**
   - Input: AGENTS, CLAUDE, skills, docs.
   - Output: dedupe and compaction patches.
   - Risk: low.

4. **GTM lead swarm**
   - Input: scraped leads.
   - Output: ranked leads and outreach drafts.
   - Risk: low if no sending.

5. **PR review pre-pass**
   - Input: diff + issue.
   - Output: risk review before premium/bot review.
   - Risk: medium.

## What to avoid

Avoid launching Ruflo as:
- autonomous deployer
- autonomous repo-wide refactorer
- all-day coding swarm
- production operator
- replacement for Hermes Chief of Staff
- source of truth

That will create chaos and token/cognitive debt.

## Fastest test plan

**Day 1**
- Install Ruflo in isolated sandbox.
- Run 5 dry tasks against fake inputs.
- No repo write permissions.

**Day 2**
- Give it read-only Linear/GitHub snapshots.
- Ask for triage and issue manifests.
- Compare against Hermes output.

**Day 3**
- Let it produce Linear issue drafts only.
- No code, no PRs.

**Day 4–7**
- Run 3 recurring jobs:
  - Linear hygiene
  - QA gap scout
  - docs/skill dedupe
- Score outputs daily.

## Hermes prompt

```text
Evaluate Ruflo as an optional orchestration engine for Jovie AgentOS.

Do not replace Hermes. Do not give Ruflo production write access. Treat Ruflo as a vendored adapter candidate.

Goals:
1. Install/run Ruflo in an isolated sandbox.
2. Document capabilities, risks, required env vars, MCP tools, model routing, and unsafe surfaces.
3. Build a thin adapter plan where Ruflo outputs normalized Jovie delegation manifests.
4. Test three read-only jobs:
   - Linear triage swarm
   - QA gap scout
   - docs/skills dedupe doctor
5. Score each run on usefulness, correctness, cost, latency, format validity, and risk.
6. Produce a fork/no-fork recommendation after 50 runs or 7 days.

Hard rules:
- No production writes.
- No deploys.
- No outbound messages.
- No auth/billing/migration/security edits.
- No secrets copied into Ruflo.
- No direct Linear mutation until Tim approves.
- All outputs must become Jovie delegation manifests with owner, cost route, allowed actions, forbidden actions, verification, and HUD surface.

Decision standard:
- If Ruflo improves orchestration without becoming a maintenance sink, keep it as upstream adapter.
- If we need minor patches, maintain a small fork.
- If it becomes central and upstream velocity conflicts with our needs, fork hard later.
```

## Bottom line

**Use Ruflo immediately as an orchestration testbed.**  
**Wrap it, benchmark it, and steal the useful patterns.**  
**Fork later only if it proves it can become the backbone without increasing chaos.**


trigger.dev is open source right? should we just use that locally to deploy workers on our jobs?  and then it would be the same infra when we ship stuff to the cloud later?


I’ll verify Trigger.dev’s current self-hosting/open-source status and then map the practical local-to-cloud architecture for Jovie jobs.


Yes. **Trigger.dev is open source and self-hostable**; the repo is Apache-2.0, and the docs say self-hosting runs the webapp plus worker containers on your own infra. citeturn626732search0turn626732search3

## Recommendation

Use Trigger.dev as the **job runtime**, not the agent brain.

For Jovie:

```text
Hermes / Chief of Staff = decides what should run
Trigger.dev = schedules, queues, retries, observes jobs
OpenRouter free models = cheap cognition inside jobs
Linear/HUD/GBrain = source of truth + output surfaces
Codex/Claude = premium implementation workers
```

## Should we use it locally?

Yes, for these jobs:

- free model health checks
- Linear hygiene
- Sentry triage
- QA gap scout
- docs doctor
- GTM lead scoring
- YC fact drift watcher
- cost watchdog
- deploy readiness scout
- agent postmortem miner

Trigger is a strong fit because it gives you schedules, retries, queues, observability, long-running tasks, and later cloud deployment continuity. Their Cloud has features self-host lacks, like warm starts, autoscaling, and checkpoints, so local/self-host is great for founder ops, while Cloud is better for production-scale app workflows. citeturn626732search0

## Architecture

Local now:

```text
Mac mini / local machine
  ├─ Trigger.dev self-host webapp
  ├─ Trigger.dev worker
  ├─ Redis/Postgres
  ├─ Hermes scripts
  ├─ OpenRouter broker
  └─ outputs → /ops/artifacts + Linear drafts + HUD JSON
```

Cloud later:

```text
Trigger.dev Cloud or self-hosted VPS
  ├─ same task files
  ├─ same schedules
  ├─ same output schemas
  └─ production-grade queues/retries/observability
```

## Important distinction

Use Trigger for **durable jobs**, not for local terminal agents that need full repo access and interactive coding.

Good Trigger jobs:
- read data
- call models
- produce artifacts
- create issue drafts
- update HUD JSON
- notify Tim of decisions

Bad Trigger jobs:
- autonomous code editing
- merging PRs
- production deploys
- writing secrets
- sending investor/customer messages
- touching auth/billing/migrations

## Fast plan

1. **Spin up self-host Trigger locally with Docker.**
2. **Create `apps/jobs` or `packages/jobs`.**
3. **Add a shared `job-output.schema.ts`.**
4. **Build OpenRouter model broker as a library.**
5. **Port the first 3 jobs:**
   - `free-model-health-doctor`
   - `linear-triage-swarm`
   - `qa-gap-scout`
6. **Write outputs to HUD first, Linear second.**
7. **Move selected jobs to Trigger Cloud only when they need real uptime.**

## Hermes prompt

```text
Set up Trigger.dev as Jovie’s durable job runtime for local-first agent ops.

Goal:
Use self-hosted Trigger.dev locally to run scheduled jobs for Free Compute Swarm, QA, Linear hygiene, cost monitoring, GTM lead scoring, and YC fact drift. Keep the same task architecture deployable to Trigger.dev Cloud later.

Rules:
- Trigger runs jobs; Hermes remains Chief of Staff.
- OpenRouter calls go through a model broker.
- Jobs default to read-only analysis and artifact output.
- No outbound sends, deploys, merges, auth/billing/migration edits, or production data mutation.
- Every job emits a structured artifact for HUD ingestion.
- Human approval required for Linear mutation unless explicitly safe.

Create issues for:
1. Trigger.dev local self-host proof of concept
2. Shared job output schema
3. OpenRouter model broker task utility
4. free-model-health-doctor task
5. linear-triage-swarm task
6. qa-gap-scout task
7. HUD ingestion of Trigger job artifacts
8. migration plan from local Trigger to Trigger Cloud/self-hosted VPS

Acceptance:
- Trigger runs locally via Docker.
- One scheduled job runs end-to-end.
- Job output appears in `/admin/ops` seed/artifact data.
- Same task code can deploy to cloud later with env changes only.
- Kill switch exists for all scheduled jobs.
```

Bottom line: **yes, use Trigger.dev.** It is the right durable runtime for your cron swarm. Keep Hermes as the orchestrator, Trigger as the job runner, and Linear/HUD as the control plane.


Now go out and check this against using AI SDK and workflows and stuff like that, and ground it in our current code and our trajectory. Ground it in our ethos of not building twice, and then the possibility that agent orchestration is just the only thing we need to build, right? It's just an interface region orchestration, so effectively the end product and the internal product have so much crossover that UI stuff should not be rebuilt, tuning should not be rebuilt, and all these different things should not be rebuilt.

Eventually you effectively automate when you're out of the integration. Thinking about that trajectory can be to make the plan from now to the 10X version and map it accordingly. Also research again what other teams are building with and what other stacks are out there and stuff. Hardening it to make sure this is the optimal way to do it, and also pulling from trending repositories and from some of the top eight companies making topic and stuff to see what they're contributing to. Just get a big piece of all the kinds of different things and look at recent YC companies and stuff like that and recent job postings and stuff to see what kind of tech they're talking about and A16Z job loads and stuff. You can get a big picture of what's out there and tax it and ground it against what makes the most sense for us. 


I'm doing this for Microsoft workflows. We should also ground this in UI and stuff. Anything that's been designed for UI, we should be able to use this UI as much as possible. Whatever UI is published should be built to be private.
We should also be thinking about, for internal ops, to do virtual SDK or open ladder or something, to use free models, like NVIDIA free models and stuff like that, for the workflows and making sure that the workflow can use a free model. If it is a free model entirely, if that is the case, should anything be run on CI rather than locally? If it's currently on CI, we can take it off CI and run through this, and then generally build this out as a hardened plan rooted in the actual context of where we go.
Give me the phase build out so we are shipping in a comparatively small way and we can give it to one agent. It's like a swarm to just build and keep shipping and have every PR completely on by agent from once the plan starts being implemented through:
- QA exhaustive design review if it touches design
- a regular G-Stack reviewer ship
- land
Everything should go automatically through the G-Stack sales and stuff, and we should just ruflo for the orchestration. and mind what in flight

also just do 2 seocnd of research to see what open ai and anthropic and google have that competews with workflows and vercel and trigger etc and see if anything is worth it. if not thats fine.


I’ll ground this in Jovie’s repo, dependencies, workflows, open PRs, and Linear work, then map a small shippable phase plan around Ruflo, Trigger, AI SDK, and reusable UI.


Jovie already has provider-neutral AI SDK tooling, HUD AI ops, Hermes runtime support for Ruflo, and automation audits pointing to scope-judge/free-model swaps, so I’ll consolidate existing motion.


Mr. White, the optimal shape is:

> **Ruflo coordinates agents. Trigger runs durable jobs. Vercel AI SDK powers product AI/UI. OpenRouter free models do cheap internal cognition. GStack remains the quality gate. The same UI/workflow primitives serve internal ops and the customer product.**

Do **not** make CI the always-on brain. CI should verify code and publish check statuses. Local/self-hosted Trigger + Hermes/Ruflo should run the 24/7 free-model swarm.

## Current Jovie grounding

You already have the core pieces:

- Jovie uses `ai`, `@ai-sdk/gateway`, `@ai-sdk/react`, and `@ai-sdk/xai` in `apps/web/package.json`, so Vercel AI SDK is already part of the product stack. Trigger is not currently installed. fileciteturn31file0
- Hermes already has a typed runtime surface for `codex-cli`, `claude-code`, and `ruflo`, and its AI ops summary already models runs, blockers, recommendations, merge queue pressure, statuses, and dispatch availability. fileciteturn36file0
- Hermes dispatch already normalizes requests, validates paths/skills/verification commands, and sends a `hermes_cli_worker` GitHub repository dispatch. fileciteturn37file0
- The Hermes CLI worker workflow already supports `ruflo` as a runtime on a self-hosted `[self-hosted, hermes]` runner. fileciteturn38file0
- The local worker already maps `ruflo` to `ruflo swarm start -o <prompt> -s development`, so Ruflo is already partially embedded as an execution option. fileciteturn39file0
- You already have a Ruflo swarm rule file that defines lead/coder roles, claims, shared memory, progress tracking, pre-created worktrees, and a per-chunk ship recipe with `/qa --exhaustive`, `/ship`, and auto-merge. fileciteturn40file0
- The automation audit already found the current cron/agent matrix, identified Hermes CLI Worker as recently shipped via PR #8092, and named OpenRouter substitution candidates. It also says the Hermes worker should be kept if the self-hosted runner is ready. fileciteturn35file0

So this is already moving. The next move is consolidation, not reinvention.

## Key decision

Use this split:

| Layer | Use | Do not use for |
|---|---|---|
| **Vercel AI SDK** | Product-facing AI, chat, streaming, model gateway, structured calls inside app routes | Durable cron orchestration |
| **Trigger.dev** | Long-running jobs, schedules, retries, queueing, local-first background work | Multi-agent coding coordination by itself |
| **Ruflo** | Agent swarm coordination, claims, memory, multi-agent coding waves | Source of truth, deploy authority, product runtime |
| **OpenRouter free models** | Internal read-only cognition, triage, ranking, draft generation | Final code, security decisions, deployment decisions |
| **GitHub Actions CI** | Required checks, PR gates, deploy gates, auditable status checks | 24/7 exploratory cognition |
| **Linear/HUD** | Source of truth, approval queue, visible ops state | Hidden side-channel task state |

Trigger’s README matches the job-runtime need: TypeScript tasks, long-running work, retries, queues, cron schedules, structured inputs/outputs, waits, human-in-the-loop waitpoints, Vercel/git preview environments, and self-hosting. fileciteturn53file0

Ruflo’s package describes itself as an enterprise AI agent orchestration system for Claude Code with 60+ specialized agents, coordinated swarms, vector memory, MCP integration, and optional Codex support. It is useful, but it is also alpha-ish by package version and broad surface area, so keep it as an adapter/wrapper rather than the company’s hard dependency. fileciteturn52file0

## CI vs local/self-hosted

Use this rule:

> **If the output must be a GitHub check, run it in CI. If it is ongoing cognition, run it locally/self-hosted via Trigger.**

### Keep on CI

Keep these on GitHub Actions:

- PR CI
- typecheck/lint/test/build
- scope judge status check
- CodeRabbit/GStack review gates
- deploy/canary/Sentry gates
- auto-PR on agent push
- Linear sync on merge
- agent PR verify-ready
- any workflow whose output must block merge

### Move off CI / do locally with Trigger + Ruflo

Run these locally/self-hosted:

- free-model endpoint health checks
- Linear hygiene
- issue dedupe and clustering
- docs/skill dedupe
- model-tier spend ledger
- GTM lead scoring
- YC fact drift
- agent postmortems
- QA gap scouting
- design QA scouting
- Sentry pre-triage
- free-model nightly reports

These are noisy, iterative, and do not need to consume GitHub Actions minutes or pollute CI logs. They need persistence, retries, and dashboards. Trigger is a better fit.

### Exception

`scope-judge` should stay in CI because it publishes PR status. But the audit already identifies it as a strong OpenRouter free-model substitution candidate. fileciteturn35file0

## The UI principle

Build the orchestration UI as **private product UI**, using the same system the external product uses.

The repo’s UI rules already require shared component architecture: pure design-system atoms in `packages/ui/atoms`, app atoms/molecules/organisms under `apps/web/components`, and feature components under `features/{feature}`. If something is needed by multiple features, it should be promoted to shared atoms/molecules/organisms rather than duplicated across features. fileciteturn66file0

So:

```text
Internal HUD
  uses same cards, tables, drawers, command surfaces, approval queues

External artist product
  uses same workflow cards, task states, approval UI, agent status, notification surfaces

Different data + permissions
  same components
```

This is the “do not build twice” version.

Do not build an internal AgentOS dashboard as a random admin template. Build reusable primitives:

- `WorkflowRunCard`
- `AgentRunRow`
- `ApprovalQueue`
- `ModelRouteBadge`
- `VerificationGateList`
- `ArtifactViewer`
- `DiffRiskPanel`
- `HumanGateButton`
- `SwarmProgressBoard`
- `RunTimeline`
- `CostRouteIndicator`
- `DesignReviewPanel`

Then mount them privately in `/admin/ops` first. Later, expose the same primitives to artists as “Release Workflow,” “Campaign Workflow,” “AI Task Progress,” “Approval Required,” “Generated Draft,” etc.

## What this becomes at 10x

The internal product and external product converge.

Today:
```text
Tim asks Hermes to coordinate agents.
Agents produce PRs, issues, reports, drafts.
HUD shows company ops.
```

10x:
```text
Artist asks Jovie to run a release.
Jovie coordinates agents, jobs, approvals, drafts, campaigns, smart links, notifications.
Artist sees the same workflow surface Tim uses internally.
```

The product is not “artist dashboard + some AI.”  
The product becomes **agentic workflow orchestration for releases**.

Internal example:
```text
Bug found → issue → agent → QA → review → ship → deploy → postmortem
```

External example:
```text
Release detected → campaign plan → artist approval → smart link → fan alerts → playlist pitch → postmortem
```

Same primitives:
- task graph
- agent assignment
- evidence
- approvals
- cost route
- status
- artifacts
- review
- ship/launch

Different domain nouns.

## Ecosystem check

### OpenAI

OpenAI has Agents SDKs for Python and JavaScript/TypeScript. The JS/TS SDK describes multi-agent workflows, agents with instructions/tools/guardrails/handoffs, sandbox agents, MCP/hosted tools, human-in-loop, sessions, tracing, and realtime agents. fileciteturn60file0

Use it as a future option for product-agent orchestration, especially if OpenAI becomes your dominant product model vendor. Do not replace your current Vercel AI SDK stack with it now.

### Google

Google ADK is an open-source, code-first Python framework for building, evaluating, deploying, and orchestrating AI agents. It is optimized for Gemini, but model-agnostic and deployment-agnostic, with multi-agent systems, tool confirmation, Cloud Run/Vertex deployment, and a dev UI. fileciteturn69file0

Use it as a pattern source. It is Python-first and Google ecosystem-heavy, so it should not become Jovie’s primary TypeScript/Vercel orchestration layer.

### Microsoft

Microsoft AutoGen is now in maintenance mode, and its README points new users to Microsoft Agent Framework. fileciteturn62file0

Microsoft Agent Framework is production-oriented, supports Python and .NET, has graph-based sequential/concurrent/handoff/group workflows, checkpointing, streaming, human-in-the-loop, OpenTelemetry, declarative agents, agent skills, local/cloud hosting patterns, and provider flexibility. fileciteturn64file0

Use Microsoft Agent Framework as a serious reference architecture, especially for graph workflows, durable state, human gates, and observability. Do not adopt it as primary Jovie infra unless you are intentionally moving into Python/.NET/Azure Foundry.

### LangGraph

LangGraph positions itself as a low-level orchestration framework for long-running, stateful agents with durable execution, human-in-the-loop, memory, debugging, and deployment. fileciteturn65file0

It is the strongest “stateful graph agent runtime” reference. But Jovie already has a TypeScript/Next/Vercel stack, GStack, Hermes, Linear, and Ruflo. LangGraph would be a second orchestration universe. Do not add it now.

### Trigger.dev

Trigger is the best fit for Jovie’s durable TypeScript job runtime because it lives in code, has cron schedules, queues, retries, waits, human-in-loop waitpoints, structured inputs/outputs, preview branches, realtime hooks, and self-hosting. fileciteturn53file0

## Hardened recommendation

Do this:

```text
Jovie AgentOS
  Linear = source of truth
  HUD = private control plane
  Vercel AI SDK = model calls + product streaming UI
  Trigger.dev = durable job runtime
  Ruflo = swarm coordination adapter
  OpenRouter = free-model broker
  GStack = QA/review/ship/land discipline
  GitHub Actions = required code/deploy gates
```

Do not do this:

```text
Ruflo as source of truth
Trigger as product UI
OpenRouter free models editing code directly
CI as 24/7 cognition engine
Separate internal UI and external UI systems
LangGraph/Microsoft/Google ADK as new runtime dependency
```

## In-flight cleanup

Linear already has new AgentOS/HUD issues, and there are duplicates showing up:

- `HUD: Founder Ops Deployment System` appears as `JOV-1854` and `JOV-1906`.
- `HUD: ship read-only /admin/ops v0...` appears as `JOV-1864` and `JOV-1916`.
- `VELOCITY: Agent OS Cost + Duplication Control` appears as `JOV-1858` and `JOV-1910`.
- `OPS: create daily runway cron...` appears as `JOV-1861` and `JOV-1913`.
- `Audit crons + agent automation budgets...` is complete as `JOV-1901` and produced `docs/AUTOMATION_AUDIT.md`. fileciteturn41file0

First agent task should be **dedupe and attach**, not create more top-level projects.

## Phase buildout for one agent

### Phase 0 — One PR: consolidate current plan

**Goal:** make the repo describe the architecture without installing new infra.

**Issue:** `AgentOS: architecture decision record for Ruflo + Trigger + AI SDK`

**Allowed paths:**
```text
docs/
.claude/rules/
apps/web/types/
```

**Ship:**
- `docs/AGENT_OS_ARCHITECTURE.md`
- update `docs/AUTOMATION_AUDIT.md` with the decision
- update Linear duplicates by linking/marking duplicates, where allowed

**Acceptance:**
- Names the layers.
- Says what stays in CI and what moves to local Trigger.
- Defines “UI primitives are shared; data is private.”
- Defines “Ruflo adapter, not source of truth.”
- No code runtime changes.

### Phase 1 — One PR: shared run artifact schema

**Goal:** all jobs, agents, and UI use one object.

**Issue:** `AgentOS: shared run artifact schema`

**Allowed paths:**
```text
apps/web/types/
apps/web/lib/agent-os/
apps/web/tests/unit/agent-os/
```

**Build:**
```ts
AgentRunArtifact
AgentRunSource
AgentRunStatus
AgentRunKind
ModelRoute
HumanGate
VerificationGate
WorkflowArtifact
```

**Must include:**
- source: `trigger | github | linear | sentry | ruflo | hermes | ci`
- kind: `qa | design_review | code_review | triage | gtm | yc | cost | deploy_readiness`
- model route: `deterministic | openrouter-free | ai-sdk-gateway | claude-code | codex-cli`
- allowed actions
- forbidden actions
- human approval required
- linked Linear issue
- linked PR
- linked HUD surface
- verification results
- cost estimate

**Acceptance:**
- Zod schema.
- Unit tests.
- No UI yet.
- No Trigger install.

### Phase 2 — One PR: private HUD surface using existing UI

**Goal:** render run artifacts in `/admin/ops`.

**Issue:** `HUD: AgentOS run artifacts panel`

**Allowed paths:**
```text
apps/web/app/**/admin/**
apps/web/components/features/admin/**
apps/web/components/organisms/**
apps/web/lib/agent-os/
apps/web/tests/
```

**Build:**
- private/admin-only panel
- artifact list
- status badges
- model route badges
- approval queue
- verification gates
- run timeline placeholder

**UI rule:** use existing card/table/drawer primitives. Promote shared components if needed; do not build one-off HUD components that cannot be reused in the artist product.

**Acceptance:**
- admin-only
- seeded fixture data
- no external API
- design review required
- screenshot or Playwright route check

### Phase 3 — One PR: OpenRouter free model broker, deterministic first

**Goal:** create the model broker without running crons yet.

**Issue:** `AgentOS: OpenRouter free model broker`

**Build:**
- `selectModelRoute()`
- health ledger
- JSON validity score
- fallback list
- quarantine list
- hard kill switch
- no direct model calls outside broker

**Rules:**
- free models can draft/classify/rank
- no code mutation
- no outbound send
- no deploy
- no production data mutation
- no auth/billing/migration/security decisions

**Acceptance:**
- mocked tests
- no secrets logged
- deterministic fallback when no key configured
- cost route visible in artifact schema

### Phase 4 — One PR: Trigger local POC

**Goal:** add Trigger as local/self-hostable job runtime with one harmless job.

**Issue:** `AgentOS: Trigger.dev local worker POC`

**Build:**
- install Trigger SDK
- one task: `free-model-health-doctor`
- emits `AgentRunArtifact`
- writes local artifact JSON
- HUD can read fixture/artifact

**Do not yet:**
- move product crons
- touch Vercel cron schedules
- mutate Linear
- call paid models

**Acceptance:**
- task runs locally
- artifact appears in HUD fixture path
- kill switch works
- README says how to run locally and how to deploy later

### Phase 5 — One PR: Ruflo normalized adapter

**Goal:** keep Ruflo useful but boxed.

**Issue:** `AgentOS: Ruflo adapter normalized to AgentRunArtifact`

**Build:**
- wrapper around current Hermes `ruflo` runtime
- normalize Ruflo outputs to `AgentRunArtifact`
- require claims/HOT ZONE for coding tasks
- require GStack ship recipe
- reject unsafe payloads

**Acceptance:**
- dry-run only first
- tests for unsafe payload rejection
- no direct merge/deploy
- no direct Linear mutation

### Phase 6 — One PR: end-to-end agent PR pipeline policy

**Goal:** make every agent PR follow the same gates.

**Issue:** `AgentOS: enforce GStack QA/review/ship/land gates for Hermes/Ruflo PRs`

**Required sequence:**
1. implement from approved manifest
2. if UI touched: exhaustive design review
3. `/qa --exhaustive`
4. `/review`
5. `/ship`
6. land/auto-merge only if gates pass
7. postmortem artifact if failed

**Acceptance:**
- PR template/update workflow
- status artifact generated
- no bypass of existing CI
- human gate for protected surfaces

## What moves from CI into Trigger first

Move these or rebuild them as Trigger-side internal jobs:

| Job | Current place | New place | Why |
|---|---|---|---|
| Free model health | none | Trigger local | continuous model routing |
| Agent ops health report | missing | Trigger local | weekly/daily velocity signal |
| Linear hygiene | partially manual | Trigger local | cheap read-only cognition |
| Docs/skill dedupe | manual/agents | Trigger local | no CI needed |
| GTM lead rating | product cron risk | Trigger local/private | avoid product cron/API spend |
| YC fact drift | manual | Trigger local | compares docs/state daily |
| Agent postmortem miner | partial | Trigger local | learns from failures |
| QA gap scout | partial/nightly | Trigger local | proposes tests before CI |

Keep these in CI:

| Job | Why |
|---|---|
| Scope Judge | publishes PR status |
| Agent PR Verify Ready | PR gate |
| CI/build/test/typecheck | required correctness |
| Deploy/canary/Sentry gates | production protection |
| Linear sync on merge | merge event source |
| Auto PR on push | branch event source |

## Microsoft / OpenAI / Google verdict

Not worth switching the core.

- **Microsoft Agent Framework** is the best enterprise reference, especially because you are thinking about Microsoft-style workflows, but it is Python/.NET and Azure/Foundry-oriented. Use its graph/checkpoint/HITL patterns as inspiration. fileciteturn64file0
- **OpenAI Agents SDK JS/TS** is attractive and closer to your stack, but it would overlap with Vercel AI SDK and Hermes/Ruflo today. Use later if product-agent workflows need first-party OpenAI tracing/sandbox agents. fileciteturn60file0
- **Google ADK** is strong if you become Gemini/Vertex/Cloud Run centered; that is not Jovie’s current trajectory. fileciteturn69file0
- **LangGraph** is powerful for stateful graph agents, but adopting it now creates a second orchestration universe. fileciteturn65file0

## Final call

Use **Trigger + Ruflo + Vercel AI SDK**, with a Jovie-owned schema and HUD.

The thing you build is not another agent framework. The thing you build is:

> **A private orchestration surface that becomes the product orchestration surface.**

Everything else is replaceable adapter:

```text
Ruflo can change.
OpenRouter free models can rotate.
Trigger can move local → cloud.
OpenAI/Google/Microsoft can be plugged later.
The Jovie workflow artifact schema + UI + approval gates stay.
```

That is the “do not build twice” path.
