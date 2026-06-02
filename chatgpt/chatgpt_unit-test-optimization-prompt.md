---
title: "Unit test optimization prompt"
type: guide
created: 2025-12-06
updated: 2025-12-06
source: chatgpt-export
conversation_id: 6933bcf4-04d0-8329-becc-66258c0dc9d2
message_count: 2
tags: [chatgpt, import, code]
---
# Unit test optimization prompt

> Conversation ID: 6933bcf4-04d0-8329-becc-66258c0dc9d2
> Created: 2025-12-06T05:20:20Z
> Updated: 2025-12-06T05:20:39Z
> Messages: 2

---

## User

Give me a prompt to get all unit tests to under 200ms. I want the agent to run recursively running ppm test and then fixing the top offenders then repeating until they are all under 200ms

---

## Assistant

Here’s a prompt you can paste into your coding agent:

```text
Goal: Get every unit test to run in under 200ms.

Context:
- The test command is: `ppm test`
- You may refactor production code and test code, but you must not change externally observable behavior or weaken real assertions.
- You should work iteratively: measure → find slowest tests → speed them up → re-measure, until all tests are under 200ms or you hit a clear hard limit.

Process:

1. Baseline
   - Run `ppm test` and capture:
     - Total runtime.
     - Per-test runtimes, if available (e.g., via test runner timing output or flags). If per-test timing is not enabled, enable it (e.g., appropriate CLI flag or config) so you can see the slowest tests.
   - List the top 10 slowest tests with their runtimes and file locations.

2. Choose top offenders
   - Focus on the slowest tests first (worst offenders).
   - For each slow test, inspect:
     - The test code.
     - The fixtures / setup / teardown.
     - The production code paths used by the test.

3. Optimization strategy (in this order of preference):
   - Remove unnecessary sleeps, polling loops, or artificial waits.
   - Replace real I/O (disk, network, DB, external APIs) with in-memory or mocked substitutes.
   - Share expensive setup using fixtures or setup methods instead of recomputing per test, as long as tests remain isolated and deterministic.
   - Cache or memoize expensive pure computations across tests where safe.
   - Reduce data size used in tests (smaller fixtures, fewer records) while still fully covering logic.
   - Split or reorganize tests that do too much in one case.
   - Refactor production code hot paths to be more efficient *only if* behavior and public APIs remain identical.

4. Safety & correctness
   - After each change to tests or code:
     - Re-run the relevant test file or suite to ensure all tests still pass.
     - Check that assertions still validate meaningful behavior (no replacing strong assertions with trivial ones).
   - Do not delete tests or skip them just to meet the time budget, unless they are truly redundant or duplicated—and explain clearly when you do.

5. Re-measure & loop
   - After a batch of optimizations, run `ppm test` again with timing enabled.
   - Generate an updated list of slowest tests with runtimes.
   - Keep iterating: always attack the current slowest tests first.
   - Continue this loop until:
     - All tests are under 200ms, or
     - You determine some tests cannot go under 200ms without harming correctness or architecture. In that case, explain why for each remaining slow test.

6. Reporting
   - Maintain a running summary including:
     - Before/after runtime for each optimized test.
     - Key changes you made and why they are safe.
     - The final distribution of test runtimes and any tests still exceeding 200ms with rationale.

Now start with step 1: run `ppm test` with timing information, show me the top 10 slowest tests, and describe your initial optimization plan.
```
