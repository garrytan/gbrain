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

---

## User

analyze everything about jovie. memory, repos, recent prs, everythnng.

then lock out a plan for me to hand to my cheif of staff agent to work through and open stacks of issues for what we need to do. propose everything first. we would want a plan for moving to high velocity shipping with our hud deployment system and getting our yc application in with our demo video and then getting ourselveds default alive absed on our 400 dollars in the bank.  work extensively and layout the whole plan.

---

## User

i generally agree lets start opening up issues and reoganize linear around this so i can exectue fast. and give me one prompt to hand off to cheif of stafff herrmes agent 

try to structure this as infra as we build

for example if auth is down becaus e a test didnt cover it lets build on a refular cron to fix testing.

if we need users build on a cron and skill to get users and a skill to improve on that skill. etc. and restructure in a comeplling way to minimize duplication and cost. but ecerything we build should serrve both improving the prouct and improving the company velocity.

---

## Assistant

Mr. White, I’ll turn this into a Linear operating system: projects, issue stacks, recurring infra loops, and a Hermes handoff prompt. I’ll inspect available Linear/GitHub context first, then create the minimum useful structure around product velocity, reliability, growth, YC, and default-alive survival.

---

## Assistant

I’ve confirmed Linear is currently read-only here, so I’ll produce an exact Hermes issue-opening manifest. Existing work already clusters around YC, HUD/deployment, QA/reliability, growth, and agent-velocity guardrails.

---

## Assistant

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

---

## User

hermes agents using openrouter free api end pont are free. it is dumb as hell for us to then not be thinking baout what crons could run off those models. we could be running them 24/7 and just have robost returing and retouring to the most stable free end points etc. what would be good for this and how should we think about this and map this out?

---

## User

should we run the hud on the staging server and have it control our local machine? or just run locally?

---

## Assistant

Mr. White, I’ll map this as an operating system: what free-model crons are good for, what they must never touch, how to route/fallback safely, and how to turn idle free inference into company velocity without creating noise.

---

## Assistant

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

---

## Assistant

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

---

## User

and we also spun up a task to make the app an electorn app so i can launch it locally easily? instead of needed in a dev server etc. i can run the staging veriosn locally in electorn and it can detect when its installed and run locally vs hosted

---

## User

can we and should we fork this to manage our orchestration of agents and just build around this? https://github.com/ruvnet/ruflo

---

## Assistant

I’ll inspect Ruflo itself plus the current Jovie/Hermes constraints, then give you a build/fork decision and the fastest path.

---

## Assistant

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

---

## Assistant

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

---

## User

trigger.dev is open source right? should we just use that locally to deploy workers on our jobs?  and then it would be the same infra when we ship stuff to the cloud later?

---

## Assistant

I’ll verify Trigger.dev’s current self-hosting/open-source status and then map the practical local-to-cloud architecture for Jovie jobs.

---

## Assistant

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

---

## User

Now go out and check this against using AI SDK and workflows and stuff like that, and ground it in our current code and our trajectory. Ground it in our ethos of not building twice, and then the possibility that agent orchestration is just the only thing we need to build, right? It's just an interface region orchestration, so effectively the end product and the internal product have so much crossover that UI stuff should not be rebuilt, tuning should not be rebuilt, and all these different things should not be rebuilt.

Eventually you effectively automate when you're out of the integration. Thinking about that trajectory can be to make the plan from now to the 10X version and map it accordingly. Also research again what other teams are building with and what other stacks are out there and stuff. Hardening it to make sure this is the optimal way to do it, and also pulling from trending repositories and from some of the top eight companies making topic and stuff to see what they're contributing to. Just get a big piece of all the kinds of different things and look at recent YC companies and stuff like that and recent job postings and stuff to see what kind of tech they're talking about and A16Z job loads and stuff. You can get a big picture of what's out there and tax it and ground it against what makes the most sense for us. 

---

## User

I'm doing this for Microsoft workflows. We should also ground this in UI and stuff. Anything that's been designed for UI, we should be able to use this UI as much as possible. Whatever UI is published should be built to be private.
We should also be thinking about, for internal ops, to do virtual SDK or open ladder or something, to use free models, like NVIDIA free models and stuff like that, for the workflows and making sure that the workflow can use a free model. If it is a free model entirely, if that is the case, should anything be run on CI rather than locally? If it's currently on CI, we can take it off CI and run through this, and then generally build this out as a hardened plan rooted in the actual context of where we go.
Give me the phase build out so we are shipping in a comparatively small way and we can give it to one agent. It's like a swarm to just build and keep shipping and have every PR completely on by agent from once the plan starts being implemented through:
- QA exhaustive design review if it touches design
- a regular G-Stack reviewer ship
- land
Everything should go automatically through the G-Stack sales and stuff, and we should just ruflo for the orchestration. and mind what in flight

also just do 2 seocnd of research to see what open ai and anthropic and google have that competews with workflows and vercel and trigger etc and see if anything is worth it. if not thats fine.

---

## Assistant

I’ll ground this in Jovie’s repo, dependencies, workflows, open PRs, and Linear work, then map a small shippable phase plan around Ruflo, Trigger, AI SDK, and reusable UI.

---

## Assistant

Jovie already has provider-neutral AI SDK tooling, HUD AI ops, Hermes runtime support for Ruflo, and automation audits pointing to scope-judge/free-model swaps, so I’ll consolidate existing motion.

---

## Assistant

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
