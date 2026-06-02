---
title: "Jovie Analysis and Plan"
type: essay
created: 2026-05-07
updated: 2026-05-08
source: chatgpt-export
conversation_id: 69fcff88-de48-83e8-815f-62b8cbd5bfc9
message_count: 23
tags: [chatgpt, import, code, long-form]
---
# Jovie Analysis and Plan

> Conversation ID: 69fcff88-de48-83e8-815f-62b8cbd5bfc9
> Created: 2026-05-07T21:09:29Z
> Updated: 2026-05-08T02:33:04Z
> Messages: 23


analyze everything about jovie. memory, repos, recent prs, everythnng.

then lock out a plan for me to hand to my cheif of staff agent to work through and open stacks of issues for what we need to do. propose everything first. we would want a plan for moving to high velocity shipping with our hud deployment system and getting our yc application in with our demo video and then getting ourselveds default alive absed on our 400 dollars in the bank.  work extensively and layout the whole plan.


i generally agree lets start opening up issues and reoganize linear around this so i can exectue fast. and give me one prompt to hand off to cheif of stafff herrmes agent 

try to structure this as infra as we build

for example if auth is down becaus e a test didnt cover it lets build on a refular cron to fix testing.

if we need users build on a cron and skill to get users and a skill to improve on that skill. etc. and restructure in a comeplling way to minimize duplication and cost. but ecerything we build should serrve both improving the prouct and improving the company velocity.


Mr. White, I’ll turn this into a Linear operating system: projects, issue stacks, recurring infra loops, and a Hermes handoff prompt. I’ll inspect available Linear/GitHub context first, then create the minimum useful structure around product velocity, reliability, growth, YC, and default-alive survival.


I’ve confirmed Linear is currently read-only here, so I’ll produce an exact Hermes issue-opening manifest. Existing work already clusters around YC, HUD/deployment, QA/reliability, growth, and agent-velocity guardrails.


Mr. White, I could not directly create or update Linear issues from the current connector because it exposes read/search/fetch actions, but no create/update issue action. I prepared the exact reorg and issue stack for Hermes to open in Linear in one pass.

## Current readout

Jovie already has the bones of the operating system. The missing piece is turning scattered work into compounding loops.

The repo contract already defines the right agent boundaries: Chief of Staff/default profiles should prioritize, dispatch, verify, and update HUD/Linear without coding; coder agents implement assigned manifests only; non-coding agents should produce delegation manifests with KPI, owner, runtime, cost route, GBrain queries, skills, output, and verification. fileciteturn20file0

Automation burn controls are already moving in the right direction: routine Linear AI dispatch defaults to economy tier, agent PR creation is capped at 5 open PRs, and agents are instructed to inspect targeted diffs/files instead of repeatedly rereading broad context. fileciteturn21file0

The existing company state says the North Star is MRR, current bottleneck is onboarding activation stability, and the strategy is no new features until users are paying or explicitly saying why they are not paying. It also requires Tim approval for merges, deploys, investor/customer emails, and Instantly campaigns. fileciteturn22file0

The YC application doc is stale against your current cash position. It still says `$4,760` in the bank and `~6 weeks` runway, while your current instruction says `$400`. Treat `$400` as the operating truth until CFO/Hermes verifies bank/cash. The YC doc also still has P0 TODOs for founder video, product demo, coding session, SMS demand-loop demo, lead count update, and submission. fileciteturn23file0

YC’s on-time Summer 2026 application deadline was May 4, 2026 at 8:00 PM PT, but YC says late applications are still considered. Founder videos should be one minute with founders talking, not a product demo; the demo belongs separately. citeturn782228search1turn782228search0

## New Linear operating model

Reorganize Linear around **six operating loops**, not feature silos.

| Loop | Purpose | Existing anchors | Rule |
|---|---|---|---|
| **1. Default Alive War Room** | Keep company alive with $400, freeze burn, bridge cash, update truth | Ops `company_state.md`, YC finance answers | Every issue must reduce spend, increase cash probability, or remove a survival blind spot |
| **2. HUD Deployment System** | Founder command center for approvals, deploys, runway, YC, priorities | `JOV-1846` Operational HUD | Every ops workflow eventually surfaces in `/admin/ops` |
| **3. Reliability Loops** | Turn every production failure into tests, crons, canaries, and skills | `JOV-1848`, `JOV-1850`, `JOV-1849`, PR #8081 | Every bug fix creates or improves a detector |
| **4. User Acquisition Loop** | Turn user need into repeatable acquisition infra | Alert Growth issues, SMS demand loop, YC GTM answer | Every outreach sprint produces leads plus a better sourcing/outreach skill |
| **5. YC Late Submission Pack** | Submit late with videos, demo, corrected metrics, and weekly update system | Ops PR #52, YC doc TODOs | Submit now; optimize after submission through updates |
| **6. Agent Velocity & Cost Control** | Make shipping faster and cheaper without duplicate agent work | PR #8085, #8080, #8079, #8083 | Every automation must have a cost route, cap, owner, and kill switch |

