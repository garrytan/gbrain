---
title: "AI Task Automation Plan"
type: essay
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
conversation_id: 69eb0fd2-c854-83e8-8a59-11b34232a354
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# AI Task Automation Plan

> Conversation ID: 69eb0fd2-c854-83e8-8a59-11b34232a354
> Created: 2026-04-24T06:38:11Z
> Updated: 2026-04-24T07:38:13Z
> Messages: 8

---

## User

i need to PLOW through ai usage overnight in order ot maximie before limits expire tomorr afternoon.

im gonna spin up a claude session on my pc with bypass permission on. iw ant to use task list and gent teams and paralell agents to /ideate the most critical thing and then ru them overnight.

so we;; do this in two phases. first you givre me a prompt to give clause to use paralel agent swarm like 10 agents to deep dive reado only on the codebase and find ux issues, code wuality issues, performance issues, ui bug/glitches, hardcode tokens that should be conformed, perfomance issues. legacy implementaion that are depreciated security gaps etc.

and rank them by critical to low.

then we;;ll rank those and pick what is the quickest wins for full automateion.

we'll open linear issues for everything that isnt and local tak list for everything that is. then we;ll assing paralell agents in worktrees with bypass permissions to run on the pc. 

so give me the first prompt. 

---

## Assistant

Mr. White, here’s a Phase 1 copy-paste prompt for a read-only overnight audit using 10 focused agents to find, dedupe, and rank issues without modifying the repo.

---

## Assistant

Mr. White, give Claude this prompt:

```text
You are running Phase 1 of a repo-wide AI agent audit.

Goal: use a parallel read-only agent swarm to deeply inspect this codebase and produce a ranked issue inventory. Do not modify files. Do not create branches. Do not commit. Do not install packages. Do not run migrations. Do not call external services. Do not expose secrets. If you find secrets, redact values and report only file path, key name, and risk.

Use 10 parallel specialist agents. Each agent should independently inspect the repo, then return concise findings with evidence. After all agents finish, synthesize one master report.

Mandatory read-only guardrails:
- No file writes.
- No package installs.
- No destructive commands.
- No database writes.
- No external network calls.
- No secret values printed.
- Prefer static inspection: git status, rg, find, cat, sed, package manifests, config files, source files, tests, docs.
- At the end, run `git status --short` and confirm nothing changed.

Create these 10 agents:

Agent 1 — UX / product flow audit
Find confusing flows, broken affordances, missing loading/error/empty states, unclear navigation, bad onboarding, bad forms, bad auth/session UX, places where user intent is likely blocked.

Agent 2 — UI visual bug / glitch audit
Find layout bugs, responsive issues, z-index/modals/dropdowns, overflow, clipping, skeleton/loading glitches, inconsistent spacing, broken dark/light mode, inconsistent component usage, accessibility-visible UI problems.

Agent 3 — Frontend code quality audit
Find messy components, duplicated logic, bad state management, prop drilling, brittle hooks, stale patterns, untyped/loosely typed areas, confusing abstractions, dead code, excessive coupling.

Agent 4 — Backend/API code quality audit
Find fragile endpoints, missing validation, weak error handling, duplicated business logic, inconsistent response shapes, bad data access patterns, hidden assumptions, legacy API patterns.

Agent 5 — Performance audit
Find slow renders, unnecessary client work, excessive queries, missing memoization/caching, large bundles, N+1 patterns, expensive effects, bad image/media handling, slow startup or route loading risks.

Agent 6 — Security/secrets audit
Find hardcoded tokens, API keys, auth bypasses, weak permissions, missing authorization checks, unsafe redirects, injection risks, exposed env assumptions, overly broad CORS, insecure cookies, unsafe logging. Redact all secret values.

Agent 7 — Config/env/deployment audit
Find hardcoded environment assumptions, duplicated config, deprecated flags, inconsistent env var naming, missing env validation, deployment footguns, local/prod mismatch, broken build assumptions.

Agent 8 — Dependency/deprecation audit
Find deprecated libraries/APIs, outdated framework patterns, risky dependencies, unused packages, version conflicts, soon-to-break APIs, legacy implementations that should be replaced.

Agent 9 — Testing/QA audit
Find missing critical tests, brittle tests, untested flows, flaky patterns, no coverage for auth/billing/payments/data writes, missing regression tests for important bugs, poor test organization.

Agent 10 — Architecture/data-model audit
Find architectural bottlenecks, bad module boundaries, schema/model issues, inconsistent naming, unclear ownership, hidden circular dependencies, overgrown files, places where future changes will be risky.

For each agent:
1. Inspect relevant files only.
2. Collect concrete findings with file paths and short evidence.
3. Assign each finding:
   - Severity: Critical / High / Medium / Low
   - Impact: User-facing / Revenue / Security / Reliability / Performance / Maintainability
   - Effort: XS / S / M / L
   - Automation suitability: Fully automatable / Partially automatable / Needs human judgment
   - Confidence: High / Medium / Low
4. Avoid vague advice. Every finding must include specific evidence.

Master synthesis requirements:
Produce a final report with these sections:

A. Executive summary
- Total findings by severity.
- Top 10 most important issues.
- Top 10 quickest wins.
- Top 10 fully automatable tasks.
- Top 10 issues that should become Linear tickets instead of overnight automation.

B. Ranked issue table
Columns:
Rank | Severity | Title | Impact | Effort | Automation suitability | Confidence | Area | Files | Why it matters | Suggested fix

C. Critical and High issues
For each:
- Title
- Severity
- Evidence with file paths
- Why it matters
- Suggested fix
- Risk of automated fix
- Recommended owner: agent automation / human / Linear ticket

D. Quick wins
Rank fixes by highest impact and lowest effort.
Include only tasks likely safe for autonomous agents.

E. Fully automatable overnight task list
Give a clean task list suitable for parallel agents in git worktrees.
For each task:
- Task name
- Exact scope
- Files likely involved
- Acceptance criteria
- Validation command
- Estimated effort XS/S/M/L
- Collision risk with other agents: Low/Medium/High

F. Linear-ticket backlog
List issues that should be tracked but not automatically fixed overnight.
For each:
- Issue title
- Priority
- Description
- Evidence
- Suggested Linear label
- Why it should not be automated immediately

G. Risk map
Identify tasks that may conflict if multiple agents work in parallel.
Group tasks into safe parallel batches.

H. Final read-only confirmation
Run `git status --short`.
Confirm whether any files changed. If anything changed, explain exactly what changed.

Ranking formula:
Prioritize in this order:
1. Security vulnerabilities and exposed secrets.
2. Broken user flows or production-impacting bugs.
3. Performance issues that affect core flows.
4. High-confidence quick wins.
5. Deprecated/legacy implementations likely to break soon.
6. Code quality issues blocking future velocity.
7. Cosmetic polish.

Output format:
Use concise markdown.
Use tables where helpful.
Be specific and actionable.
Do not include generic best practices unless tied to a concrete file/path.
Do not print secret values.
Do not modify the repository.
```

Use this as the Phase 1 discovery run. It should give you the ranked inventory needed for the next pass: Linear tickets for non-automation work, and local task lists for safe overnight worktree agents.

---

## User

continue

---

## Assistant

Mr. White, the next prompt turns the Phase 1 audit into a triaged execution plan, separating Linear-worthy work from safe overnight worktree batches before edits begin.

---

## Assistant

Mr. White, give Claude this **Phase 2 triage + automation planning prompt** after Phase 1 finishes.

