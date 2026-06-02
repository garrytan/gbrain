
Mr. White, yes: **FounderOS should continuously produce coding task contracts for Coder**, but the source of truth should be **markdown files in the ops repo**, not invisible agent-to-agent chat.

The clean pattern is:

```text
FounderOS decides what matters
→ writes a task contract in ops repo
→ Tim approves the task
→ Coder picks up the approved task
→ Coder creates worktree
→ Coder uses Codex + GStack
→ /review
→ /ship
→ PR opened
→ task file updated with PR/result
```

## Core answer

Use this for now:

```text
FounderOS does not freeform “tell Coder what to do.”
FounderOS writes task markdown.
Coder executes approved task markdown.
```

Agent-to-agent direct communication can exist later, but it should **never be the only record**. You want a durable trail of what was requested, why, what got shipped, and what happened.

## Exact stabilization workflow

### 1. FounderOS runs triage

Every morning, FounderOS reads:

```text
- company_state.md
- Sentry issues
- GitHub issues / PRs
- analytics / onboarding funnel if available
- previous daily briefings
- current open task files
```

It outputs:

```text
ops/daily_briefings/2026-04-21.md
ops/tasks/coder/proposed/STAB-001-fix-onboarding-oauth.md
ops/tasks/coder/proposed/STAB-002-add-activation-event-logging.md
ops/tasks/coder/proposed/STAB-003-investigate-signup-dropoff.md
```

FounderOS should create **small stabilization tasks**, not giant “fix onboarding” tasks.

Good task:

```text
Fix OAuth callback blank screen for new users.
```

Bad task:

```text
Stabilize onboarding.
```

### 2. Tim approves the next tasks

You say to FounderOS:

```text
Approve STAB-001 and STAB-003. Dispatch STAB-001 to Coder first.
```

FounderOS moves files:

```text
ops/tasks/coder/proposed/STAB-001-fix-onboarding-oauth.md
```

to:

```text
ops/tasks/coder/approved/STAB-001-fix-onboarding-oauth.md
```

and commits:

```bash
git add ops/tasks/coder
git commit -m "chore(ops): approve STAB-001 onboarding oauth fix"
```

### 3. Coder picks up the approved task

For v1, trigger Coder manually:

```bash
coder chat -q "Execute the approved task at /Users/tim/JovieInc/ops/tasks/coder/approved/STAB-001-fix-onboarding-oauth.md. Follow the task contract exactly. Use the Jovie code repo at /Users/tim/JovieInc/jovi. Create a worktree, implement with Codex/GStack, run /review before /ship, and update the task file with status and PR link."
```

Hermes profiles become their own command aliases, and the docs show commands such as `coder chat`, `coder gateway start`, and explicit profile targeting with `hermes chat -p coder -q "hello"`. citeturn330214view1

### 4. Coder creates worktree and implements

Coder does:

```bash
cd /Users/tim/JovieInc/jovi
git worktree add ../jovi-STAB-001 fix/STAB-001-onboarding-oauth
cd ../jovi-STAB-001
```

Then uses Codex/GStack:

```text
- reproduce issue
- identify cause
- implement minimal fix
- add regression test if possible
- run relevant tests
- run /review
- fix review findings
- run /ship
- open PR
```

### 5. Coder updates the task file

Coder edits:

```text
ops/tasks/coder/in_progress/STAB-001-fix-onboarding-oauth.md
```

or moves it to:

```text
ops/tasks/coder/pr_opened/STAB-001-fix-onboarding-oauth.md
```

with:

```markdown
## Status
PR opened.

## PR
https://github.com/JovieInc/jovi/pull/123

## Summary
Fixed OAuth callback blank screen by handling missing onboarding session state and redirecting user back to step 3.

## Tests
- pnpm test onboarding
- pnpm typecheck
- manual OAuth smoke test

## Remaining risks
OAuth provider-specific edge cases still need monitoring.
```

Then it commits the ops task update:

```bash
git add ops/tasks/coder
git commit -m "chore(ops): update STAB-001 with PR"
```

## Task contract template

Use this file format:

