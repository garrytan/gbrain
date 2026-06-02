---
title: "Test Coverage Goal Design"
type: guide
created: 2026-05-24
updated: 2026-05-24
source: chatgpt-export
conversation_id: 6a126605-1270-83e8-9401-b26d7d751839
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Test Coverage Goal Design

> Conversation ID: 6a126605-1270-83e8-9401-b26d7d751839
> Created: 2026-05-24T02:44:21Z
> Updated: 2026-05-24T03:00:40Z
> Messages: 8

---

## User

Help me design a Codex /goal for Jovie: test coverage accross the app 80-90% or whatever is meaninful but also meaniful so no bs tests on ui shit thats flaky etc and all tests perfroamnt

---

## Assistant

I’ll shape this into a concrete Codex `/goal` with meaningful coverage targets, quality gates, anti-flake rules, performance limits, and stop conditions against vanity tests.

---

## Assistant

Mr. White, use this as the main Jovie `/goal`:

```text
/goal Establish meaningful, performant test coverage across the Jovie app, targeting at least 80% overall coverage for non-generated application code and 85–90% coverage for core business logic, data flows, API/client logic, auth/payments/onboarding-critical paths, utilities, and regression-prone modules. First inspect the repo’s existing test framework, coverage config, CI commands, app architecture, and current coverage baseline, then choose defensible per-area targets rather than blindly chasing a single number.

Verify success with the repo’s actual coverage report, full test suite, lint/typecheck/build commands, and any existing CI-equivalent command. Preserve production behavior, public APIs, existing passing tests, build performance, and developer test ergonomics.

Prioritize high-signal tests: business rules, edge cases, API contracts, data transformations, state transitions, auth/session behavior, error handling, permissions, billing/payment-critical logic, and user-visible integration flows. Avoid low-value or flaky tests: snapshot-only tests, CSS/className/layout assertions, brittle implementation-detail UI tests, tests that depend on real network calls, arbitrary sleeps, wall-clock timing, randomness, external services, or unstable browser behavior. UI tests should cover stable user-visible behavior only, using deterministic mocks, fake timers where appropriate, and accessible queries rather than DOM internals.

Keep tests performant. Prefer fast unit and focused integration tests. Mock external services at boundaries. Do not add broad end-to-end coverage unless it protects a critical path and can run deterministically. Track test runtime before and after; if the full suite slows materially, optimize or split tests so routine local/CI runs remain practical.

Between iterations, report: files/modules covered, tests added or changed, coverage delta, suite runtime delta, any flaky-risk removed or introduced, and the next highest-value uncovered area. If 80% overall coverage is achievable only through low-value tests, stop before adding those tests and propose a more meaningful target with an explicit rationale. If blocked by missing test infrastructure, unstable existing tests, unclear commands, or architectural issues, stop with the evidence gathered, attempted paths, blocker, and the smallest next input needed.
```

Why this shape works: OpenAI’s Codex Goal guidance recommends defining the outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition; it also says completion should be checked against concrete evidence such as files, commands, tests, logs, benchmarks, or artifacts. citeturn322691view1

A tighter variant if you want Codex to be more aggressive:

```text
/goal Raise Jovie’s meaningful test coverage to a defensible production-quality level: minimum 80% overall coverage for non-generated app code, minimum 85% for core business/domain logic, and minimum 90% for critical revenue, auth, onboarding, and data-integrity paths, unless the repo evidence shows a different threshold is more meaningful. Do not inflate coverage with brittle UI, snapshot-only, styling, generated-code, config, type-only, or implementation-detail tests.

Use the repo’s real test runner, coverage tooling, lint/typecheck/build commands, and CI-equivalent validation. First establish the current baseline and identify the highest-risk uncovered modules. Then add fast deterministic tests in priority order: business rules, API boundaries, data transforms, auth/session/payment flows, state machines, error cases, and regression-prone modules. Use mocks/fakes for external services, deterministic timers, seeded randomness, and no real network dependencies.

Completion requires: coverage report meets the agreed threshold or a documented meaningful alternative; all existing and new tests pass; lint/typecheck/build pass; test runtime remains reasonable versus baseline; no known flaky tests are introduced; and the final report includes before/after coverage, runtime, commands run, exclusions with rationale, and remaining uncovered risks.

If the target can only be reached by writing low-value or flaky tests, stop and report the honest coverage ceiling plus the modules that need refactoring before better tests are possible.
```

Recommended interpretation of “meaningful coverage” for Jovie:

| Area | Target | Test style |
|---|---:|---|
| Core business logic, pricing, ranking, permissions, auth/session, payments | 85–90%+ | Unit + integration |
| API/client/server boundary logic | 80–90% | Contract/integration tests with mocked services |
| Data transforms, validators, utilities | 90%+ | Fast unit tests |
| Critical user flows | Cover key happy/error paths | Focused integration or deterministic E2E |
| Pure UI presentation/layout | No numeric target | Test only stable user-visible behavior |
| Generated files, config, types, wrappers | Exclude or justify | Avoid fake coverage |

Use the first `/goal` unless you want Codex to push harder. The key clause is: **“If 80% overall coverage is achievable only through low-value tests, stop before adding those tests and propose a more meaningful target.”** That prevents the test suite from turning into coverage theater.

---

## User

should we use this?

---

## Assistant

I’ll compare the active OpenAI Cookbook agent-improvement pattern against Jovie’s test-coverage goal, separating useful coverage-gate ideas from heavier trace/eval loops that may be overkill.

---

## User

i mean like for jovie agent itself.

---

## Assistant

I’ll treat this as a Jovie agent quality loop, where evals, traces, prompt/tool behavior, regressions, and Codex handoffs matter more than ordinary app coverage.

---

## Assistant

