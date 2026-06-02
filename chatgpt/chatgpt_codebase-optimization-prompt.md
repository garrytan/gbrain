---
title: "Codebase Optimization Prompt"
type: note
created: 2025-12-27
updated: 2025-12-27
source: chatgpt-export
conversation_id: 69501d62-b53c-832e-8143-3479af88a3b0
message_count: 2
tags: [chatgpt, import]
---
# Codebase Optimization Prompt

> Conversation ID: 69501d62-b53c-832e-8143-3479af88a3b0
> Created: 2025-12-27T17:56:32Z
> Updated: 2025-12-27T17:57:07Z
> Messages: 2

---

## User

Write a prompt to recusielvy look through our code base and find the highest impact improvements we can work on. Mainly looking for refactors for oversized components or logic, performance enhancements, and reductions in code duplication or api calls. Anywhere we have redundant things happening or multiple versions of similar or identical logic that should be conformed. Also issues where we have 2 ways of doing things and 1 superior and should become the default for all locations.

The ai agent will have access to our codebase so no need to specify stack or anything

---

## Assistant

Mr. White, here’s a strong “recursive codebase review” prompt you can give an AI agent.

---

## Prompt: Recursive Codebase Improvement Audit (High-Impact Refactors + Perf + Unification)

You are an expert software architect and performance-focused refactoring agent. You have full read access to this repository (and can navigate/search it freely). Your job is to **recursively inspect the codebase** and produce a **prioritized backlog of the highest-impact improvements** we should implement.

### Primary goals (optimize for impact)
1. **Refactor oversized components / oversized logic**
   - Identify “god components”, files with too many responsibilities, deeply nested conditionals, massive hooks, massive reducers, or tangled orchestration logic.
   - Recommend decomposition boundaries and extraction targets (modules, hooks, services, utilities, domain layers).
2. **Performance enhancements**
   - Find avoidable rerenders, expensive computations in hot paths, inefficient data transforms, N+1 / repeated fetch patterns, unnecessary recomputation, unbounded list rendering, poor memoization patterns, heavy modules loaded too early, etc.
   - Identify where caching, memoization, batching, pagination, virtualization, debouncing/throttling, and lazy-loading would materially improve UX and cost.
3. **Reduce code duplication and redundant behavior**
   - Detect duplicated or near-duplicated logic, repeated UI patterns, repeated validation, repeated mapping/formatting, repeated error handling, and repeated business rules.
   - Highlight “same concept implemented 2+ ways” and propose consolidation into one canonical approach.
4. **Conform “two ways of doing things” into one default**
   - Find cases where there are multiple implementations/patterns for the same job (e.g., fetching, state mgmt, routing, forms, permissions, logging, telemetry, error boundaries, feature flags).
   - Recommend the superior approach and propose a migration plan to make it the default everywhere.

### How to work (recursive, systematic)
1. **Map the architecture**
   - Identify major domains/modules, entry points, shared libraries, and cross-cutting concerns.
   - Call out “high-churn” areas (folders/files with lots of touch points) and “high-risk” areas (auth, payments, data integrity, caching, concurrency).
2. **Locate hotspots**
   - Use repo-wide search to find:
     - Very large files / very large components / very large functions
     - Repeated code blocks (copy-paste patterns)
     - Multiple implementations of the same concept
     - Redundant API calls / repeated fetch sequences
     - Inefficient patterns in rendering and data handling
3. **Trace flows**
   - Follow key user flows and data flows end-to-end (UI → state → API → parsing → persistence → UI).
   - Identify redundant transformations, repeated calls, and inconsistent rules along the flow.
4. **Propose concrete changes**
   - For each improvement, provide:
     - **What you found** (files, functions, patterns)
     - **Why it matters** (perf/maintainability/correctness/cost)
     - **Proposed fix** (exact refactor or unification strategy)
     - **Migration steps** (incremental rollout plan)
     - **Risk level** and suggested tests to protect behavior
     - **Estimated effort** (S/M/L) and expected impact (High/Med/Low)

### Deliverable format (very strict)
Return a report with these sections:

#### 1) Executive summary (top 5 wins)
- Bullet list of the **5 highest-impact** improvements with 1–2 lines each.

#### 2) Prioritized backlog (ranked)
For each item:
- **Title**
- **Impact**: High / Med / Low
- **Effort**: S / M / L
- **Category**: Refactor / Performance / Duplication / Unification / API efficiency
- **Where**: file paths + key symbols (functions/components/classes)
- **Symptoms**: what’s currently happening (be specific)
- **Fix plan**: step-by-step
- **Acceptance criteria**: objective definition of “done”
- **Tests/verification**: what to add or run
- **Risk**: Low/Med/High + mitigation

#### 3) Unification opportunities (make 1 way the default)
- List all “two ways of doing things” you found.
- For each: pick the better one, explain why, and outline migration steps.

#### 4) Redundant API calls & duplicated logic inventory
- Group by theme (e.g., “fetch user”, “permissions check”, “format currency”, “error handling”).
- Recommend shared abstractions and where they should live.

#### 5) Quick wins vs long-term refactors
- Quick wins: <1 day each
- Medium: 2–5 days
- Long-term: >1 week
(Include dependencies between items.)

### Guardrails
- Do **not** propose “big rewrites” unless you can justify them with concrete pain and a safe incremental path.
- Prefer incremental refactors behind stable interfaces.
- If you recommend a new abstraction, show exactly what gets removed and where the new single source of truth will live.
- Bias toward changes that reduce cognitive load, reduce runtime cost, and eliminate duplicated behavior.

### Start now
Begin by scanning the repository structure and identifying:
- The largest files/components
- The most duplicated patterns
- The most likely performance hotspots
Then produce the report described above.

--- 

If you want, I can also add a “scoring rubric” so the agent ranks items consistently (e.g., impact = user-facing perf + defect risk + frequency of use + cost).