The invariant for every Linear issue:

> **Product output + velocity output.**  
> Product output ships value, fixes a path, submits an application, gets users, or saves cash. Velocity output adds a cron, test, skill, manifest, HUD panel, runbook, metric, or reusable primitive.

## Linear reorg to apply

Do not delete or archive aggressively. Reclassify active work by attaching/moving it into the six loops.

### Keep as active projects

1. **Launch: YC S26** → rename or treat as **YC Late Submission + Launch**
2. **Infra & CI/CD** → fold active issues into **Reliability Loops** and **Agent Velocity & Cost Control**
3. **MVP Stability** → fold into **Reliability Loops**
4. **Analytics & Growth** → fold into **User Acquisition Loop**
5. **Design V1 Rollout / Flag Hardening** → keep, but only as product surface work that supports demo, activation, or reliability

### Put on hold unless directly tied to demo/users/revenue

- UI Polish
- Storybook Organisms coverage
- broad apps/web Consolidation Backlog
- Design polish PRs that do not improve YC demo, onboarding, public profile conversion, or alert demand loop

## Issue stack to create

Use team **Jovie**, cycle **current**, and existing labels. For any issue touching auth, billing, migrations, proxy, deploy/config, or security, add `human-review-required`.

### Parent 1 — `OPS: Default Alive War Room`

**Priority:** Urgent  
**Labels:** `type:epic`, `area:ops`, `launch-blocker`  
**Project/initiative:** Default Alive War Room

**Description:**
Create the operating loop that keeps Jovie alive with current cash constraint of `$400` until CFO verification says otherwise. This is not a dashboard-only task. It must produce a daily decision system: cash truth, burn freeze, bridge path, YC late submission path, and spend controls.

**Child issues:**

1. `CFO: reconcile bank balance, burn, and runway to current source of truth`
   - Product output: corrected company finance numbers for YC, investor docs, and HUD.
   - Velocity output: `company_state.md` finance sync checklist + daily cash field schema.
   - Acceptance: bank balance, current obligations, next 14-day cash needs, vendor list, and runway are written in Ops and HUD seed data.

2. `OPS: freeze nonessential spend and create vendor kill-switch list`
   - Product output: cash preserved.
   - Velocity output: vendor ledger with keep/cut/defer labels and owner.
   - Acceptance: every recurring tool has cost, renewal date, owner, action, and impact.

3. `OPS: create daily runway cron / no_agent report`
   - Product output: daily runway visibility.
   - Velocity output: deterministic no-agent cron that reads ledger and emits HUD-ready JSON/markdown.
   - Acceptance: no LLM calls; report includes balance, burn, next payments, runway days, and alerts.

4. `FUNDRAISE: open bridge micro-process from warm angels and Speedrun scouts`
   - Product output: cash path.
   - Velocity output: reusable investor outreach tracker and prompt.
   - Acceptance: 20 warm targets, status, intro source, ask amount, next action; no emails sent without Tim approval.

5. `OPS: reconcile YC/accelerator docs against current cash and deadline reality`
   - Product output: no stale application facts.
   - Velocity output: accelerator facts validator checklist.
   - Acceptance: YC doc, tier-1 tracker, and company_state agree on cash, burn, runway, status, and date.

### Parent 2 — `HUD: Founder Ops Deployment System`

**Priority:** Urgent  
**Labels:** `type:epic`, `area:ops`, `area:infra`  
**Attach existing:** `JOV-1846`

`JOV-1846` already describes the operational HUD: `/admin/ops`, personal priorities, approval queue, AI priority assessment, YC signals, subscriptions, content orchestration, knowledge statements, bottlenecks, and core values. Use it as the parent design source. fileciteturn25file0

**Child issues:**

