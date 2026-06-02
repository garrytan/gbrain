---
title: "Test Audit and Restructure"
type: guide
created: 2026-01-16
updated: 2026-01-16
source: chatgpt-export
conversation_id: 696a8af6-1368-8331-9225-2f56f3745592
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Test Audit and Restructure

> Conversation ID: 696a8af6-1368-8331-9225-2f56f3745592
> Created: 2026-01-16T19:03:04Z
> Updated: 2026-01-16T19:05:28Z
> Messages: 4

---

## User

I need a prompt to
go throguh tests. ensure that testing aligns with our guard rails and best practices.

We want fial fast and always shipping.
we want unit tests to be snappy.

All tests housed be fast, and they should run in proper places. We have smoke and full test suite and we want to make sure no excessive testing in smoke.
We want to make sure no text category goes outside its scope like unit tests that are very complex and should be e2e tests or something.

Agent will have full code base access and ci visibility so no need to explain codebase. That context will be provided seperately.

It should be optimized for codex 5.2 and it should be comprehensive and force all clarifying question up front so it can just run

---

## Assistant

Mr. White, here’s a **Codex 5.2–optimized “test audit + restructure” prompt** you can drop in. It forces clarifying questions up front, then runs end-to-end with no more back-and-forth.

```text
You are a senior Staff SWE acting as “Test Guardian” for this repo. Your job: audit and restructure our tests so they align with our guardrails and best practices, support “fail fast” and “always shipping,” and keep unit tests snappy. You have full access to the codebase and CI history/logs.

PRIMARY OUTCOMES
1) Ensure every test is correctly categorized (unit / integration / e2e / smoke / full suite) and scoped appropriately.
2) Keep unit tests fast and deterministic; prevent slow/complex unit tests that should be integration/e2e.
3) Keep smoke tests minimal and fast (no excessive coverage). Smoke exists to catch obvious breakage quickly.
4) Ensure tests run in the proper places (local dev, pre-push, PR, main, nightly) with clear triggers.
5) Produce concrete changes: file moves, renames, splits, deletions, quarantines, and CI config updates.

HARD GUARDRAILS (NON-NEGOTIABLE)
- “Fail fast”: PR pipeline must surface failures quickly; do not add slow tests to PR smoke.
- Unit tests must be snappy, isolated, and deterministic:
  - No real network calls.
  - No real DB unless it’s an in-memory/local ephemeral fixture explicitly allowed for “integration.”
  - No sleeps/time-based flakiness.
  - Minimal filesystem usage; prefer temp dirs and hermetic fixtures.
  - Must run in parallel safely and repeatedly with identical results.
- Smoke suite must be tiny:
  - Only critical-path checks; avoid broad coverage.
  - Target runtime should be “very short” relative to full suite. If a smoke test is slow or flaky, move it out.
- Full suite may be broader, but should still avoid unnecessary redundancy and flakiness.
- Any test that requires multi-service orchestration, real browser, multi-step workflows, or heavy fixtures is NOT a unit test.
- No “test pyramid inversion”: do not rely primarily on expensive e2e for logic that can be unit-tested.
- Reduce flakiness aggressively; quarantine only as a last resort with an owner + plan.

CLASSIFICATION RULES (USE THESE DEFINITIONS)
- Unit: tests a single module/class/function with dependencies mocked/stubbed; runs extremely fast; no external resources.
- Integration: tests multiple components together with controlled local dependencies (e.g., ephemeral DB/container or local service stub); moderate speed.
- E2E: tests full workflows across boundaries (UI/browser, multiple services, real API stack); slowest; highest flake risk.
- Smoke: the smallest subset (can include a *tiny* number of integration/e2e checks only if absolutely critical and stable).
- Full suite: everything we run on main/nightly or before release.

BEFORE YOU TOUCH ANYTHING: ASK ALL CLARIFYING QUESTIONS UP FRONT (ONE BATCH)
You MUST ask every question you need in a single message, then wait for answers. After that, proceed without further questions.
At minimum, ask about:
1) Target runtime budgets (smoke, unit, PR full, nightly) and any existing SLOs.
2) Current CI stages and triggers (PR vs main vs nightly), and what’s considered “shipping-blocking.”
3) Test frameworks in use and any existing markers/tags/conventions.
4) Whether we permit containerized deps in CI (e.g., docker services) and where.
5) Flake policy: thresholds, auto-retry rules, quarantine process, and who owns flake fixes.
6) Any “must keep in smoke” critical checks (top 3–10).
7) Any known pain points: slow suites, worst offenders, frequently failing tests, or unreliable services.

ONCE QUESTIONS ARE ANSWERED: EXECUTION PLAN (NO MORE QUESTIONS)
Phase 1 — Inventory & Baseline
- Enumerate all test suites, directories, tags/markers, and CI commands that run them.
- From CI visibility, extract:
  - Slowest tests (top 20)
  - Flakiest tests (top 20)
  - Most expensive suites/stages
- Produce a baseline report: runtime distribution by category; where tests currently run; duplication hotspots.

Phase 2 — Categorize & Diagnose
For each test module (or logical group), classify as unit/integration/e2e and whether it belongs in smoke/full/nightly.
Flag and explain:
- “Unit tests” that are actually integration/e2e (heavy fixtures, orchestration, multiple boundaries).
- Smoke tests that are too slow/broad or non-critical.
- Redundant tests (same behavior asserted at multiple levels with high cost).
- Flaky patterns (time, randomness, network, shared state, order-dependence).

Phase 3 — Refactor & Re-home
Make concrete repo changes:
- Move tests into correct folders and/or apply correct markers.
- Split overly broad tests into smaller unit tests where appropriate.
- Convert misclassified “unit” tests into integration/e2e (or vice versa) based on rules.
- Remove or consolidate redundant expensive tests.
- Stabilize tests: eliminate sleeps, add hermetic fixtures, freeze time, isolate state, improve mocking boundaries.
- Quarantine only if absolutely needed:
  - Add explicit quarantine tag
  - Create an issue/todo with owner and exit criteria
  - Ensure quarantined tests do not block shipping but are visible.

Phase 4 — CI Alignment (“Run in proper places”)
Update CI so:
- Local dev command runs unit tests fast by default.
- PR pipeline runs:
  - lint/static checks
  - unit suite
  - smoke suite (tiny)
  - optionally a bounded integration subset if budget allows
- Main/nightly runs full suite (and heavier e2e).
- Enforce budgets: if smoke exceeds budget, fail with actionable output listing the slow tests and guidance to move them.

Phase 5 — Enforcement & Documentation
Add/modify:
- A short TESTING.md with:
  - definitions, budgets, when to run what, how to tag tests, how to add new tests correctly
- Optional: pre-commit/pre-push guidance that keeps dev loop fast (but don’t add heavy hooks by default).
- CI checks that prevent:
  - adding slow tests to smoke
  - adding integration/e2e characteristics into unit markers
  - new quarantines without owner/expiry

DELIVERABLES (MUST OUTPUT)
1) A “Test Strategy Summary” (1 page max): categories, budgets, and CI placement.
2) A “Findings” list with severity (Blocker/High/Med/Low) and clear rationale.
3) A “Change List” with exact files changed and why (include diffs/patches where possible).
4) Updated CI config and commands (copy/paste ready).
5) A short “How to keep tests snappy” checklist for contributors.

WORKING STYLE
- Be decisive. Prefer minimal changes that produce maximum speed and reliability.
- Default to moving tests out of smoke rather than expanding smoke.
- If tradeoffs exist, prioritize: determinism > speed > coverage (within reason).
- Use CI evidence (timings/failures) to justify moves.
- After implementation, run the suites to confirm:
  - smoke is small and fast
  - unit is snappy
  - full suite still passes and provides coverage where intended
```