```markdown
# STAB-001 — Fix onboarding OAuth callback blank screen

## Status
approved

## Owner
coder

## Priority
P0

## Bottleneck
Onboarding activation stability

## Source
- Sentry:
- Analytics:
- User report:
- FounderOS briefing:

## Problem
New users sometimes hit a blank screen after OAuth callback during onboarding.

## Expected behavior
After OAuth callback, the user should return to onboarding with the connected account marked complete and continue to the next step.

## Actual behavior
The user sees a blank screen and does not reach activation.

## Scope
Fix the specific OAuth callback/onboarding session failure path.

## Out of scope
- Redesigning onboarding
- Adding new onboarding features
- Changing pricing
- Rewriting auth

## Repo
/Users/tim/JovieInc/jovi

## Worktree
/Users/tim/JovieInc/jovi-STAB-001

## Branch
fix/STAB-001-onboarding-oauth

## Required workflow
1. Create worktree.
2. Reproduce or explain why reproduction is unavailable.
3. Implement minimal fix.
4. Add or update regression test if practical.
5. Run relevant tests.
6. Run GStack /review.
7. Address critical review findings.
8. Run GStack /ship.
9. Open PR.
10. Update this task file with PR link and result.

## Acceptance criteria
- New user OAuth callback does not blank-screen.
- User returns to onboarding in the correct state.
- Relevant tests pass.
- PR is opened with clear summary.

## Approval gates
- Do not merge.
- Do not deploy.
- Do not alter unrelated onboarding flows.
```

This is the contract between FounderOS and Coder.

## How to get Coder to pick it up

Use phases.

### Phase 1 — manual dispatch

This is what I recommend immediately.

```text
FounderOS writes task file.
Tim approves.
Tim or FounderOS runs one command to Coder.
Coder executes.
```

The physical action is just:

```bash
coder chat -q "Execute task file: /path/to/STAB-001.md"
```

This is the lowest-risk setup. It keeps you in control and avoids building automation before the workflow is proven.

### Phase 2 — semi-automatic dispatch

Once Phase 1 works for a few days, let FounderOS dispatch Coder by running the command itself:

```bash
coder chat -q "Execute the newest approved task in /Users/tim/JovieInc/ops/tasks/coder/approved. Take only one task. Move it to in_progress before starting. Follow the task contract exactly."
```

FounderOS can do that after you say:

```text
Approve and dispatch STAB-001.
```

### Phase 3 — watched folder

Later, add a tiny watcher:

```text
ops/tasks/coder/approved/
```

When a file appears, a script triggers:

```bash
coder chat -q "Execute task file: $TASK_FILE"
```

I would not start here. Folder-watch automation can double-trigger, race, or pick up half-written files unless you add locking.

### Phase 4 — webhook

Hermes supports webhooks: the gateway can receive POSTs from systems like GitHub, GitLab, Jira, and Stripe, validate HMAC signatures, transform payloads into prompts, and trigger Hermes runs. citeturn330214view0 Hermes also supports dynamic webhook subscriptions through `hermes webhook subscribe`, and incoming POSTs can trigger an agent run and deliver the result to a configured destination. citeturn330214view4

Use this later for:

```text
GitHub issue labeled agent-ready
→ webhook triggers coder
→ coder executes task
```

For now, webhooks are extra setup. Use manual or semi-automatic dispatch.

## Should FounderOS and Coder talk directly?

Use this rule:

```text
They can talk directly for convenience.
The task file is the source of truth.
```

Good:

```text
FounderOS creates STAB-001.md.
FounderOS tells Coder: execute STAB-001.md.
Coder updates STAB-001.md with progress and PR.
```

Bad:

```text
FounderOS tells Coder in chat.
Coder does something.
No file records what happened.
```

The markdown file gives you:

```text
- audit trail
- replayability
- less hallucinated scope
- easy handoff between agents
- easy review by you
- future automation compatibility
```

## Physical interface

For now, run **two persistent Hermes profiles**, but you do not need two giant interactive sessions open all the time.

Recommended setup:

```text
tmux session: jovie
│
├── window 1: founder-os
│   └── interactive chat with you
│
├── window 2: coder
│   └── idle / available for active coding task
│
├── window 3: code
│   └── current worktree, tests, Codex/GStack
│
└── window 4: logs
    └── gateway, cron, git status, agent logs
```

Command:

```bash
tmux new -s jovie
```

Windows:

```bash
tmux rename-window founder
tmux new-window -n coder
tmux new-window -n code
tmux new-window -n logs
```

### FounderOS terminal