1. `HUD: ship read-only /admin/ops v0 with seeded real company state`
   - Product output: founder can see survival, YC, deploy, and approval state.
   - Velocity output: HUD data contract used by future crons.
   - Acceptance: no external dependencies; admin-only; sections render; seeded from Ops markdown or static JSON.

2. `HUD: deployment readiness panel from GitHub, Vercel, Linear`
   - Product output: faster deploy decisions.
   - Velocity output: reusable deploy status schema.
   - Acceptance: shows latest prod SHA, open PRs, blocked PRs, canary/CI state, rollback candidate.

3. `HUD: approval queue for deploys, outbound, spend, and high-risk PRs`
   - Product output: Tim sees only decisions needing him.
   - Velocity output: one approval manifest shape for all agents.
   - Acceptance: items have decision, risk, owner, expiry, proposed action, and “why now.”

4. `HUD: voice-correctable knowledge statements`
   - Product output: faster founder corrections.
   - Velocity output: durable company memory update queue.
   - Acceptance: every statement has reference code, source, confidence, accept/reject/modify state.

5. `HUD: daily no_agent refresh cron`
   - Product output: fresh state without Tim manually asking.
   - Velocity output: deterministic daily refresh pipeline.
   - Acceptance: no premium model calls; output can be reviewed before writing to shared memory.

### Parent 3 — `RELIABILITY: Every Bug Becomes a Detector`

**Priority:** Urgent  
**Labels:** `type:epic`, `testing`, `area:infra`, `qa:e2e`, `launch-blocker`  
**Attach existing:** `JOV-1848`, `JOV-1850`, `JOV-1849`, `JOV-1837`, `JOV-1831`, `JOV-1835`

`JOV-1848` already defines the exhaustive QA campaign and the right shipping rules: one child per confirmed bug, isolated coder sessions, one concern per PR, small diffs, `/qa`, `/review`, `/ship`, `/land-and-deploy`, and human gates for auth, billing, onboarding, claim, migrations, proxy, deploy/config, and security-sensitive changes. fileciteturn26file0

**Child issues:**

1. `CI: finish deterministic scope-judge no-secret skip`
   - Existing: `JOV-1850`
   - Product output: fewer blocked PRs.
   - Velocity output: no LLM token burn when secrets missing.
   - Acceptance: when `OPENAI_API_KEY` absent, workflow publishes deterministic skip; when present, true failures still block. fileciteturn27file0

2. `Testing: land nightly testing agent and wire first daily report`
   - Existing PR: #8081
   - Product output: ongoing regression detection.
   - Velocity output: nightly risk scoring + Stryker mutation hotspot lane.
   - Acceptance: CodeRabbit review unpaused/resolved, E2E cancellation explained or fixed, report artifact produced, cost path documented.

3. `Testing: auth/signup/onboarding golden-path cron`
   - Product output: auth/onboarding outages caught before users.
   - Velocity output: stable daily test lane for Clerk proxy, signup, onboarding, first app entry.
   - Acceptance: covers `/signin`, `/signup`, Google OAuth proxy, Clerk bypass, `/app`, onboarding happy path; failures open/attach Linear child issue.

4. `Testing: public profile + alert demand-loop canary`
   - Product output: public profile and SMS alert wedge stays live.
   - Velocity output: canary fixture and route QA expansion.
   - Acceptance: tests profile, `/[handle]/alerts`, source code, SMS/email fallback, notification subscription, demand request, claim view.

5. `Testing: bug-to-test rule enforced in PR template and ship flow`
   - Product output: fewer repeat bugs.
   - Velocity output: every bug PR requires “new detector or why impossible.”
   - Acceptance: PR template and `/ship` checklist updated; no duplicate prose in leaf skills.

6. `Testing: flaky quarantine + retry budget dashboard`
   - Product output: CI stops wasting time.
   - Velocity output: quarantine ledger, retry cap, owner, expiration.
   - Acceptance: every flaky test has owner, first seen, reproduction, fix issue, and expiration.

### Parent 4 — `GTM: Users Become Infrastructure`

**Priority:** Urgent  
**Labels:** `type:epic`, `area:analytics`, `area:ops`, `launch-blocker`  
**Attach existing:** `JOV-1843`, `JOV-1841`, `JOV-1845`, relevant Alert Growth/SMS issues

**Child issues:**

1. `GTM: manual 20-artist activation sprint`
   - Product output: first real user data.
   - Velocity output: repeatable activation playbook.
   - Acceptance: 20 artists, source, why they fit, profile status, outreach draft, claim link, result; no outbound without Tim approval.

