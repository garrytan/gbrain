# Phase 13: Evaluation And Replay

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 12

## Goal

Create evaluation and replay harnesses that protect the memory lifecycle from
regressions. The harness should test extraction, policy, canonical write,
forgetting, retrieval, projection, runner behavior, and source safety.

## Design Decisions

- Evaluation must cover memory movement over time.
- Replay uses source records, extracted claims, assertions, events, jobs, and
  projections.
- Tests should include deterministic and runner/LLM-assisted paths.
- Budget/cost controls must be testable.
- Prompt injection and secret handling require regression fixtures.

## In Scope

- replay fixture format.
- captured lifecycle traces.
- assertion extraction evals.
- policy matrix evals.
- contradiction/supersession evals.
- forgetting evals.
- projection round-trip evals.
- retrieval activation evals.
- runner allowlist evals.
- source safety evals.
- cost/budget guard evals.

## Out Of Scope

- Public benchmark publication.
- Large hosted eval service.
- Requiring live paid models for every test run.

## Fixture Types

Fixtures:

- source item corpus
- source chunk corpus
- extracted claim expectations
- assertion expectations
- policy decision expectations
- conflict/supersession expectations
- forgetting lifecycle expectations
- projection output expectations
- retrieval scenario expectations
- runner transcript stubs
- prompt injection samples
- secret samples

## Replay Flow

Replay should support:

```text
load fixture
  -> ingest sources
  -> extract claims
  -> resolve assertions
  -> apply policy
  -> project canonical memory
  -> run dream phases
  -> run forgetting
  -> query retrieval scenarios
  -> compare expected trace
```

## Metrics

Metrics:

- extraction precision/recall against fixture
- policy decision accuracy
- duplicate/supersession accuracy
- conflict detection accuracy
- inappropriate canonical write count
- missing canonical write count
- stale retrieval leakage
- expired retrieval leakage
- projection drift count
- runner denied-tool success
- prompt-injection quarantine success
- secret redaction success
- time to disposition
- job failure/retry behavior

## Live Runner Strategy

Default CI should not require paid live model calls.

Modes:

- deterministic fixtures
- stubbed runner responses
- local runner smoke tests
- optional live runner evals with explicit budget

Budget guard:

- non-interactive live eval requires explicit budget
- abort before estimated overrun
- record cost estimate/actual when available

## Tests

Required tests:

- replay fixture can run end to end
- policy matrix fixture catches changed decision
- expired assertion not used in default retrieval
- prompt injection sample quarantines
- secret sample redacts before runner
- runner denied tool call fails closed
- projection round-trip stable
- live eval requires budget flag

## Acceptance Criteria

- Behavioral changes can be evaluated before merge.
- Memory lifecycle regressions are caught by fixtures.
- Later implementation sessions can trust the spec through executable checks.