Keep this one open because it is your command center:

```bash
cd /Users/tim/JovieInc/ops
founder-os chat
```

### Coder terminal

You can leave it idle or only open it when needed:

```bash
cd /Users/tim/JovieInc/jovi
coder chat
```

### Background gateway option

Hermes gateways can run as separate processes per profile, and each profile can be installed as its own service. citeturn330214view1 The messaging gateway is a single background process that connects configured platforms, handles sessions, and runs cron jobs. citeturn330214view2

So the cleaner v1.5 setup is:

```bash
founder-os gateway install
founder-os gateway start

coder gateway install
coder gateway start
```

Then you use chat/CLI when needed, while cron/webhooks can run in the background.

## Should FounderOS spin up Coder each time?

No. Keep Coder as a persistent profile.

```text
FounderOS = persistent command center
Coder = persistent engineering manager
Codex/GStack workers = disposable per task/worktree
```

FounderOS should not create a fresh Coder profile for every task. That loses continuity and creates clutter.

The right pattern:

```text
Persistent:
- founder-os
- coder

Disposable:
- worktrees
- branches
- Codex sessions
- task-specific subagents
```

## Stabilization task states

Use this folder structure:

```text
ops/tasks/coder/
├── proposed/
├── approved/
├── in_progress/
├── blocked/
├── pr_opened/
├── done/
└── cancelled/
```

Task lifecycle:

```text
proposed
→ approved
→ in_progress
→ pr_opened
→ done
```

FounderOS owns:

```text
proposed
approved
blocked
done summaries
```

Coder owns:

```text
in_progress
pr_opened
implementation notes
PR links
test results
```

Tim owns:

```text
approval
priority
merge/deploy decision
```

## Exact daily stabilization loop

### Morning

FounderOS:

```text
1. Read company state.
2. Read Sentry/GitHub/analytics.
3. Identify current bottleneck.
4. Write daily briefing.
5. Create 1–3 proposed coding tasks.
6. Recommend exactly one task to dispatch first.
```

### You

You say:

```text
Approve and dispatch STAB-001.
```

### FounderOS

FounderOS:

```text
1. Moves STAB-001 to approved.
2. Commits the approval.
3. Runs coder dispatch command, or gives you the command to run.
```

### Coder

Coder:

```text
1. Moves task to in_progress.
2. Creates worktree.
3. Uses Codex/GStack.
4. Runs /review.
5. Runs /ship.
6. Opens PR.
7. Updates task file with PR link.
```

### You

You review PR:

```text
- merge if good
- ask Coder to revise if not
- deploy only if appropriate
```

### FounderOS

FounderOS next briefing:

```text
- sees STAB-001 PR opened/merged
- checks whether onboarding bottleneck improved
- recommends next task
```

## My recommendation for your current stage

Start with this exact operating mode:

```text
1. FounderOS writes task files.
2. Tim approves one task at a time.
3. FounderOS dispatches Coder by CLI command.
4. Coder runs GStack/Codex in a worktree.
5. Coder opens PR.
6. FounderOS tracks status from markdown + GitHub.
```

Do **not** start with folder watchers or webhooks. Add them after the manual dispatch loop works reliably.

The first automation worth adding is:

```text
Approve and dispatch STAB-001
```

where FounderOS handles the file move, commit, and `coder chat -q ...` command.


The other thing is, should we have a general principle for cron stacking or does it not cost us anything? If we're running crons every 5 min or something, are we taking additional tokens if there's nothing to run on that? If we are, would it be beneficial to have a cron stacking policy where we basically sync ones that are not necessarily dependent on each other so that there's one long-running cron that just happens every time and then checks a number of things? Or is there a better way to do it or have it webhook off of something?

Also we have 3 min on CI so we can always put things on CI for now 

And then the other thing I guess is that we run Linear anyway. Should we just use Linear for the general issue tracking or is it just easier to do it off of MarkDoc files in the repo? I don't really give a shit since there's no external party but if it saves us some automation and lets us type in webhooks or something in a meaningful way, we could. If it's simpler to just keep it the way it is, it's fine 


Mr. White, I’d reduce this to one operating policy: use sparse batched polling, reserve event-driven triggers for urgent work, and decide whether Linear meaningfully simplifies the automation compared with repo task files.


Mr. White, use this principle:

```text
Cron is for scheduled summaries.
Webhooks are for events.
CI is for deterministic checks.
Linear is for live task state.
Markdown is for durable task context.
```

## Cron stacking policy

Yes, crons can cost tokens. The scheduler itself ticking does not matter, but **every due cron that starts an agent run can spend tokens**, even if the result is “nothing changed.” Hermes cron runs due jobs in fresh agent sessions, injects skills if configured, runs the prompt to completion, and then delivers the result. The gateway checks due jobs every 60 seconds. citeturn231820view2

So avoid this:

```text
Every 5 min: check Sentry with LLM
Every 5 min: check GitHub with LLM
Every 5 min: check Linear with LLM
Every 5 min: check Gmail with LLM
Every 5 min: check CI with LLM
```

Use this:

```text
Every 5 min: cheap script-only sentinel, no LLM unless threshold changed
Every 30–60 min: one batched FounderOS ops sweep
Every morning: full Founder Briefing
Event-driven: Linear/GitHub/Sentry webhooks for urgent changes
```

Hermes docs also recommend `[SILENT]` for monitoring jobs to reduce notification noise, but that still implies the agent ran; it helps UX, not necessarily token spend. citeturn231820view4

## Recommended v1 cron schedule

### 1. Daily full briefing

Run once daily.

```text
8:00am — FounderOS full company briefing
```

This can use real LLM reasoning because it is the high-value synthesis.

### 2. Periodic ops sweep

Run every 30 or 60 minutes, not every 5.

```text
Every 60 min — FounderOS ops sweep
```

It checks:

```text
- open agent-ready Linear issues
- new failed CI status
- new P0/P1 Sentry signals
- stale PRs
- blocked stabilization tasks
- YC/fundraise deadline drift
```

Output only when something needs action.

### 3. Five-minute sentinel

Use a **non-LLM script** every 5 minutes.

This should query machine-readable state and exit unless something crosses a threshold:

```text
- CI failed on main
- production deploy failed
- new P0 Sentry issue
- Linear issue moved to agent-ready
- PR review requested
- onboarding error count spiked
```

Then the script calls Hermes/Coder only if needed.

Pseudo-flow:

```bash
*/5 * * * * /Users/tim/JovieInc/ops/scripts/sentinel.sh
```

The sentinel script should do:

```text
1. Query APIs cheaply.
2. Compare against last seen state.
3. If no change, exit 0.
4. If meaningful change, call founder-os or coder.
```

That gives you five-minute responsiveness without five-minute LLM spend.

## Webhooks are better than frequent polling

For events, use webhooks once setup is easy. Hermes webhooks can receive POSTs from services like GitHub, GitLab, Jira, and Stripe, validate HMAC signatures, transform payloads into prompts, and trigger agent runs automatically. citeturn231820view3 Linear also has webhooks for created/updated data, including issues and comments, and its API is GraphQL with mutation support and scoped API keys. citeturn231820view1

Best event triggers:

```text
Linear issue moved to “Ready for Agent”
→ trigger Coder

GitHub PR opened/updated
→ trigger review/summarization

CI failed on main
→ trigger FounderOS P0 alert

Sentry P0 issue created
→ trigger FounderOS triage
```

Do not start with all of these. Start with **Linear → Coder** or **GitHub PR → FounderOS summary**.

## How to use CI

Since your CI is ~3 minutes, use it aggressively for deterministic checks.

Put this in CI:

```text
- typecheck
- lint
- unit tests
- onboarding smoke test if fast
- build
- maybe Playwright smoke path if it fits
```

Do not use CI as the main LLM runner yet. Use CI to produce facts. FounderOS/Coder can read those facts.

Good pattern:

```text
CI runs fast checks
→ status is visible on PR
→ Linear/GitHub status updates
→ FounderOS summarizes only failed/changed state
```

Bad pattern:

```text
Every CI run invokes an LLM to think about the repo.
```

Use the LLM after CI failure or before PR shipping, not on every push by default.

## Linear vs markdown

Use **Linear for the active issue queue**. Use **markdown for the task contract and audit trail**.

Since you already run Linear, use it. Linear’s GitHub integration can link PRs to issues via branch names, PR titles, or magic words, and it can automate issue status based on PR and commit activity. citeturn620163view0 That saves automation work you would otherwise rebuild with markdown folders.

