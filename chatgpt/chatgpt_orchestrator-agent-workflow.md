---
title: "Orchestrator Agent Workflow"
type: essay
created: 2025-12-30
updated: 2025-12-31
source: chatgpt-export
conversation_id: 695377ec-900c-832e-9b11-2d46059041eb
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Orchestrator Agent Workflow

> Conversation ID: 695377ec-900c-832e-9b11-2d46059041eb
> Created: 2025-12-30T06:57:49Z
> Updated: 2025-12-31T04:46:09Z
> Messages: 6

---

## User

I need a prompt generated for basically an orchestrator agent. So basically it's going to run on my local machine, and what I need it to do is crawl through the entire code base and identify highest priority code quality issues. And put together a big list of them, and then identify the tasks that will take the shortest amount of time to fix. Create a batch of them, open up a linear issue for each one of them, and assign either codex, clod, or cursor agent to each one of them. And then, once that's set, return to the task and go through and find more, and then open those as issues and assign them. And do that, but at the same time also be periodically checking the status of those agents. When those agents finish their work, open a PR, review the PR, review any code comments on the PR or failing tests. And when the PRs merge, continue and it should iteratively loop through and keep doing this, and adding more tasks. But ideally we don't assign them all at once, we keep some limits of probably 3 agents of each at a time, max. I don't know how we manage the concurrency on that, but tell me that, and tell me your thoughts on how to improve this.

---

## Assistant

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
   - Obvious code smells (duplication, overly complex functions, missing error handling)
   - Dependency risks (outdated vulnerable deps) if you have a lockfile scanner
3. Produce a “Candidate Backlog” of findings with:
   - Title
   - Evidence (file:line, snippet summary)
   - Why it matters (impact)
   - Fix approach (high-level)
   - Estimated effort (XS/S/M; prioritize XS/S)
   - Suggested owner agent type (CODEX/CLOD/CURSOR)

B) Issue creation (batching)
4. Only create Linear issues for the top items that fit current capacity:
   - Determine available slots:
     CODEX_SLOTS = 3 - CODEX_ACTIVE
     CLOD_SLOTS  = 3 - CLOD_ACTIVE
     CURSOR_SLOTS= 3 - CURSOR_ACTIVE
   - Select items with shortest estimated time first, while ensuring at least some high-severity items are always included.
5. For each selected item:
   - Create a Linear issue with:
     * Clear acceptance criteria
     * Steps to verify (tests/commands)
     * Scope boundaries (what not to touch)
     * Labels: code-quality, quick-win, <area>, and severity
     * Link to relevant files/lines
   - Record issue ID in state store.
   - Assign to a worker agent type based on the task:
     * CODEX: mechanical refactors, lint/type fixes, simple tests, obvious bug fixes
     * CURSOR: codebase navigation heavy, multi-file changes, integration fixes, CI diagnosis
     * CLOD: deeper reasoning refactors, tricky logic, performance tuning, architectural tidy-ups

C) Dispatch work to agents
6. For each created issue, dispatch to the assigned agent with a strict task packet:
   - Branch naming: chore/<linear-id>-<slug>
   - Required steps: implement fix, run relevant tests, update docs/comments, ensure formatting
   - Deliverable: push branch + open PR + link Linear issue + summarize changes and verification
   - Constraints: keep PR small; don’t do drive-by refactors

D) Monitor & unblock (control plane)
7. Periodically poll agent status and PR status:
   - If an agent is stuck > threshold (e.g., 30–60 mins without progress), intervene:
     * fetch partial changes
     * narrow scope
     * reassign to another agent or split into smaller issues
8. For each PR opened:
   - Review diff for correctness, style, and unintended behavior change
   - Check tests locally if needed
   - Read PR comments, address requested changes
   - If CI failing: diagnose, fix, or send back to agent with precise instructions
   - Merge only when:
     * CI green
     * review complete
     * Linear issue acceptance criteria satisfied
   - After merge: close Linear issue and update state store

E) Iterate & expand
9. After merging, immediately return to discovery + batching:
   - Keep the worker queues full up to concurrency limits
   - Avoid creating too many issues at once; target a rolling window (e.g., 1–2 days worth)

Output requirements (what you print each loop):
- Current capacity: active by agent type, open PR counts
- New findings summary (top 10)
- Issues created this iteration (Linear IDs + titles + assigned agent)
- PRs reviewed/merged/unblocked
- Any blockers and your planned next action

Dedupe rules:
- Before creating a Linear issue, check if a similar issue already exists (same file+pattern or same title keywords).
- If duplicate, update the existing issue with new evidence instead of creating a new one.

Failure handling:
- If tests are flaky, create a separate issue “Deflake <test>” and label it reliability.
- If a task balloons, stop and split into smaller issues; do not allow scope creep.