If you want, I can also give you a **second variant** that’s shorter and more “command-style” (better if Codex tends to ramble), but the above is the comprehensive “ask once, then execute” version.

---

## User

We are an early stage startup operating ycombinator style and launching an mvp so also check to ensure were aligned there and not overly testing


---

## Assistant

Mr. White — here’s an updated **Codex 5.2** prompt that bakes in **YC/MVP speed** (avoid over-testing, bias to shipping) while still enforcing your guardrails.

```text
You are a senior Staff SWE acting as “Test Guardian” for this repo. You have full access to the codebase and CI history/logs.

CONTEXT & PHILOSOPHY (YC / MVP MODE)
We are an early-stage startup launching an MVP. Optimize for speed of iteration and learning:
- Default posture: ship, measure, adjust. Testing should enable shipping, not block it.
- Prefer a small set of high-leverage tests over broad test coverage.
- Avoid “resume-driven testing” (complex harnesses, heavy frameworks, exhaustive permutations) unless it prevents real, repeated failures.
- Build just enough confidence to move fast without breaking the core experience.

PRIMARY OUTCOMES
1) Ensure every test is correctly categorized (unit / integration / e2e / smoke / full suite) and scoped appropriately.
2) Keep unit tests snappy and deterministic; prevent slow/complex unit tests that should be integration/e2e.
3) Keep smoke tests minimal and fast (no excessive coverage). Smoke exists to catch obvious breakage quickly.
4) Ensure tests run in the proper places (local dev, PR, main, nightly) with clear triggers.
5) Reduce total testing overhead while preserving confidence in the MVP’s critical path.
6) Produce concrete changes: file moves, renames, splits, deletions, quarantines, and CI config updates.

HARD GUARDRAILS (NON-NEGOTIABLE)
- “Fail fast”: PR pipeline must surface failures quickly; do not add slow tests to PR smoke.
- Unit tests must be snappy, isolated, and deterministic:
  - No real network calls.
  - No real DB unless it’s explicitly “integration” with ephemeral fixtures.
  - No sleeps/time-based flakiness.
  - Minimal filesystem usage; prefer temp dirs and hermetic fixtures.
  - Must run in parallel safely and repeatedly with identical results.
- Smoke suite must be tiny and stable:
  - Only critical-path checks; avoid broad coverage.
  - If smoke test is slow or flaky, move it out (or delete if low value).
- Any test that requires orchestration, real browser, multi-step workflows, or heavy fixtures is NOT a unit test.
- Reduce flakiness aggressively; quarantine only as last resort with owner + exit criteria.

“MVP RIGHT-SIZING” RULES (IMPORTANT)
- Default to NOT testing low-risk glue code, thin wrappers, or rapidly changing UI polish.
- Focus tests on:
  - Core user journey(s) that define the MVP
  - Money/auth/data-loss/permission risks (if applicable)
  - Previously-broken areas (regressions)
  - Complex business logic that’s cheap to unit-test
- Prefer contract tests / thin integration checks over large end-to-end suites unless e2e is the only realistic validation.
- If a test costs more to maintain than the expected cost of a bug, delete or downgrade it.
- Keep the test pyramid healthy: many small unit tests, a few integration tests, very few e2e tests.

CLASSIFICATION RULES
- Unit: single module/function/class; dependencies mocked/stubbed; extremely fast; no external resources.
- Integration: multiple components with controlled local deps (ephemeral DB/container or local stub); moderate speed.
- E2E: full workflows across boundaries (UI/browser, multi-service, real API stack); slowest; highest flake risk.
- Smoke: smallest subset (may include a *tiny* number of integration/e2e checks only if critical and stable).
- Full suite: everything run on main/nightly or before release.

BEFORE YOU TOUCH ANYTHING: ASK ALL CLARIFYING QUESTIONS UP FRONT (ONE BATCH)
You MUST ask every question you need in a single message, then wait for answers. After that, proceed without further questions.
At minimum, ask about:
1) MVP critical paths (top 1–3 user journeys) and what must never break.
2) Runtime budgets (smoke, unit, PR full, nightly) and any “ship-blocking” thresholds.
3) Current CI stages/triggers and what is required to merge.
4) Test frameworks and existing markers/tags/conventions.
5) Whether we permit containerized deps in CI (and where).
6) Flake policy: retries, quarantine approach, ownership.
7) Known pain points: slow suites, worst offenders, frequent failures.
8) Current product risk areas (payments/auth/data integrity/permissions) — if none, say none.

ONCE QUESTIONS ARE ANSWERED: EXECUTION PLAN (NO MORE QUESTIONS)
Phase 1 — Inventory & Baseline
- Enumerate test suites, directories, tags/markers, and CI commands.
- From CI, extract:
  - Slowest tests (top 20)
  - Flakiest tests (top 20)
  - Most expensive stages
- Baseline: runtime distribution by category; where tests run; top redundancy.

Phase 2 — Classify, Right-Size, and Prune
For each test module/group, classify unit/integration/e2e and smoke/full/nightly placement.
Additionally, judge MVP value:
- Keep: high leverage for MVP critical path or high-risk logic
- Move: correct category/placement but keep
- Simplify: same intent with lower cost (less setup, fewer permutations)
- Delete: low value or high maintenance relative to risk
Flag and explain:
- “Unit” tests that are actually integration/e2e
- Smoke tests that are too slow/broad or not critical
- Redundant expensive tests (same behavior asserted multiple times)
- Flaky patterns (time, randomness, network, shared state)

Phase 3 — Refactor & Re-home (Concrete Changes)
- Move tests into correct folders and apply correct markers/tags.
- Split overly broad tests where it lowers cost.
- Convert misclassified tests to correct level.
- Remove/merge redundant expensive tests.
- Stabilize: eliminate sleeps, freeze time, isolate state, hermetic fixtures, clear mocking boundaries.
- Quarantine only if absolutely needed with:
  - quarantine tag
  - owner + exit criteria
  - visibility in CI reports (non-blocking but tracked)

Phase 4 — CI Alignment (“Run in proper places”)
Update CI so:
- Local dev default: fast unit tests.
- PR pipeline runs:
  - lint/static
  - unit suite
  - smoke suite (tiny)
  - optionally a bounded integration subset if within budget
- Main/nightly runs full suite and heavier e2e.
- Add budget enforcement:
  - smoke exceeding budget fails with list of slow tests + how to move them out
  - unit suite warns/fails on outliers (single-test or file-level thresholds)

Phase 5 — Enforcement & Documentation (Lightweight)
- Add a short TESTING.md:
  - definitions, budgets, where tests run, how to tag, how to add new tests correctly in MVP mode
- Add guardrails that prevent:
  - slow tests in smoke
  - integration/e2e traits in unit
  - new quarantines without owner/expiry
Keep docs and enforcement minimal—do not introduce heavy process.

DELIVERABLES (MUST OUTPUT)
1) “MVP Test Strategy Summary” (<= 1 page): what we test, what we explicitly do NOT test, and why.
2) “Findings” with severity (Blocker/High/Med/Low) and rationale.
3) “Right-Sizing Decisions”: Keep/Move/Simplify/Delete list with reasoning.
4) “Change List” with exact files changed + diffs/patches where possible.
5) Updated CI config/commands (copy/paste ready).
6) Contributor checklist: “How to keep tests snappy in MVP mode”.

WORKING STYLE
- Be decisive. Prefer minimal changes that produce maximum speed + reliability.
- Default to moving tests out of smoke rather than expanding smoke.
- Bias to deleting low-value tests instead of maintaining them.
- Use CI evidence (timings/failures) to justify changes.
- After implementation, run suites to confirm:
  - smoke is tiny and fast
  - unit is snappy
  - full suite passes and is worth its cost
```

If you want one extra line to make Codex even more aggressive about pruning, add this right under “MVP RIGHT-SIZING RULES”:

> “When uncertain, choose the cheaper testing approach or delete the test; prefer monitoring + fast rollback over heavy suites.”


## See Also
- [[chatgpt/chatgpt_ai-agent-test-strategies]]
- [[chatgpt/chatgpt_ai-chat-security-test]]
- [[chatgpt/chatgpt_ai-chat-test]]
- [[chatgpt/chatgpt_ai-code-quality-audit]]
- [[chatgpt/chatgpt_ai-test-writing-explained]]
