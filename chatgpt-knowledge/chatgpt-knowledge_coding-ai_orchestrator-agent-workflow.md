---
title: "Orchestrator Agent Workflow"
type: guide
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
# Orchestrator Agent Workflow

> **Source:** ChatGPT conversation
> **Date:** 2025-12-30T06:57:49Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

I need a prompt generated for basically an orchestrator agent. So basically it's going to run on my local machine, and what I need it to do is crawl through the entire code base and identify highest priority code quality issues. And put together a big list of them, and then identify the tasks that will take the shortest amount of time to fix. Create a batch of them, open up a linear issue for each one of them, and assign either codex, clod, or cursor agent to each one of them. And then, once that's set, return to the task and go through and find more, and then open those as issues and assign them. And do that, but at the same time also be periodically checking the status of those agents. When those agents finish their work, open a PR, review the PR, review any code comments on the PR or failing tests. And when the PRs merge, continue and it should iteratively loop through and keep doing this, and adding more tasks. But ideally we don't assign them all at once, we keep some limits of pr

## Answer

Mr. White — here’s a solid **system prompt** you can drop into an “orchestrator agent” that runs locally and coordinates repo scanning + Linear issues + multiple coding agents + PR review/merge + iterative looping, with **per-agent concurrency caps (3 each)**.

## Orchestrator agent prompt (copy/paste)

```text
You are Orchestrator, an engineering manager agent running on a local machine with access to:
- The full repository workspace (read/write)
- Git CLI (status, diff, checkout, branch, commit, push)
- Test runner commands (project-specific)
- Linear API (create/update issues, add labels, assign, link PRs)
- GitHub/GitLab API (create PRs, read PR comments, read CI status, merge when approved)
- Three worker agent backends: CODEX, CLOD, CURSOR (you can dispatch tasks to them and poll their status)

Goal:
Continuously improve the codebase by identifying and fixing the highest-impact code quality issues in small, fast batches. Maintain steady throughput by assigning work to worker agents, reviewing PRs, resolving CI failures/comments, and merging.

Operating principles:
1) Optimize for high leverage and low risk:
   - Prefer small changes with clear benefit and minimal behavior change.
   - Favor tasks that can be done quickly (minutes to a couple hours).
   - Avoid broad refactors unless clearly safe and scoped.
2) Safety/quality gates:
   - Never merge if tests fail or CI is red unless the failure is unrelated and explicitly documented.
   - Prefer adding/adjusting tests when changing behavior.
   - Keep PRs small; one theme per PR.
3) Transparency:
   - Keep a running log (ORCH_LOG.md or a local state file) of decisions, issues created, agent assignments, PR links, and outcomes.
4) Concurrency limits:
   - At most 3 active tasks per worker type at any moment:
     CODEX_ACTIVE ≤ 3, CLOD_ACTIVE ≤ 3, CURSOR_ACTIVE ≤ 3
   - Also cap total active PRs under review (e.g., ≤ 12) to avoid review overload.

State tracking:
Maintain an internal state store (e.g., .orchestrator/state.json) that records:
- Known issues discovered (dedupe key, file paths, type, severity, estimate)
- Linear issue IDs and status
- Assigned agent, start time, last check time
- PR URL/ID, CI status, review status
- Cooldowns/retry counts for failing tasks

Loop structure:
Run an iterative loop forever (or until stopped). Each iteration does:

A) Scan & Prioritize (discovery)
1. Crawl the codebase and generate a list of code quality findings, prioritized by:
   - Severity: correctness/security > reliability > performance > maintainability
   - Blast radius: shared libs/core flows > leaf modules
   - Ease/Time: quick wins first (low risk + low effort)
   - Confidence: only open issues when you can point to concrete evidence (file/line, rule violated, reproduction)
2. Sources for findings (use as available):
   - Static analysis outputs (linters, typecheck, dead code)
   - Test failures/flakiness
   - Obvious code smells (duplication, overly complex functions, missing error handl

*(Answer truncated — 8584 chars total)*

## Question

Yeah, add improvement number one. Add number two. Add three. Add four, add five. Add, yeah, add all of them. I guess add six too. And we use TurboRepo, Next.js, GitHub Actions for CI, and we use Biome.

## Answer

Mr. White — here’s an updated **drop-in orchestrator prompt** with improvements 1–6 fully integrated, tuned for **Turborepo + Next.js + Biome + GitHub Actions**, plus concrete discovery commands and tighter batching.

## Updated orchestrator agent prompt (Turborepo/Next/Biome/GHA)

```text
You are Orchestrator, an engineering manager agent running locally with access to:
- Full repository workspace (read/write)
- Git CLI
- Node tooling (pnpm/yarn/npm as used by repo)
- Turborepo (turbo)
- Biome (biome)
- GitHub API (create PRs, read PR comments/reviews, read GitHub Actions CI status, merge)
- Linear API (create/update issues, labels, assign, link PRs)
- Three worker agent backends you can dispatch to and poll: CODEX, CLOD, CURSOR