Start now:
- Initialize state store if missing.
- Run discovery on the entire repo.
- Create only as many Linear issues as you have available agent slots.
- Dispatch and enter the monitoring loop.
```

---

## Concurrency management: what to do in practice

Use a simple **token/semaphore** model with a state file:

- Keep counters: `active.codex`, `active.clod`, `active.cursor`
- Each time you assign a task to an agent type, you “consume” a token.
- When the PR merges (or the task is canceled), you “release” the token.
- The orchestrator should **only create + assign** work when `slots > 0`.

This is robust even if the orchestrator restarts—because state is persisted in `.orchestrator/state.json`.

A nice refinement: add a **global WIP cap** too (e.g., max 12 active PRs), because review becomes the bottleneck before agent throughput does.

---

## Improvements I’d strongly recommend

1) **Enforce a strict “XS/S only” policy for auto-assigned tasks.**  
Anything M/L gets split before assignment. This prevents endless refactor branches.

2) **Make discovery evidence-based, not vibes-based.**  
Prefer findings from:
- failing tests
- linter/typecheck outputs
- complexity thresholds
- dead-code detection
This avoids wasting agent cycles on subjective style edits.

3) **Auto-generate acceptance criteria + verification commands.**  
Every issue should say “Run: `…` and expect: `…`”. This alone boosts merge rate.

4) **Add a “PR review checklist” that the orchestrator applies.**  
Example: API contracts unchanged, error handling, logging, tests updated, no unrelated diffs.

5) **Prioritize: reliability > maintainability.**  
Deflaking tests, fixing brittle code paths, and improving error handling tends to compound faster than purely stylistic cleanup.

6) **Introduce an “agent handoff contract.”**  
Workers must always output:
- what changed
- why
- how verified
- known risks
This cuts review time dramatically.

If you tell me what your repo stack is (TS/Go/Python/etc.) and what tooling exists (eslint/ruff/golangci-lint, typecheck, CI), I can tailor the discovery section to run the right commands and score issues more accurately.

---

## User

Yeah, add improvement number one. Add number two. Add three. Add four, add five. Add, yeah, add all of them. I guess add six too. And we use TurboRepo, Next.js, GitHub Actions for CI, and we use Biome.

---

## Assistant

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
- Measurable performance symptom (if applicable)

Repo-specific discovery playbook (Turborepo + Next.js + Biome):
First, detect package manager and scripts:
- Prefer pnpm if pnpm-lock.yaml exists, else yarn if yarn.lock, else npm.

Then run discovery in this order (capture outputs/snippets for evidence):
1) Biome:
   - biome check . (or workspace packages if configured)
   - biome lint . (if separate)
   - biome format . --write is NOT run in discovery (only in fixes)
2) TypeScript typecheck (if scripts exist):
   - turbo run typecheck (or turbo run check-types, etc.)
3) Tests:
   - turbo run test
   - If too slow, start with turbo run test --filter=<changed/critical packages> and expand
4) Next.js build (if present):
   - turbo run build
5) Dependency / config smells (lightweight, evidence-based):
   - obvious invalid tsconfig settings
   - eslint is not used; do not introduce it (Biome is standard here)

Scoring and prioritization (Improvement #5: reliability > maintainability):
For each finding assign:
- Severity: P0 correctness/security, P1 reliability, P2 maintainability, P3 style-only
- Effort: XS (<30m), S (<2h), M (half-day), L (multi-day)
- Confidence: High (tooling output), Medium (clear code evidence), Low (speculative; do not file)
Prioritize:
- P0/P1 with XS/S effort first
- Then highest blast radius (shared packages) within XS/S
- Avoid P3 style-only unless it also improves reliability or unlocks CI/tooling

Issue format + acceptance criteria (Improvement #3):
Every Linear issue you create MUST include:
- Evidence: command output excerpt OR file:line references
- Problem statement: what is wrong, why it matters
- Fix approach: high-level steps (bounded scope)
- Acceptance criteria: explicit checks
- Verification commands: exact commands to run and expected outcome
- Scope boundaries: what NOT to change

PR review checklist (Improvement #4):
For every PR:
- Scope: single theme; unrelated diffs removed
- Correctness: behavior change intended? If yes, tests updated
- Reliability: error handling/logging appropriate; no swallowed errors
- Next.js conventions respected (server/client boundaries, env usage)
- Biome clean: biome check passes
- Tests: turbo run test (relevant) passes
- CI: GitHub Actions green
- Documentation/comments updated if needed
If any fails: request changes or patch directly (small), and/or bounce back to agent with precise instructions.

Agent handoff contract (Improvement #6):
When dispatching to a worker agent, require the agent’s completion message to include:
1) Summary: what changed (bullet list)
2) Rationale: why it fixes the issue
3) Verification: commands run + results
4) Risks/notes: any edge cases, follow-ups
5) PR link + Linear link

Agent selection guide:
- CODEX: mechanical Biome fixes, small refactors, typing fixes, straightforward unit tests, simple bug fixes
- CURSOR: repo navigation heavy, multi-package integration, CI/build failures diagnosis, Next.js specific issues
- CLOD: tricky logic, deeper reasoning refactors, performance improvements (still XS/S), subtle correctness issues

Work loop (repeat forever or until stopped):

A) Control plane first (keep throughput stable)
1) Poll worker agents and PR statuses.
2) For any PR:
   - If CI failing: diagnose quickly; either fix directly or send targeted instructions to the assigned agent.
   - If review comments exist: address; keep diffs minimal.
   - If ready: merge; update Linear issue to Done; release the agent slot token.
3) If ACTIVE_PRS is near cap (≥10), prioritize reviews/merges over creating new work.

B) Discovery (only when capacity exists or backlog is low)
4) Run the repo discovery playbook. Convert tool outputs into findings with evidence.
5) Build/refresh Candidate Backlog in state.json with dedupe keys.

C) Create issues (bounded by slots + WIP cap)
6) Compute available slots:
   CODEX_SLOTS = 3 - CODEX_ACTIVE
   CLOD_SLOTS  = 3 - CLOD_ACTIVE
   CURSOR_SLOTS= 3 - CURSOR_ACTIVE
7) Select top XS/S items that fit available slots AND keep ACTIVE_PRS < 12.
8) Create Linear issues with the required format and labels:
   - Labels: code-quality, quick-win, nextjs or turborepo or biome, severity(P0/P1/P2)
   - Include acceptance criteria + verification commands.
9) Dispatch tasks to agents with strict task packets:
   - Create branch: chore/<linear-id>-<slug>
   - Implement minimal fix
   - Run verification commands
   - Push branch, open PR, link Linear issue
   - Provide handoff contract output

D) Maintain steady flow
10) Do not assign all at once. Maintain a rolling window:
    - Aim to keep each agent type at ~2 active (out of 3) unless reviews are fully caught up.
    - Prefer keeping 1 slot open per type for urgent CI breakages or P0 findings.

Outputs each iteration (print):
- Capacity: active tasks per agent type; ACTIVE_PRS count
- Newly discovered top findings (top 10, with evidence pointers)
- Issues created + assigned this iteration (Linear IDs)
- PRs reviewed/merged/unblocked
- Blockers + next actions

Start now:
- Initialize state store if missing.
- Determine package manager.
- Run discovery commands.
- Create and assign only XS/S issues up to available slots and WIP cap.
- Enter the monitoring + iteration loop.
```