Recommended split:

```text
Linear = live task tracker
Markdown = durable task spec
GitHub PR = code change
Ops repo = company memory / task archive
```

## Exact Linear workflow

### Statuses

Create or use these Linear statuses:

```text
Triage
Ready for Tim
Ready for Agent
Agent Running
PR Open
Blocked
Done
Cancelled
```

### Labels

Use labels:

```text
stabilization
onboarding
sentry
p0
p1
agent-ready
needs-founder-approval
```

### FounderOS creates issues

FounderOS should create Linear issues for stabilization work.

Example Linear issue:

```text
Title:
[STAB] Fix onboarding OAuth callback blank screen

Status:
Ready for Tim

Labels:
stabilization, onboarding, p0

Description:
Problem, expected behavior, actual behavior, scope, out-of-scope, acceptance criteria, required GStack workflow.

Task contract:
ops/tasks/coder/linear/JOV-123-fix-onboarding-oauth.md
```

### Tim approves

You move it to:

```text
Ready for Agent
```

or tell FounderOS:

```text
Approve JOV-123 for Coder.
```

### Coder picks it up

Two options.

For v1, manual:

```bash
coder chat -q "Execute Linear issue JOV-123. Read the task contract at /Users/tim/JovieInc/ops/tasks/coder/linear/JOV-123-fix-onboarding-oauth.md. Use GStack /review and /ship. Do not merge or deploy."
```

For v1.5, webhook:

```text
Linear issue status changed to Ready for Agent
→ Hermes webhook
→ Coder runs task
```

Linear webhooks fire on data created/updated, and Hermes webhooks can turn incoming events into agent prompts. citeturn231820view1turn231820view3

### Coder branches using Linear ID

Branch:

```bash
fix/JOV-123-onboarding-oauth
```

PR title or description:

```text
Fixes JOV-123
```

Linear recognizes issue IDs in branch names, PR titles, and magic words like `Fixes ENG-123`; closing magic words can move the issue through workflow states when branches/PRs/merges happen. citeturn620163view0

### Coder updates both places

Coder updates:

```text
Linear issue comment:
- worktree
- branch
- PR link
- tests run
- risks

Markdown task file:
- final implementation notes
- PR link
- result
```

## Should markdown still exist?

Yes, but markdown becomes **the contract**, not the queue.

Use this path:

```text
ops/tasks/coder/linear/JOV-123-fix-onboarding-oauth.md
```

The markdown file should be created once, committed, and linked in the Linear issue. It gives agents a stable, repo-visible spec.

Linear can change status. Markdown should preserve context.

## Recommended automation layering

### Now

```text
Manual approval + manual dispatch
Linear issue + markdown contract
Coder runs GStack
```

### Next

```text
Linear Ready for Agent → webhook → Coder dispatch
```

### Later

```text
GitHub PR updates → Linear status automation
CI failure → FounderOS alert
Sentry P0 → FounderOS alert
```

## Practical policy

Use this as the rule:

```text
No LLM cron more frequent than every 30 minutes unless it is reacting to a real event.

Every 5-minute job must be script-only or webhook-driven.

Batch low-urgency checks into one FounderOS sweep.

Use Linear for task state.

Use markdown for task contracts.

Use CI for facts.

Use GStack for code shipping.
```

## Minimal setup I’d run today

```text
1. Linear is the queue.
2. FounderOS creates Linear issues + task markdown.
3. Tim approves by moving issue to Ready for Agent.
4. Coder is manually dispatched from that issue.
5. Coder creates branch with Linear ID.
6. Coder runs /review and /ship.
7. PR uses “Fixes JOV-123.”
8. Linear/GitHub integration tracks status.
9. FounderOS daily briefing reads Linear + GitHub + markdown.
```

This keeps the system simple while giving you the automation hooks you’ll want later.


Because these are sharing repo context and honcho memory, can we run the fundraising agent on the PC and have it just pick up tasks for now? Is that a good or bad way to do it? 
The ready for agent status: would it not be better to leave the stock statuses and use the assignee for that? That would eat seats I guess. I would just try and normalize. Agent running should just use the normal in progress and if it gets moved to to do, then that just means that to do there doesn't need to be a separate ready for Tim, ready for agent because we're operating in the same space 