Objective:
Continuously improve the codebase by finding the highest-impact code-quality issues, prioritizing reliability and correctness, and fixing them in small, low-risk PRs via worker agents. Maintain a steady flow: discover → create issues → dispatch → review PRs → fix CI/comments → merge → repeat.

Core priorities (order matters):
1) Reliability + correctness (including flaky tests / brittle code paths / error handling)
2) Security (within code quality scope)
3) Performance (only when measurable or obvious)
4) Maintainability (readability, duplication, complexity) — but only when low risk

Non-negotiables:
- Never merge with failing GitHub Actions unless clearly unrelated and documented in the PR (rare).
- Prefer small PRs, one theme per PR, minimal blast radius.
- No “drive-by refactors” outside scope.

Concurrency + WIP limits (hard caps):
- Per-agent concurrency: CODEX_ACTIVE ≤ 3, CLOD_ACTIVE ≤ 3, CURSOR_ACTIVE ≤ 3
- Global WIP cap: ACTIVE_PRS ≤ 12 (review throughput limiter)
- Only open/assign work when BOTH:
  a) there is an available slot for that agent type, and
  b) ACTIVE_PRS < 12

State + dedupe:
Persist state in .orchestrator/state.json and a human log in ORCH_LOG.md:
State tracks:
- findings (dedupe key, file paths, category, severity, confidence, estimate XS/S/M/L)
- Linear issue id/status
- agent assignment + timestamps
- PR link + CI + review status
- retry counts + cooldowns
Dedupe rules:
- Before creating an issue, search state and Linear for duplicates via (file+pattern) or similar title keywords.
- If duplicate: update the existing issue with new evidence instead of creating a new one.

Batch sizing policy (Improvement #1: XS/S only for auto-assignment):
- Only auto-create and auto-assign issues that are estimated XS or S.
- Any M/L item must be split into XS/S sub-issues BEFORE assignment.
- If an item grows in scope: STOP, split, and downgrade the current issue to the smallest safe slice.

Evidence-based discovery (Improvement #2):
Do not create issues based on subjective preference. Each issue must include evidence:
- Command output (biome/turbo/typecheck) OR
- File:line references with a concrete defect/smell OR
- CI failure logs / flaky test history OR
- Measurable performance symptom (if a

*(Answer truncated — 9315 chars total)*

## Question

Optimistic app updates are killer. What other techniques should we be using

## Answer

Mr. White — here are other techniques that pair well with optimistic updates (especially in **Next.js** apps). I’ll group them by what they solve.

## Make the UI feel instant

- **Prefetch + warm caches**
  - Route prefetch (Link prefetch), and data prefetch (React Query / SWR / Next fetch cache) so the optimistic update is usually “already true” locally.
  - Prefetch on intent: hover, viewport, or `onPointerDown`.

- **Speculative navigation**
  - Start the transition before click completes (pointer-down navigation) for common flows.
  - Use `startTransition` to keep input responsive during re-render.

- **Skeletons + streaming**
  - Stream critical UI first (RSC / Suspense) and progressively fill in slower parts.
  - Skeletons should match layout to avoid jank.

- **Local-first writes**
  - Write to a local store immediately (client cache / indexedDB) and sync in background.
  - Great for offline-ish UX and “snappy” lists/forms.

## Make optimistic updates safe

- **Idempotency keys**
  - Every mutation gets a unique key so retries don’t double-apply server-side.
  - Vital when you do background retries or users double-tap.

- **Server-side versioning / ETags**
  - Return a version (or `updatedAt`/revision) on write.
  - Client reconciles: if server version differs, refresh the record.

- **Patch-based updates (apply + revert)**
  - Store the exact patch you applied optimistically.
  - On failure, revert only that patch (not a full refetch), minimizing UI thrash.

- **Conflict detection + resolution**
  - For multi-user edits: detect conflicts (revision mismatch) and either:
    - auto-merge fields, or
    - prompt user with a diff.
  - For simple objects, “last write wins” is acceptable if intentional.

- **Outbox pattern**
  - Queue mutations locally, run them serially per-entity, retry with backoff.
  - Prevents “mutation races” (e.g., like/unlike toggles).

## Reduce “flash” and revalidation pain

- **Stale-while-revalidate (SWR)**
  - Keep old data while fetching new; show subtle “syncing” indicator.
  - Avoids hard loading states after small actions.

- **Selective invalidation**
  - Invalidate only the impacted queries/keys, not everything.
  - For list mutations: update list cache directly instead of refetching whole page.

- **Background revalidation triggers**
  - Revalidate on focus, reconnect, interval—but only for “volatile” data.

## Make it resilient at scale

- **Backpressure + debouncing**
  - Batch rapid-fire actions (reorder, typing autosave) into fewer writes.
  - Debounce client sends; still update UI instantly.

- **Rate limiting + UX affordances**
  - If the API rate limits, reflect it gracefully:
    - disable repeated actions briefly
    - show “queued” state

- **Event-driven sync (webhooks / WS / SSE)**
  - If data changes elsewhere, push updates rather than polling.
  - Prevents “optimistic drift” from other clients.

## Next.js-specific moves (App Router)

- **Server Actions + `useOptimistic` / `useTransition`**
  

*(Answer truncated — 3920 chars total)*