2. `GTM: alert-demand metric instrumentation`
   - Product output: know whether wedge works.
   - Velocity output: event schema for profile visit → alert CTA → verified subscriber → demand request → artist claim.
   - Acceptance: events visible in analytics and HUD; no direct analytics imports outside canonical wrapper.

3. `GTM: lead scoring cron v0`
   - Product output: steady lead flow.
   - Velocity output: deterministic/economy sourcing script that ranks artists already using Linktree, smart links, or raw Spotify links.
   - Acceptance: produces ranked leads with reason, profile URL, Spotify/release signal, contact route, and confidence.

4. `GTM: outreach skill v0 for fan-demand claim messages`
   - Product output: better conversion.
   - Velocity output: reusable skill that drafts outreach from verified demand and artist facts.
   - Acceptance: drafts only; requires Tim approval before send; logs outcomes.

5. `GTM: improve-outreach-skill loop`
   - Product output: compounding conversion quality.
   - Velocity output: weekly retro that updates message variants from reply/claim data.
   - Acceptance: no new campaign launched until prior outcomes are summarized.

6. `GTM: prebuilt profile claim flow smoke test`
   - Product output: artists can claim without friction.
   - Velocity output: canary for claim link + onboarding + first publish.
   - Acceptance: one seed artist fixture can be prebuilt, claimed, onboarded, and published in test/staging.

### Parent 5 — `YC: Late Submission + Demo Pack`

**Priority:** Urgent  
**Labels:** `type:epic`, `area:ops`, `launch-blocker`  
**Project:** Launch: YC S26

**Child issues:**

1. `YC: correct application facts for May 7 late submission`
   - Product output: application is accurate.
   - Velocity output: application fact-check checklist.
   - Acceptance: cash, runway, deadline status, revenue, users, lead count, and current product state are reconciled.

2. `YC: record 1-minute founder video`
   - Product output: required founder video.
   - Velocity output: reusable founder video bullet outline.
   - Acceptance: one-minute founder-only video; no product demo in founder video; link or upload ready.

3. `YC: record product demo video`
   - Product output: demo attachment.
   - Velocity output: repeatable demo script for future investors.
   - Acceptance: profile → alert CTA → SMS intent → confirmation → demand request → claim/dashboard/release workflow.

4. `YC: record coding agent session / transcript`
   - Product output: optional YC coding evidence.
   - Velocity output: canonical “how Jovie ships” demo.
   - Acceptance: shows plan → Linear → agent execution → review → PR → deploy or CI gate.

5. `YC: late submit now, improve through updates`
   - Product output: application submitted.
   - Velocity output: weekly YC update pipeline.
   - Acceptance: submitted even if imperfect; follow-up update template created for traction, demos, users, reliability.

6. `YC: post-submit weekly update cron`
   - Product output: YC sees momentum.
   - Velocity output: weekly update generator pulling users, PRs, demos, revenue, reliability.
   - Acceptance: draft-only; Tim approval before sending.

### Parent 6 — `VELOCITY: Agent OS Cost + Duplication Control`

**Priority:** High  
**Labels:** `type:epic`, `area:infra`, `area:ops`, `automated`  
**Attach existing:** PR #8085, PR #8080, PR #8079, PR #8083

**Child issues:**

1. `Agent OS: enforce delegation manifest for all non-coding profiles`
   - Product output: fewer accidental edits and broken flows.
   - Velocity output: manifest schema plus validation.
   - Acceptance: every Chief/CFO/founder-os/code-orchestrator handoff includes KPI, owner, profile, runtime, cost route, GBrain queries, skills, output, verification.

2. `Agent OS: GBrain company-state sync`
   - Product output: fewer stale facts.
   - Velocity output: daily memory sync from Ops canonical docs.
   - Acceptance: no stale cash/date/YC status survives daily refresh.

3. `Agent OS: skill dedupe audit`
   - Product output: simpler agent use.
   - Velocity output: shared scripts/routing instead of duplicate leaf-skill prose.
   - Acceptance: identify duplicate skills/prompts; consolidate policy into shared contract; enforce size check.

4. `Agent OS: model-tier and spend ledger`
   - Product output: less cash burn.
   - Velocity output: daily AI cost route + cap.
   - Acceptance: economy default; premium only for approved architecture/product/YC/fundraising gates; daily report flags breaches.