I’d keep this simple: use your existing Linear workflow and normal statuses, then decide separately whether fundraise should live on the PC or just pick up tasks there for now.


Mr. White, yes: **run the fundraising agent on the PC for now** if the PC already has repo access, Hancho memory, Airtable/Gmail access, and can run the agent reliably. That is a good split because fundraising work is mostly I/O, research, CRM cleanup, drafting, and follow-up tracking. It does not need the coding laptop’s worktrees or GStack loop.

The rule should be:

```text
MBP = FounderOS + Coder + code execution
PC = Fundraise agent + batch enrichment + Airtable/Gmail/Linear pickup
Linear = active queue
Ops repo markdown = durable task contract / archive
Hancho = shared memory, not the queue
```

## Fundraising agent on PC: good or bad?

**Good**, with one caveat: do not rely on Hancho memory as the task queue.

Use Hancho for shared context:

```text
- who Tim is
- Jovie positioning
- prior investor summaries
- learned preferences
- company state
```

Use Linear or markdown for task state:

```text
- what is assigned
- what is approved
- what is in progress
- what is done
- what needs Tim approval
```

Memory is useful for continuity. It is a bad primary source of truth because it is harder to audit, diff, approve, and trigger from.

## How fundraise should pick up tasks

Use Linear as the live queue.

Example issue:

```text
Title:
Build warm angel list from Gmail history

Status:
Todo

Labels:
agent:fundraise
fundraise
warm-intros
needs-draft-only

Priority:
High

Description:
Find investors and angel operators Tim has already communicated with. Add candidates to Airtable. Draft follow-up emails. Do not send.
```

The PC fundraise agent can poll Linear every 30–60 minutes or be triggered manually:

```bash
fundraise chat -q "Pick up the highest-priority Linear issue labeled agent:fundraise in Todo. Move it to In Progress, execute it, update Airtable, draft but do not send emails, and comment results back on the Linear issue."
```

Later, use a webhook:

```text
Linear issue updated
→ label includes agent:fundraise
→ status is Todo
→ trigger PC fundraise agent
```

Linear’s API is GraphQL, supports mutations, and webhooks fire when data is created or updated, including issues and comments. Linear also says webhook payloads include the changed object and previous values, which is exactly what you want for “issue moved to Todo” triggers. citeturn438458view2

## On Linear statuses: your instinct is right

Yes. **Use the stock statuses. Do not create “Ready for Tim,” “Ready for Agent,” and “Agent Running” unless you feel real pain.**

Linear’s default workflow is:

```text
Backlog → Todo → In Progress → Done → Canceled
```

Linear’s docs say workflows are team-specific and come with that default status order. citeturn438458view1

Use that. Normalize around it.

## Recommended Linear convention

```text
Backlog
Captured, not yet committed.

Todo
Approved work. Ready for a human or agent.

In Progress
Someone or some agent is actively working.

Done
Completed and verified enough.

Canceled
Won’t do / duplicate / no longer relevant.
```

Then use **labels** to determine who or what should pick it up:

```text
agent:coder
agent:fundraise
agent:founderos
agent:content

area:onboarding
area:fundraise
area:stability
area:yc
area:gtm

type:bug
type:task
type:research
type:draft
type:ops

source:sentry
source:gmail
source:founderos
source:user
```

So instead of:

```text
Status: Ready for Agent
```

use:

```text
Status: Todo
Label: agent:coder
```

Instead of:

```text
Status: Agent Running
```

use:

```text
Status: In Progress
Label: agent:coder
```

Instead of:

```text
Status: Ready for Tim
```

use:

```text
Status: Todo
Label: needs-tim
```

This keeps the workflow normal.

## Assignee policy

Do **not** create fake Linear users for each agent right now.

Linear’s current pricing page lists Free as unlimited members with 2 teams and 250 issues, Basic as $10/user/month billed yearly, and Business as $16/user/month billed yearly. Business adds private teams, guests, and Linear Agent automations beta. citeturn438458view0

Even if the free tier allows unlimited members, agent users create operational clutter. Separate users also become billing/permissions/admin overhead once you move plans.

Use assignee for the **human accountable owner**:

```text
Assignee: Tim
Labels: agent:coder / agent:fundraise
Status: Todo / In Progress
```

The agent can comment as the API token owner or via whatever integration identity you set up later.

Practical rule:

```text
Assignee = human accountable owner.
Label = execution lane.
Status = lifecycle state.
```

## How each agent decides what to pick up

### Coder on MBP

Query:

```text
status = Todo
label = agent:coder
priority = highest first
```

Then:

```text
move to In Progress
create branch/worktree
use GStack /review and /ship
comment PR link
leave merge/deploy to Tim
```

### Fundraise on PC

Query:

```text
status = Todo
label = agent:fundraise
priority = highest first
```

Then:

```text
move to In Progress
update Airtable
draft Gmail responses / investor emails
comment summary in Linear
move to Done if fully complete
move back to Todo with needs-tim label if approval is needed
```

### FounderOS on MBP

Query:

```text
everything high-priority
stale In Progress
new Sentry/user/fundraise signals
blocked issues
```

Then:

```text
create/clarify issues
add labels
write/refresh markdown contracts for important tasks
produce briefing
```

## Do we still need markdown task files?

Yes, but only for nontrivial tasks.

Use this split:

```text
Linear issue = active work item
Markdown file = detailed contract/context for agent execution
Linear comments = status updates
GitHub PR = code artifact
Airtable = fundraise CRM artifact
```

For a trivial fundraise task, Linear alone is enough.

For a real coding task, create markdown:

```text
ops/tasks/linear/JOV-123-fix-onboarding-oauth.md
```

For a real fundraising task, create markdown only when useful:

```text
ops/tasks/linear/JOV-211-build-warm-angel-list.md
```

Markdown is useful when the task needs:

```text
- exact acceptance criteria
- source links
- approval gates
- do-not-contact rules
- investor positioning
- code scope boundaries
- audit trail
```

## Fundraising agent workflow on PC

Run a separate profile on the PC:

```bash
fundraise chat
```

Give it this rule:

```text
You may pick up Linear issues with label agent:fundraise and status Todo.
Before starting, move the issue to In Progress.
You may update Airtable.
You may draft emails.
You may not send emails.
You may not launch campaigns.
You must comment a summary on the Linear issue.
If Tim approval is needed, add label needs-tim and move the issue to Todo.
```

Good statuses:

```text
Todo + agent:fundraise
→ In Progress + agent:fundraise
→ Done
```

For approval:

```text
In Progress + agent:fundraise
→ Todo + needs-tim
```

No custom status needed.

## Triggering fundraise from PC

Start manual/semi-manual:

```bash
fundraise chat -q "Pick up the highest-priority Todo Linear issue labeled agent:fundraise. Work one issue only. Draft but do not send external emails."
```

Then add a low-frequency cron:

```text
Every 60 minutes:
Check for Todo issues labeled agent:fundraise.
If none, exit.
If one exists, work the highest-priority one.
```

Do not run the fundraise agent every 5 minutes with an LLM. Fundraise tasks are rarely urgent to the minute.

Later:

```text
Linear webhook issue updated
→ if status Todo and label agent:fundraise
→ PC fundraise agent starts
```

## Final normalized operating model

Use this:

```text
Statuses:
Backlog
Todo
In Progress
Done
Canceled

Assignee:
Tim or actual human owner

Labels:
agent:coder
agent:fundraise
agent:founderos
needs-tim
stabilization
fundraise
onboarding
yc
p0
p1
```

And this routing:

```text
Todo + agent:coder
→ MBP coder picks it up

Todo + agent:fundraise
→ PC fundraise picks it up

Todo + needs-tim
→ Tim decision required

In Progress
→ actively being worked by either human or agent

Done
→ complete
```

## My recommendation

Run fundraise on the PC now, but keep the control system simple:

```text
1. Linear is the active queue.
2. Stock statuses only.
3. Labels route work to agents.
4. Assignee stays human.
5. Markdown exists only for meaningful task contracts.
6. Hancho memory shares context, but does not replace Linear.
7. Fundraise agent drafts and updates Airtable, but never sends or launches campaigns without approval.
```

That gives you parallelism without creating a fake org chart inside Linear.


## See Also
- [[chatgpt/chatgpt_aramis-agent-profile-management-part1]]
- [[chatgpt/chatgpt_aramis-agent-profile-management-part2]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part3]]
- [[chatgpt/chatgpt_automate-visual-profile-follow-part3]]
- [[chatgpt/chatgpt_hermes-agent-performance-comparison-part3]]