```text
You are running Phase 2: triage the Phase 1 audit into actionable overnight work.

Input: I will paste the Phase 1 audit report below this prompt.

Goal:
1. Rank all findings by value, urgency, confidence, and automation safety.
2. Separate issues into:
   - A) Fully automatable overnight tasks
   - B) Partially automatable tasks needing narrow human review
   - C) Linear tickets for risky, ambiguous, architectural, product, security, or large-scope work
3. Create a safe parallel execution plan for multiple agents working in isolated git worktrees.
4. Prepare Linear issue drafts for everything that should not be automated tonight.
5. Create a local task list for everything that should be automated tonight.

Do not start coding yet unless explicitly instructed after this phase.

Allowed writes in this phase:
- You may create or update files only under `.ai/overnight/`
- You may create Linear issues only if Linear/MCP/CLI integration is already configured and available
- Do not modify app/source/config files
- Do not change dependencies
- Do not run migrations
- Do not commit code

First, inspect the repo enough to validate the Phase 1 findings:
- Check current git status
- Verify file paths still exist
- Validate that proposed quick wins are real
- Detect task collisions
- Identify validation commands from package scripts
- Identify test/build/lint commands
- Confirm no repo changes outside `.ai/overnight/`

Scoring formula:
For each finding, calculate:

Priority score =
  Severity weight
  + User/revenue/security impact
  + Confidence
  + Low implementation effort
  + Low collision risk
  + Easy validation
  - Risk of breaking production
  - Ambiguity
  - Cross-cutting scope

Severity weights:
- Critical: 100
- High: 70
- Medium: 35
- Low: 10

Automation suitability:
- Fully automatable: clear bug, narrow scope, obvious acceptance criteria, low regression risk
- Partially automatable: implementation is clear but needs review or product judgment
- Not automatable tonight: security-sensitive, payment/auth/billing, data model, migration, broad architecture, ambiguous UX, requires external systems, requires design/product decision

Create these files:

1. `.ai/overnight/00-summary.md`

Include:
- Total issues reviewed
- Number selected for overnight automation
- Number deferred to Linear
- Number rejected as too vague/low value
- Highest-value automation themes
- Highest-risk areas to avoid tonight
- Recommended max number of parallel agents
- Recommended batch order

2. `.ai/overnight/01-automatable-tasks.md`

Create a ranked list of overnight tasks.

For each task, include:
- Task ID: AUTO-001, AUTO-002, etc.
- Title
- Priority: P0/P1/P2/P3
- Severity source: Critical/High/Medium/Low
- Why this is worth doing tonight
- Exact scope
- Files likely involved
- Files/directories forbidden for this task
- Acceptance criteria
- Validation commands
- Estimated effort: XS/S/M/L
- Collision risk: Low/Medium/High
- Suggested agent type
- Branch/worktree name
- Dependencies on other tasks
- Rollback notes

Only include tasks that are genuinely safe for autonomous implementation.

3. `.ai/overnight/02-linear-backlog.md`

Create Linear-ready issue drafts for everything not safe to automate tonight.

For each issue:
- Title
- Priority: Urgent/High/Medium/Low
- Suggested team/project if inferable
- Suggested labels
- Description
- Evidence with file paths
- Impact
- Suggested fix
- Why deferred from overnight automation
- Acceptance criteria

If Linear integration is available:
- Ask me before creating issues unless I explicitly say “create the Linear issues now.”
- If I already said to create them, create them and append created issue URLs/IDs to this file.

4. `.ai/overnight/03-parallel-batches.md`

Group automatable tasks into safe parallel batches.

For each batch:
- Batch number
- Tasks included
- Why they can run in parallel
- Collision risks
- Recommended max agents
- Validation commands after batch completion

Rules:
- Tasks touching the same files cannot run in parallel.
- Tasks touching shared component libraries should run one at a time.
- Tasks touching auth, billing, permissions, database schema, env config, or deployment should be deferred unless absolutely trivial and low risk.
- Prefer many small low-collision tasks over one large task.
- Each task should be independently mergeable.

5. `.ai/overnight/04-agent-prompts.md`

For each automatable task, create a ready-to-paste prompt for a coding agent.

Each agent prompt must include:
- Task ID and title
- Worktree branch name
- Exact scope
- Files allowed
- Files forbidden
- Required implementation steps
- Acceptance criteria
- Validation commands
- Rule: make the smallest safe change
- Rule: do not touch unrelated files
- Rule: do not change dependencies unless explicitly required
- Rule: do not modify env/secrets
- Rule: do not run destructive commands
- Rule: commit only if validation passes
- Required final report format

6. `.ai/overnight/05-runbook.md`

Create a controller runbook for me.

Include:
- Preflight commands
- How to create each worktree
- Which agent prompt to run in which worktree
- Batch order
- Validation after each agent
- How to inspect diffs
- How to merge successful work
- How to abandon failed worktrees
- How to recover if agents collide
- Final full-repo validation commands

Use this worktree naming convention:
- Branch: `ai/overnight/AUTO-001-short-task-name`
- Worktree path: `../repo-AUTO-001-short-task-name`

Use this per-agent final report format:

Agent final report:
- Task ID
- Summary of changes
- Files changed
- Acceptance criteria status
- Validation commands run
- Validation result
- Risks/concerns
- Follow-up recommendations
- Commit hash, if committed

Decision rules:
- Pick no more than 10 automatable tasks for the first overnight run.
- Prefer tasks with Effort XS/S, High confidence, Low collision risk.
- Exclude broad refactors.
- Exclude tasks requiring product judgment.
- Exclude anything that could expose, rotate, delete, or alter secrets.
- Exclude anything that changes auth, billing, payments, permissions, data writes, migrations, or production config unless the fix is extremely narrow and obvious.
- Include UI/code-quality/performance fixes only where evidence is concrete.
- Do not invent tasks unsupported by Phase 1 evidence or repo inspection.

At the end:
- Run `git status --short`
- Confirm only `.ai/overnight/` files changed
- Print a concise summary of the top recommended overnight tasks
- Ask me whether to:
  1. create Linear issues,
  2. start the first automation batch,
  3. adjust priorities manually

Here is the Phase 1 report:
[paste Phase 1 report here]
```