---

## Concrete commands to bake into your orchestrator (so it’s not guessing)

In your implementation, have it *detect* scripts but default to these:

- Biome:
  - `biome check .`
- Typical Turborepo tasks (if present):
  - `turbo run typecheck`
  - `turbo run test`
  - `turbo run build`

If the repo uses `pnpm` (likely with Turborepo):
- `pnpm -w biome check .`
- `pnpm -w turbo run typecheck test build`

(Your orchestrator should read `package.json` + `turbo.json` to confirm actual task names.)

---

## How I’d manage concurrency (simple + durable)

Use **two caps**:
1) **Per-agent semaphore**: max 3 active tasks per agent type.
2) **Global PR WIP cap**: max 12 open PRs.

Release tokens **only** when:
- PR merged (preferred), or
- Task canceled/superseded.

This avoids a situation where the orchestrator keeps spawning work but review/CI becomes the bottleneck.

---

If you want, I can also give you:
- a ready-to-use **Linear issue template** (title/body/labels) matching this prompt
- a **state.json schema** and a minimal orchestrator loop pseudocode (Node/TS) that implements the semaphores + polling.

---

## User

Optimistic app updates are killer. What other techniques should we be using

---

## Assistant

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
  - Great for form-like writes.
  - Combine with `revalidatePath`/`revalidateTag` carefully—don’t blow away caches unnecessarily.

- **Tag-based cache invalidation**
  - If using `fetch` caching with tags, invalidate the smallest tags.
  - Pair optimistic UI with targeted `revalidateTag` to confirm.

- **Partial rendering boundaries**
  - Keep frequently-mutated components in client islands so RSC rerenders don’t clobber local state.

## High-leverage “must-have” checklist

If you’re already doing optimistic updates, the biggest next wins are usually:
1) **Idempotency keys**
2) **Outbox/serial mutation queue per entity**
3) **Patch-based apply/revert**
4) **Selective cache updates + minimal invalidation**
5) **SWR/streaming/skeletons to hide slow reads**

If you tell me what you’re using for data (React Query, SWR, tRPC, Apollo, custom fetch + RSC), I’ll map these into concrete patterns + code for your stack.


## See Also
- [[chatgpt/chatgpt_memory-and-agent-workflow]]
- [[chatgpt/chatgpt_hermes-orchestrator-model-setup]]
- [[chatgpt/chatgpt_2026-landing-page-workflow]]
- [[chatgpt/chatgpt_admin-workflow-design]]
- [[chatgpt/chatgpt_agent-first-strategy-for-jovie]]
