# Phase 4 Scope Gate Design

## Goal

Add a deterministic preflight that decides whether the current published
retrieval stack may proceed under `work`, `personal`, `mixed`, or `unknown`
scope.

## Scope

- explicit preflight for published retrieval intents only:
  `task_resume`, `broad_synthesis`, `precision_lookup`
- deterministic scope resolution from explicit scope, task scope, repo/code
  signals, and personal-memory signals
- explicit `allow`, `deny`, or `defer` policy output
- standalone operation and benchmark; no selector integration yet

## Non-Goals

- personal/profile retrieval implementation
- mixed-scope retrieval implementation
- automatic selector enforcement inside existing retrieval routes

## Acceptance

- service resolves work, personal, mixed, and unknown cases deterministically
- operation exposes allow, deny, and defer disclosures
- benchmark reports `scope_gate` and `scope_gate_correctness`
- local acceptance reports `phase4_status: pass`