Then, when Claude gives you `.ai/overnight/04-agent-prompts.md`, use this **controller execution prompt** to launch the overnight work:

```text
You are the controller for the overnight automation run.

Use the approved task list from:
- `.ai/overnight/01-automatable-tasks.md`
- `.ai/overnight/03-parallel-batches.md`
- `.ai/overnight/04-agent-prompts.md`
- `.ai/overnight/05-runbook.md`

Goal:
Run the approved automatable tasks in isolated git worktrees using parallel agents, while minimizing collision risk.

Before starting:
1. Run `git status --short`
2. Confirm the main worktree is clean except `.ai/overnight/` planning files
3. Identify the current base branch
4. Confirm validation commands from package scripts
5. Create worktrees only for Batch 1 first

Execution rules:
- One task per worktree
- One agent per task
- Do not let agents edit outside their task scope
- Do not let agents change dependencies unless the task explicitly allows it
- Do not let agents touch env files, secrets, migrations, auth, billing, permissions, or deployment config unless explicitly approved
- Do not merge automatically
- Commit inside each worktree only after task validation passes
- Keep a controller log at `.ai/overnight/controller-log.md`

For each batch:
1. Create worktrees using the approved names
2. Start agents with the matching prompts from `.ai/overnight/04-agent-prompts.md`
3. Wait for agent completion
4. For each worktree:
   - Check `git status --short`
   - Review changed files
   - Run task validation commands
   - Run relevant broader validation if needed
   - Mark result as PASS / FAIL / NEEDS REVIEW
5. Do not start the next batch until the current batch is summarized

For each successful task:
- Ensure there is a commit
- Record branch name, worktree path, files changed, validation result, and commit hash

For failed tasks:
- Do not keep partial changes unless useful
- Record why it failed
- Recommend abandon/retry/manual review

Controller log format:
- Start time
- Base branch
- Batch number
- Task ID
- Worktree path
- Branch
- Agent status
- Files changed
- Validation commands
- Validation result
- Commit hash
- Risk notes
- Recommended next action

After all batches:
1. Run full validation from the main repo if safe
2. Produce final merge order
3. Identify branches safe to merge
4. Identify branches needing review
5. Identify abandoned/failed branches
6. Confirm no unexpected files changed
7. Print final summary

Do not merge branches unless I explicitly say: “merge approved branches.”
Start with Batch 1 only.
```