5. `Agent OS: Linear hygiene sweep`
   - Product output: less founder attention waste.
   - Velocity output: weekly issue grooming system.
   - Acceptance: duplicates linked, stale canceled or parked, active issues attached to one of six loops, no orphan P0s.

## First 24 hours

1. **Default Alive:** verify `$400`, freeze spend, update YC/company docs.
2. **YC:** submit late today with corrected facts and minimum viable videos.
3. **Reliability:** finish `JOV-1850`, unblock `#8087`, land or park `#8081` with explicit E2E/CodeRabbit status.
4. **HUD:** create `/admin/ops` v0 as read-only seed, even if ugly.
5. **Users:** run 20 manual artist activation targets before building more automation.
6. **Velocity:** every new task uses the product+velocity invariant.

## First 72 hours

| Day | Outcome |
|---|---|
| Day 1 | YC late submitted, cash truth corrected, critical CI/QA blockers triaged |
| Day 2 | HUD v0 live, nightly testing agent landed or explicitly parked, 20-user activation sprint started |
| Day 3 | First conversion/readiness report: users contacted, claim funnel state, cash runway, open blockers, next 10 issues |

## Hermes Chief of Staff prompt

Copy/paste this as one handoff:

```text
You are Hermes, Chief of Staff agent for Tim White at Jovie.

Mission: reorganize Jovie Linear and execution around compounding infrastructure. Do not code. Prioritize, dispatch, verify, and update Linear/HUD. If product or CI code changes are needed, create a delegation manifest and dispatch the correct coder/profile. Follow the Jovie repo role boundary: Chief of Staff does not implement, merge, deploy, or send outbound messages.

Current operating truth:
- Tim says Jovie has about $400 in the bank. Treat this as source of truth until CFO verification.
- Existing Ops/YC docs may still show stale finance numbers. Reconcile them.
- YC S26 on-time deadline has passed, but late applications are still considered. Submit late ASAP rather than waiting for perfection.
- Every issue must produce both a product output and a velocity output.
- Default model tier is economy/deterministic. Premium models require explicit Tim approval unless the task is YC final answer, architecture risk, or fundraising-critical.
- No investor/customer emails, Instantly campaigns, production deploys, or merges without Tim approval.

First, read:
1. Jovie CLAUDE.md / AGENTS.md role boundary and Linear rules.
2. Ops company_state.md.
3. Ops YC application doc.
4. Current Linear projects and issues.
5. GitHub recent PRs for Jovie and Ops.
6. Vercel latest production/preview deployment status.

Reorganize Linear into these six operating loops:
1. OPS: Default Alive War Room
2. HUD: Founder Ops Deployment System
3. RELIABILITY: Every Bug Becomes a Detector
4. GTM: Users Become Infrastructure
5. YC: Late Submission + Demo Pack
6. VELOCITY: Agent OS Cost + Duplication Control

Do not delete history. Move/link/attach existing active work into these loops. Avoid duplicate issues. Search existing issues before creating new ones.

Create or reorganize these parent epics and children:

PARENT 1: OPS: Default Alive War Room
Children:
- CFO: reconcile bank balance, burn, and runway to current source of truth
- OPS: freeze nonessential spend and create vendor kill-switch list
- OPS: create daily runway cron / no_agent report
- FUNDRAISE: open bridge micro-process from warm angels and Speedrun scouts
- OPS: reconcile YC/accelerator docs against current cash and deadline reality

PARENT 2: HUD: Founder Ops Deployment System
Attach existing JOV-1846.
Children:
- HUD: ship read-only /admin/ops v0 with seeded real company state
- HUD: deployment readiness panel from GitHub, Vercel, Linear
- HUD: approval queue for deploys, outbound, spend, and high-risk PRs
- HUD: voice-correctable knowledge statements
- HUD: daily no_agent refresh cron

PARENT 3: RELIABILITY: Every Bug Becomes a Detector
Attach existing JOV-1848, JOV-1850, JOV-1849, JOV-1837, JOV-1831, JOV-1835.
Children:
- CI: finish deterministic scope-judge no-secret skip
- Testing: land nightly testing agent and wire first daily report
- Testing: auth/signup/onboarding golden-path cron
- Testing: public profile + alert demand-loop canary
- Testing: bug-to-test rule enforced in PR template and ship flow
- Testing: flaky quarantine + retry budget dashboard

PARENT 4: GTM: Users Become Infrastructure
Attach Alert Growth/SMS issues including JOV-1843, JOV-1841, JOV-1845 where relevant.
Children:
- GTM: manual 20-artist activation sprint
- GTM: alert-demand metric instrumentation
- GTM: lead scoring cron v0
- GTM: outreach skill v0 for fan-demand claim messages
- GTM: improve-outreach-skill loop
- GTM: prebuilt profile claim flow smoke test

PARENT 5: YC: Late Submission + Demo Pack
Children:
- YC: correct application facts for May 7 late submission
- YC: record 1-minute founder video
- YC: record product demo video
- YC: record coding agent session / transcript
- YC: late submit now, improve through updates
- YC: post-submit weekly update cron

PARENT 6: VELOCITY: Agent OS Cost + Duplication Control
Attach PR #8085, #8080, #8079, #8083 context where useful.
Children:
- Agent OS: enforce delegation manifest for all non-coding profiles
- Agent OS: GBrain company-state sync
- Agent OS: skill dedupe audit
- Agent OS: model-tier and spend ledger
- Agent OS: Linear hygiene sweep

For every issue, include:
- Product output
- Velocity output
- Owner profile: Chief/CFO/founder-os/code-orchestrator/coder/no_agent
- Cost route: deterministic/economy/premium-with-approval
- GStack skill(s)
- Verification command or acceptance check
- HUD surface affected
- Human approval requirement if it touches auth, billing, migrations, proxy, deploy/config, security, outbound messages, or spending

Immediate execution order:
1. Verify current cash and freeze spend.
2. Correct YC facts and submit late today with minimum viable videos.
3. Resolve scope-judge/JOV-1850 and unblock QA PRs.
4. Land or explicitly park the nightly testing agent with reason.
5. Ship /admin/ops v0 read-only HUD.
6. Start 20 manual artist activation sprint.
7. End each day with a report: cash/runway, YC status, users contacted, claims/signups, shipped PRs, blocked PRs, next 5 decisions for Tim.

Do not optimize for a perfect Linear taxonomy. Optimize for Tim executing fast with less duplication, lower cost, and every task improving both the product and company velocity.
```


