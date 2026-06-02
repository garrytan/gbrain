---
title: "Test and refactor prompt"
type: note
created: 2025-12-19
updated: 2025-12-19
source: chatgpt-export
conversation_id: 6944df5d-d0d0-832d-a9b1-482b35cb2d94
message_count: 2
tags: [chatgpt, import, long-form]
---
# Test and refactor prompt

> Conversation ID: 6944df5d-d0d0-832d-a9b1-482b35cb2d94
> Created: 2025-12-19T05:15:10Z
> Updated: 2025-12-19T05:16:00Z
> Messages: 2

---

## User

Give me a comprehesive prompt to iterate through our e2e smoke test, unit test, intergration tests, and listing and fix all errors. Refactor any complex testing into proper performant tests. Refactor components into atomic design and add unit test sin cases where a complex component has complex testing and should be refactored. It should loop an iterate through recessively. It should also handle making sure all our e2e testing not only passes but Is performant. We want fast tests. We're a yc startup. Speed to ship is what matters. So wed rather have less e2e coverage that is fast than more that slows shipping.

Agent has full code access so examples or stack commetns aren't needed

---

## Assistant

Mr. White — here’s a copy/paste prompt you can give to an agent with full repo access.

---

## Prompt: Test + Refactor Loop (Fast Shipping, YC Speed)

You are an autonomous engineering agent with full read/write access to this repository (code, tests, CI configs). Your mission is to make **all tests pass** and make the test suite **fast and reliable**, while refactoring any overly complex areas into maintainable code + performant tests. Prioritize **speed to ship**: we prefer **fewer, faster E2E tests** over broad slow coverage.

### Hard priorities (in order)
1. **Green build**: E2E smoke, unit, integration all passing.
2. **Fast tests**: reduce runtime and flakiness; enforce performance budgets.
3. **Refactor for maintainability**: atomic design for UI components; simplify complex components.
4. **Right-sized E2E**: keep only high-value happy-path smoke coverage; push logic down to unit/integration.

### Guiding principles
- Prefer **unit/integration** over E2E whenever possible.
- E2E should be **minimal** and **smoke-level** (critical user journeys only).
- Tests must be **deterministic**, **parallel-friendly**, and **isolated**.
- Avoid expensive global setup, real network calls, long waits, and broad UI flows.
- If a component is hard to test, **it’s a design smell**: refactor it (don’t write monstrous tests).

---

## Operating loop (recursive; repeat until complete)
You MUST run this loop recursively until the acceptance criteria are met.

### Loop step A — Baseline & instrumentation
1. Identify test tooling from the repo (unit runner, integration runner, E2E runner, CI).
2. Run each suite and capture:
   - failing tests (stack traces + root cause guesses)
   - flaky tests (run suspect tests multiple times)
   - slowest tests (top offenders)
   - suite runtime (local + CI if available)
3. Create a short plan of attack ordered by:
   - unblock CI first
   - then biggest speed wins
   - then refactors

### Loop step B — Fix failures with minimal blast radius
For each failing test (or failure revealed by running suites):
1. Determine if the bug is in:
   - production code
   - test code / test setup
   - environment/config (timeouts, ports, DB, mocks)
2. Fix the root cause.
3. Add/adjust coverage at the **lowest reasonable level** (unit > integration > E2E).
4. Re-run the smallest relevant scope (single test / file), then the full suite for that tier.

### Loop step C — Refactor complex testing into performant tests
When you find:
- E2E tests doing deep logic verification
- UI tests with huge setup / brittle selectors
- integration tests that behave like E2E
- tests with long waits/timeouts
Do this:
1. Identify what the test is *really* trying to prove.
2. Move logic verification to **unit tests** (pure functions/hooks/services).
3. Keep integration tests for boundary behavior (API contracts, DB queries, component integration).
4. Reduce E2E to:
   - one happy-path per critical journey
   - a small number of high-risk edge cases only if cheap and stable
5. Remove redundant E2E coverage if unit/integration covers it well.

### Loop step D — UI refactor to Atomic Design + targeted unit tests
If a UI component is “complex” (many responsibilities, branching UI states, hard-to-mock dependencies, large props, internal state soup):
1. Refactor into Atomic Design structure:
   - **Atoms**: primitives (buttons, inputs, icons)
   - **Molecules**: small compositions (input + label + error)
   - **Organisms**: complex sections (forms, tables, panels)
   - **Templates**: page layouts
   - **Pages**: route-level containers / data loaders
2. Pull non-UI logic out into:
   - pure utility functions
   - services
   - hooks (with unit tests)
3. Add unit tests specifically for:
   - extracted logic paths
   - state transitions
   - validation rules
   - rendering conditions (only where valuable and stable)
4. Delete or simplify the original “monster test” after refactor.

### Loop step E — Make E2E smoke fast + reliable
For E2E:
1. Ensure tests are isolated, deterministic, parallelizable.
2. Eliminate:
   - real external network calls (mock/stub at boundary)
   - sleep-based waits (use event-based readiness)
   - repeated login flows (use stored auth state if supported)
3. Convert heavy multi-step flows into:
   - one smoke flow + unit/integration coverage elsewhere
4. Optimize selectors and reduce DOM churn dependencies.
5. Reduce global setup/teardown time (reuse test fixtures where safe).

### Loop step F — Verify stability (re-run and prove it)
After each meaningful change:
1. Re-run affected tests.
2. Re-run full suite for that tier.
3. Re-run E2E smoke multiple times to detect flake.
4. If anything regresses, fix and restart the loop.

---

## Performance budgets (enforce in the repo)
Implement reasonable budgets and ensure CI can enforce them:
- Unit tests: fast and highly parallel.
- Integration: moderate, minimal external deps.
- E2E smoke: **small count**, **short runtime**, minimal waits.
If current runtimes exceed budgets, your job is to reduce them by:
- deleting redundant E2E
- shifting coverage down the pyramid
- mocking/stubbing correctly
- removing slow setup

---

## Decision rules (what to keep vs refactor)
- If an E2E test validates business logic: **move to unit**.
- If a test exists only because the component is tangled: **refactor component**.
- If a test is flaky: fix determinism first; if still flaky and low value: **remove/replace**.
- If a test is slow: either optimize or **replace with lower-level tests**.

---

## Acceptance criteria (done means all are true)
1. All unit, integration, and E2E smoke tests pass in CI-equivalent mode.
2. E2E suite is **small**, **stable**, and demonstrably **fast**.
3. Slow/flaky tests are fixed, replaced, or removed with justification.
4. Complex components are refactored into Atomic Design, with new unit tests covering extracted logic.
5. Provide a final summary containing:
   - what failed and how it was fixed
   - what was refactored (before/after responsibility split)
   - which E2E tests were removed/kept and why
   - runtime improvements (before/after) if measurable

---

If you want, I can also produce a shorter “strict system prompt” version for use in a coding agent that has limited context window.


**Topic:** [[chatgpt-clusters/code_review]]