Mr. White, **yes — for Jovie’s agent itself, use this pattern.**

Jovie’s public positioning is an “AI artist manager” that watches a catalog, surfaces next actions, and helps ship assets like presaves, fan paths, and playlist pitches. That is exactly the kind of agent behavior that benefits from traces, human feedback, evals, and Codex-driven harness improvements. citeturn187484view0

The OpenAI cookbook pattern is designed for this: start with real traces, add human/model feedback, convert that into reusable evals, then hand the evidence to Codex to improve the agent harness. The page defines the “harness” as the full contract around the model: instructions, tools, routing, output requirements, and validation checks. citeturn722337view0

## Recommendation

Use a **lean version** of the loop, not the full demo notebook on day one.

For Jovie, the loop should test whether the agent:

| Area | What to evaluate |
|---|---|
| Catalog understanding | Correctly reads releases, artists, assets, dates, metadata, links, DSP status |
| Recommendation quality | Surfaces the highest-leverage next action, not generic advice |
| Grounding | Cites or references actual Jovie data instead of inventing facts |
| Tool use | Calls the right internal tools and handles failures cleanly |
| Release workflow | Handles presave, fan path, playlist pitch, asset readiness, launch timing |
| Prioritization | Correctly ranks urgent vs nice-to-have actions |
| User trust | Says “unknown” or asks for missing inputs when needed |
| Performance | Keeps latency/cost acceptable for product use |

## Jovie-specific Codex `/goal`

Use this:

```text
/goal Build a lean agent improvement loop for the Jovie AI artist manager. The loop should use real or representative Jovie agent traces, human feedback, model-assisted critique, and reusable evals to improve the agent harness: instructions, tools, routing, output requirements, and validation checks.

First inspect the repo to identify how the Jovie agent is implemented, how traces/logs are captured, what tools it can call, what data sources it uses, and what test/eval infrastructure already exists. Then design and implement a minimal production-useful eval loop rather than copying the demo notebook blindly.

Create a v0 eval set covering Jovie’s highest-risk agent behaviors:
- catalog/release understanding
- next-best-action recommendations
- presave readiness
- fan path setup guidance
- playlist pitch guidance
- missing asset detection
- metadata/date/status reasoning
- tool-call correctness
- refusal to fabricate unavailable data
- graceful handling of incomplete or conflicting inputs

Use real anonymized traces where available; otherwise create realistic fixtures from existing Jovie data models and agent workflows. Each eval case should include the user/task input, relevant mocked data/tool responses, expected behavior, unacceptable behavior, and a scoring rubric.

Prioritize high-signal evals over volume. Do not create shallow tests that only check wording. Evals should catch meaningful failures: hallucinated release facts, wrong launch timing, bad prioritization, incorrect tool calls, skipped missing assets, unsupported playlist-pitch claims, generic advice, or actions that conflict with actual catalog state.

Add a repeatable eval command that can run locally and in CI. The eval output should report pass/fail, category scores, failing examples, regression diffs, latency, and cost where available. The loop should produce a Codex handoff/report listing the top agent harness changes to make next, ranked by severity and evidence.

Completion requires:
- a runnable eval suite for the Jovie agent
- at least one trace/fixture format for agent runs
- a rubric for judging agent quality
- CI/local command documentation
- baseline eval results
- a short improvement report with top failures and recommended harness changes
- no production behavior changes unless validated by evals

Between iterations, report: evals added, traces used, failures found, harness changes made, score deltas, latency/cost deltas, and remaining risks. If real traces are unavailable, stop with a fixture-based v0 and clearly list what production trace access is needed to make the loop stronger.
```

## Start with this v0 eval suite

Create 20–40 cases first. Suggested buckets:

| Bucket | Example eval |
|---|---|
| Release readiness | “Is this release ready to ship?” Agent must detect missing artwork, presave URL, pitch copy, or DSP date. |
| Next best action | Given a release 10 days out with missing fan path, agent recommends fan path before lower-value polish. |
| Playlist pitch | Agent drafts pitch only from available metadata and avoids fake claims. |
| Catalog watch | Agent notices a stale release page, missing links, or incomplete assets. |
| Conflicting data | Agent handles mismatch between release date in metadata and campaign plan. |
| Missing data | Agent says what is missing instead of inventing. |
| Tool failure | Agent handles failed catalog lookup or asset fetch without pretending success. |
| Personalization | Agent gives artist-specific advice based on genre/release context, not generic marketing text. |
| Safety/legal-ish | Agent avoids unsupported claims around label/distributor relationships, rights, or guarantees. |
| Regression cases | Every bad real output becomes a permanent eval. |

## Scoring rubric

Use a weighted rubric like this:

| Dimension | Weight |
|---|---:|
| Grounded in Jovie data | 30% |
| Correct next action / prioritization | 25% |
| Tool-call correctness | 20% |
| Completeness of workflow guidance | 10% |
| Clear uncertainty handling | 10% |
| Tone / usefulness | 5% |

Hard fail conditions:

- Fabricates catalog, release, distributor, playlist, fan, or campaign facts.
- Recommends an action contradicted by Jovie’s actual data.
- Claims a workflow is complete when required assets or links are missing.
- Ignores tool errors.
- Gives generic artist-marketing advice when specific Jovie data was available.

## How this fits with Codex Goals

Codex Goals are well-suited here because this task has a durable objective, concrete evidence surfaces, and an iterative path. OpenAI’s Goal guidance says strong Goals define the outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition. citeturn138751view0

So the structure should be:

```text
traces → feedback → evals → failing cases → Codex handoff → harness changes → rerun evals
```

That is a better fit for Jovie’s agent than simple unit coverage. Unit tests prove code paths work. Agent evals prove the product brain behaves well.