hermes agents using openrouter free api end pont are free. it is dumb as hell for us to then not be thinking baout what crons could run off those models. we could be running them 24/7 and just have robost returing and retouring to the most stable free end points etc. what would be good for this and how should we think about this and map this out?


should we run the hud on the staging server and have it control our local machine? or just run locally?


Mr. White, I’ll map this as an operating system: what free-model crons are good for, what they must never touch, how to route/fallback safely, and how to turn idle free inference into company velocity without creating noise.


Mr. White: **run HUD locally first.**

Best architecture:

**Local HUD = command center**
- Runs on your machine.
- Can control Hermes, local crons, worktrees, GBrain, scripts.
- Safer, cheaper, faster.
- No public attack surface for machine-control tools.

**Staging HUD = read-only mirror**
- Shows status: PRs, deploys, Linear, runway, YC, agent queues.
- Approvals only as metadata, not direct machine control.
- Useful from phone/browser.
- No shell execution. No local-machine control.

**Do not let staging control your local machine directly.**  
That creates a dangerous remote-control surface: auth risk, command injection, leaked tokens, accidental deploys, and expensive agent loops.

Ideal setup:

```text
Local machine:
Hermes + crons + agents + GBrain + worktrees + local HUD writer

Repo / Linear / GitHub / Vercel:
durable source of truth

Staging /admin/ops:
read-only dashboard + approval queue
```

Control flow:

```text
Staging HUD creates approval/dispatch manifests
↓
Local Hermes polls manifests
↓
Local Hermes executes approved work locally
↓
Results sync back to Linear/GitHub/Ops/HUD
```

So: **local execution, cloud visibility.**


Yes. Treat free OpenRouter as **idle compute**, not “free magic.” Use it for low-risk, read-only, repetitive cognition that produces drafts, rankings, reports, and Linear issues.

OpenRouter has `openrouter/free`, `:free` model variants, fallback routing via `models`, provider fallback controls, and free-model rate limits. Free variants may have different availability/rate limits; current docs say `:free` usage is capped at 20 requests/minute, with daily limits depending on credit history. citeturn439618search4turn439618search6turn439618search10

## Core framing

Build a **Free Compute Swarm**:

1. **Free models think.**
2. **Deterministic scripts verify.**
3. **Premium models adjudicate only high-value ambiguity.**
4. **Humans approve money, deploys, outbound, legal, auth, billing.**

