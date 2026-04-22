# Phase 3 Retrieval Route Trace Design

## Goal

Close the retrieval protocol loop by letting `retrieval-route` persist a
task-scoped Retrieval Trace when the caller explicitly requests durable
explainability.

## Scope

- extend the published selector surface with `persist_trace`
- only task-scoped traces
- record both successful route selection and explicit no-match degradation
- additive result field returning the written trace

## Contract

- `persist_trace=true` requires `task_id`
- task scope is derived from the task thread
- stored trace captures:
  - selected route steps
  - explicit source refs when available
  - verification strings derived from selector output
  - outcome string for selected or unavailable route

## Non-Goals

- implicit trace writes
- non-task trace persistence
- promotion or inbox writes
- cross-scope routing

## Acceptance

- service persists a trace for successful broad synthesis with task context
- service persists a degraded trace for no-match precision lookup with task context
- operation exposes the same behavior
- benchmark reports `retrieval_route_trace` and `retrieval_route_trace_correctness`
