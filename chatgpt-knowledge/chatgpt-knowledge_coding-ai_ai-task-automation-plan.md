---
title: "AI Task Automation Plan"
type: guide
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
topic: coding-ai
message_count: 8
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# AI Task Automation Plan

> **Source:** ChatGPT conversation
> **Date:** 2026-04-24T06:38:11Z
> **Messages:** 8
> **Topic:** coding-ai

## Question

i need to PLOW through ai usage overnight in order ot maximie before limits expire tomorr afternoon.

im gonna spin up a claude session on my pc with bypass permission on. iw ant to use task list and gent teams and paralell agents to /ideate the most critical thing and then ru them overnight.

so we;; do this in two phases. first you givre me a prompt to give clause to use paralel agent swarm like 10 agents to deep dive reado only on the codebase and find ux issues, code wuality issues, performance issues, ui bug/glitches, hardcode tokens that should be conformed, perfomance issues. legacy implementaion that are depreciated security gaps etc.

and rank them by critical to low.

then we;;ll rank those and pick what is the quickest wins for full automateion.

we'll open linear issues for everything that isnt and local tak list for everything that is. then we;ll assing paralell agents in worktrees with bypass permissions to run on the pc. 

so give me the first prompt. 

## Answer

Mr. White, here’s a Phase 1 copy-paste prompt for a read-only overnight audit using 10 focused agents to find, dedupe, and rank issues without modifying the repo.

## Answer

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
Find missing critical te

*(Answer truncated — 6284 chars total)*

## Question

continue

## Answer

Mr. White, the next prompt turns the Phase 1 audit into a triaged execution plan, separating Linear-worthy work from safe overnight worktree batches before edits begin.

## Answer

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


*(Answer truncated — 10285 chars total)*

## Question

give me pahse 1 prompt

## Answer

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



*(Answer truncated — 7040 chars total)*