Free crons should create:
- reports
- ranked lists
- suggested issues
- test candidates
- skill deltas
- draft outreach
- doc patches
- QA hypotheses

They should not directly:
- send emails
- spend money
- merge/deploy
- edit auth/billing/migrations
- mutate production data
- launch campaigns

## Best cron categories

| Cron | Why it’s good for free models | Output |
|---|---|---|
| **Testing doctor** | Reads failures and suggests missing coverage | Linear issue + test plan |
| **Sentry triage** | Classifies errors and maps to likely owner | ranked bug queue |
| **PR reviewer pre-pass** | Cheap first-pass review before CodeRabbit/premium | comment draft / risk label |
| **Docs doctor** | Finds stale docs, duplicated rules, missing runbooks | patch proposal |
| **Skill improver** | Reviews agent failures and proposes skill updates | skill delta |
| **Linear hygiene** | Dedupes, clusters, reprioritizes issues | weekly grooming report |
| **GTM lead rater** | Scores scraped artists cheaply | ranked leads |
| **Outreach drafter** | Drafts claim/fan-demand messages | draft only |
| **YC/application updater** | Flags stale facts and metrics drift | application patch plan |
| **Cost watchdog** | Reviews usage/spend logs | burn report |
| **Design QA scout** | Reviews screenshots heuristically | visual bug candidates |
| **Changelog watcher** | Watches vendor docs/releases | update issue if relevant |

## Routing architecture

Use a **model broker**, not direct model calls everywhere.

Broker responsibilities:
- pull current free models from OpenRouter Models API
- maintain health scores per model
- use `models: [...]` fallback list
- try `openrouter/free` for generic low-value work
- use specific `:free` models for structured/reliable jobs
- record success rate, latency, refusal/error rate, JSON validity
- automatically quarantine unstable endpoints
- escalate to paid only when explicitly allowed

OpenRouter supports automatic fallback with the `models` parameter and provider routing/fallback controls. Use that, plus your own health ledger. citeturn439618search1turn439618search5

## The 3-tier job system

### Tier 0 — deterministic only
Runs constantly. No LLM.
- fetch CI status
- fetch Vercel deploy status
- parse Sentry exports
- scrape docs/RSS
- check OpenRouter key limits
- update ledgers

### Tier 1 — free model swarm
Runs 24/7 within rate caps.
- summarize
- classify
- rank
- propose
- draft
- compare
- generate candidate tests

### Tier 2 — premium/human gated
Only for high-value decisions.
- final YC answers
- architecture decisions
- auth/billing/security
- investor copy
- deploy approval
- paid campaign strategy

## Concrete cron map for Jovie

Create these first:

1. **`free-model-health-doctor`**
   - Every 15 min.
   - Tests available free endpoints with tiny prompts.
   - Updates model health JSON.
   - Quarantines bad models.

2. **`linear-triage-swarm`**
   - Every hour.
   - Reads new/stale issues.
   - Dedupes, clusters into your six loops.
   - Outputs “proposed changes,” not direct edits unless safe.

3. **`qa-gap-scout`**
   - Every 2 hours.
   - Reads recent bugs/PRs/Sentry/CI failures.
   - Suggests missing tests.
   - Creates candidate test specs.

4. **`sentry-root-cause-scout`**
   - Every 30 min.
   - Clusters errors by route/component.
   - Maps likely cause + issue owner.

5. **`gtm-lead-rater`**
   - Continuous batch.
   - Scores scraped artists.
   - Drafts personalized claim angles.
   - Never sends.

6. **`docs-skill-dedupe-doctor`**
   - Nightly.
   - Finds duplicated instructions across skills, AGENTS, CLAUDE, docs.
   - Suggests compaction.

7. **`yc-fact-drift-watch`**
   - Daily until submitted.
   - Checks YC/app docs against company_state, Linear, bank/runway ledger.
   - Flags stale claims.

8. **`agent-postmortem-miner`**
   - Nightly.
   - Reads failed PRs, reverted PRs, bot comments, human corrections.
   - Proposes LESSONS.md and skill updates.

9. **`deploy-readiness-scout`**
   - Every 30 min.
   - Reads PR/CI/Vercel state.
   - Outputs: “safe to review,” “blocked,” “needs Tim.”