And use this **merge prompt** only after you review the passing branches:

```text
You are merging approved overnight automation branches.

Approved branches to merge:
[paste approved branch list here]

Rules:
- Merge one branch at a time
- After each merge, run targeted validation
- If a conflict occurs, stop and report it
- If validation fails, stop and report it
- Do not squash unless instructed
- Do not delete branches/worktrees until final validation passes

Steps:
1. Confirm current branch and clean git status
2. Merge the first approved branch
3. Run validation
4. Record result in `.ai/overnight/merge-log.md`
5. Continue only if validation passes
6. After all merges, run full validation
7. Print final summary with merged branches, skipped branches, validation results, and remaining risks
```

This gives you a clean chain: **audit → triage → Linear/task split → worktree execution → controlled merge**.

---

## User

give me pahse 1 prompt

---

## Assistant

Mr. White, paste this into Claude:

```text
You are running Phase 1 of a repo-wide AI agent audit.

Goal:
Use a parallel read-only agent swarm to deeply inspect this codebase and produce a ranked issue inventory.

Do not modify files.
Do not create branches.
Do not commit.
Do not install packages.
Do not run migrations.
Do not call external services.
Do not expose secrets.
If you find secrets, redact values and report only file path, key name, and risk.

Use 10 parallel specialist agents. Each agent should independently inspect the repo, then return concise findings with evidence. After all agents finish, synthesize one master report.

Mandatory read-only guardrails:
- No file writes.
- No package installs.
- No destructive commands.
- No database writes.
- No external network calls.
- No secret values printed.
- Prefer static inspection: `git status`, `git ls-files`, `rg`, `find`, `cat`, `sed`, package manifests, config files, source files, tests, docs.
- Do not run commands that may create cache/build/output files.
- At the end, run `git status --short` and confirm nothing changed.

Start by checking:
- Current repo root
- Current branch
- `git status --short`
- Package manager and scripts
- Main app/framework stack
- Major directories/modules

Create these 10 agents:

Agent 1 — UX / product flow audit
Find confusing flows, broken affordances, missing loading/error/empty states, unclear navigation, bad onboarding, bad forms, bad auth/session UX, places where user intent is likely blocked.

Agent 2 — UI visual bug / glitch audit
Find layout bugs, responsive issues, z-index/modals/dropdowns, overflow, clipping, skeleton/loading glitches, inconsistent spacing, broken dark/light mode, inconsistent component usage, and visible accessibility problems.

Agent 3 — Frontend code quality audit
Find messy components, duplicated logic, bad state management, prop drilling, brittle hooks, stale patterns, untyped/loosely typed areas, confusing abstractions, dead code, and excessive coupling.

Agent 4 — Backend/API code quality audit
Find fragile endpoints, missing validation, weak error handling, duplicated business logic, inconsistent response shapes, bad data access patterns, hidden assumptions, and legacy API patterns.

Agent 5 — Performance audit
Find slow renders, unnecessary client work, excessive queries, missing memoization/caching, large bundles, N+1 patterns, expensive effects, bad image/media handling, and slow startup or route loading risks.

Agent 6 — Security/secrets audit
Find hardcoded tokens, API keys, auth bypasses, weak permissions, missing authorization checks, unsafe redirects, injection risks, exposed env assumptions, overly broad CORS, insecure cookies, and unsafe logging. Redact all secret values.

Agent 7 — Config/env/deployment audit
Find hardcoded environment assumptions, duplicated config, deprecated flags, inconsistent env var naming, missing env validation, deployment footguns, local/prod mismatch, and broken build assumptions.

Agent 8 — Dependency/deprecation audit
Find deprecated libraries/APIs, outdated framework patterns, risky dependencies, unused packages, version conflicts, soon-to-break APIs, and legacy implementations that should be replaced.

Agent 9 — Testing/QA audit
Find missing critical tests, brittle tests, untested flows, flaky patterns, no coverage for auth/billing/payments/data writes, missing regression tests for important bugs, and poor test organization.

Agent 10 — Architecture/data-model audit
Find architectural bottlenecks, bad module boundaries, schema/model issues, inconsistent naming, unclear ownership, hidden circular dependencies, overgrown files, and places where future changes will be risky.

For each agent:
1. Inspect relevant files only.
2. Collect concrete findings with file paths and short evidence.
3. Assign each finding:
   - Severity: Critical / High / Medium / Low
   - Impact: User-facing / Revenue / Security / Reliability / Performance / Maintainability
   - Effort: XS / S / M / L
   - Automation suitability: Fully automatable / Partially automatable / Needs human judgment
   - Confidence: High / Medium / Low
4. Avoid vague advice. Every finding must include specific evidence.
5. Do not invent issues. Only report issues supported by source evidence.

Master synthesis requirements:

Produce a final report with these sections:

## A. Executive summary

Include:
- Total findings by severity
- Top 10 most important issues
- Top 10 quickest wins
- Top 10 fully automatable tasks
- Top 10 issues that should become Linear tickets instead of overnight automation

## B. Ranked issue table

Columns:
Rank | Severity | Title | Impact | Effort | Automation suitability | Confidence | Area | Files | Why it matters | Suggested fix

## C. Critical and High issues

For each:
- Title
- Severity
- Evidence with file paths
- Why it matters
- Suggested fix
- Risk of automated fix
- Recommended owner: agent automation / human / Linear ticket

## D. Quick wins

Rank fixes by highest impact and lowest effort.
Include only tasks likely safe for autonomous agents.

For each quick win:
- Title
- Files
- Exact suggested change
- Acceptance criteria
- Validation command if obvious
- Collision risk with other tasks

## E. Fully automatable overnight task list

Give a clean task list suitable for parallel agents in git worktrees.

For each task:
- Task name
- Exact scope
- Files likely involved
- Files forbidden
- Acceptance criteria
- Validation command
- Estimated effort: XS/S/M/L
- Collision risk with other agents: Low/Medium/High
- Why safe to automate

## F. Linear-ticket backlog

List issues that should be tracked but not automatically fixed overnight.

For each:
- Issue title
- Priority
- Description
- Evidence
- Suggested Linear label
- Why it should not be automated immediately

## G. Risk map

Identify tasks that may conflict if multiple agents work in parallel.
Group tasks into safe parallel batches.

Rules:
- Tasks touching the same files cannot run in parallel.
- Shared component/library changes should be isolated.
- Auth, billing, permissions, database schema, env config, and deployment tasks should generally become Linear tickets unless the fix is extremely narrow and obvious.
- Prefer narrow, high-confidence, independently mergeable tasks.

## H. Final read-only confirmation

Run:
`git status --short`

Confirm whether any files changed.
If anything changed, explain exactly what changed and why.

Ranking formula:

Prioritize in this order:
1. Security vulnerabilities and exposed secrets.
2. Broken user flows or production-impacting bugs.
3. Performance issues that affect core flows.
4. High-confidence quick wins.
5. Deprecated/legacy implementations likely to break soon.
6. Code quality issues blocking future velocity.
7. Cosmetic polish.

Output rules:
- Use concise markdown.
- Use tables where helpful.
- Be specific and actionable.
- Do not include generic best practices unless tied to concrete files.
- Do not print secret values.
- Do not modify the repository.
```