10. **`cost-and-usage-watchdog`**
   - Hourly.
   - Checks OpenRouter key usage, free limit pressure, paid usage, Claude/Codex usage notes.
   - Routes work away from expensive models.

## Key design rule

Free crons should be **many, small, and boring**.

Bad:
> “One giant autonomous founder agent that thinks about everything.”

Good:
> “40 tiny crons that each inspect one surface, produce one JSON artifact, and hand off only useful deltas.”

## Data model

Every cron should emit this shape:

```json
{
  "job": "qa-gap-scout",
  "timestamp": "2026-05-07T00:00:00Z",
  "model_route": "openrouter/free",
  "confidence": 0.72,
  "cost_estimate": 0,
  "inputs": ["recent_prs", "linear", "ci"],
  "findings": [],
  "recommended_actions": [],
  "requires_human": false,
  "safe_to_auto_create_issue": true,
  "next_check": "2026-05-07T02:00:00Z"
}
```

## Prompt to give Hermes

```text
Build the Jovie Free Compute Swarm.

Goal: use OpenRouter free endpoints as 24/7 idle cognition for read-only analysis, triage, drafting, ranking, and issue proposal, while keeping all risky actions gated.

Architecture:
- Add a model broker that supports openrouter/free, explicit :free model lists, fallback routing, health scoring, JSON validity checks, latency/error tracking, and model quarantine.
- Never let leaf crons call OpenRouter directly. All calls go through the broker.
- Add a deterministic Tier 0 collector layer, free-model Tier 1 analysis layer, and premium/human Tier 2 escalation layer.
- Every cron emits a structured artifact with job, timestamp, model route, confidence, inputs, findings, recommended actions, human gate, and next check.
- Default to no code mutation, no outbound sends, no deploys, no production data mutation, no auth/billing/migration edits.

Create Linear issues for:
1. free-model-health-doctor
2. model-broker with fallback/quarantine
3. linear-triage-swarm
4. qa-gap-scout
5. sentry-root-cause-scout
6. gtm-lead-rater
7. docs-skill-dedupe-doctor
8. yc-fact-drift-watch
9. agent-postmortem-miner
10. deploy-readiness-scout
11. cost-and-usage-watchdog
12. HUD panel for Free Compute Swarm outputs

For every issue include:
- product output
- velocity output
- owner profile
- allowed model tier
- allowed actions
- forbidden actions
- artifact schema
- verification
- HUD surface
- kill switch

Optimize for maximum useful 24/7 work at zero marginal cost, minimum duplication, and no accidental blast radius.
```

Bottom line: yes, run the free swarm. Use it as **company radar**, **QA radar**, **GTM radar**, and **agent self-improvement radar**. Let it generate options constantly; let deterministic checks and Tim-gated approval decide what becomes action.


and we also spun up a task to make the app an electorn app so i can launch it locally easily? instead of needed in a dev server etc. i can run the staging veriosn locally in electorn and it can detect when its installed and run locally vs hosted


can we and should we fork this to manage our orchestration of agents and just build around this? https://github.com/ruvnet/ruflo


I’ll inspect Ruflo itself plus the current Jovie/Hermes constraints, then give you a build/fork decision and the fastest path.


Yes. That’s the right split:

**Electron Local HUD**
- Launches like a normal Mac app.
- Talks to local Hermes, GBrain, worktrees, crons, logs, scripts.
- Can execute local commands safely because it’s local-only.
- Detects local install and enables “control mode.”

**Hosted Staging HUD**
- Same UI shell.
- Read-only/status-first.
- Can create approval/dispatch manifests.
- Cannot execute shell commands.

Recommended architecture:

```text
shared HUD UI package
├─ web mode: /admin/ops on staging
└─ electron mode: local desktop app

local-only bridge
├─ Hermes control
├─ cron control
├─ worktree/agent status
├─ local logs
└─ GBrain/memory sync
```

Runtime detection:

```ts
const isElectron = Boolean(globalThis.electronAPI)
const isLocalHost = location.hostname === "localhost"
const controlMode = isElectron && isLocalHost
```

Hard rule:

```text
Hosted = observe + approve
Electron/local = observe + execute
```

Create the task as:

**“Build Electron Local HUD shell with hosted/local mode detection”**

Acceptance:
- Same HUD UI runs in web and Electron.
- Electron app opens local HUD without manually starting dev server.
- Local bridge exposes only allowlisted commands.
- Hosted staging never exposes command execution.
- UI clearly shows `Hosted read-only` vs `Local control mode`.
