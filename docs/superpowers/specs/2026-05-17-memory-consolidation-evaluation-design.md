# Memory Consolidation Evaluation for MBrain

## Purpose

This design turns the useful parts of `Nested Learning: The Illusion of Deep
Learning Architectures` into an `mbrain`-appropriate evaluation and governance
improvement.

The paper is about trainable neural learning modules. `mbrain` is not. The
transferable idea is narrower: durable memory systems need multiple update
cadences, explicit consolidation boundaries, and tests that prove information
does not get lost, mis-scoped, or laundered into authoritative memory while it
moves between layers.

For `mbrain`, this means improving how the system measures and audits the path:

```text
retrieval trace / task event / source signal
  -> Memory Candidate
  -> review, rejection, promotion, supersession, or handoff
  -> canonical compiled truth or durable operational state
  -> derived refresh and future retrieval
```

## Problem

`mbrain` already has the right memory boundaries:

- canonical Markdown and DB-backed operational state
- `retrieve_context` as an agent probe
- `read_context` as the factual evidence boundary
- Memory Inbox candidates for inferred or uncertain claims
- promotion, rejection, supersession, canonical handoff, and redaction flows
- context maps and atlases as derived orientation, not truth
- task memory for resume, attempts, decisions, and working sets
- brain-loop audit and phase benchmarks

The remaining risk is not missing primitives. The risk is weak visibility into
how well memory moves between primitives over time.

Examples:

- A candidate can be repeatedly surfaced by `candidate_signals` without being
  promoted, rejected, superseded, or handed off.
- A promoted candidate can remain pending canonical consolidation for too long.
- A compiled-truth update can accidentally drop the source boundary or qualifier
  that made the original claim safe.
- A newer candidate can supersede an older one, but default retrieval can still
  expose stale signals if the lifecycle is not tested end to end.
- A large working set can be summarized into a resume view that loses the failed
  attempt or verification warning that mattered most.

These are `mbrain`'s version of memory-consolidation and forgetting failures.

## Goals

1. Add a consolidation-audit design that treats candidate promotion and compiled
   truth updates as lossy transformations that must preserve evidence.
2. Add sequential-retention evaluation so old, rejected, promoted, and superseded
   memory keeps the correct authority after newer memory arrives.
3. Add lifecycle metrics for candidate exposure, disposition, handoff, and stale
   unresolved signals.
4. Add compression-fidelity evaluation for task resume and working-set summaries.
5. Add deterministic surprise, drift, and persistence-pressure metrics only as
   review-priority signals, never as truth authority.
6. Document update cadences for major memory lanes without changing retrieval
   order from intent and scope.

## Non-Goals

- Do not implement Hope, Continuum Memory System neural blocks, self-modifying
  Titans, DGD, M3, Newton-Schulz, or optimizer machinery.
- Do not add trainable hidden memory to `mbrain`.
- Do not replace Markdown, canonical DB state, or Source Records with associative
  memory, vector search, or graph state.
- Do not make short-term, long-term, cache, or update frequency the primary
  retrieval order. Retrieval remains intent- and scope-driven.
- Do not auto-promote candidates because they are surprising, frequent, fresh, or
  high-scoring.
- Do not let context map edges, candidate signals, or retrieval chunks become
  answer-grounding evidence without canonical support.
- Do not weaken local/offline behavior, backend parity, provenance, scope gates,
  or existing Memory Inbox governance.

## Design Principles

1. **Consolidation is a lossy transform.** Every path from trace or candidate to
   canonical memory must prove that evidence, scope, and qualifiers survived.
2. **Frequency is metadata, not authority.** Update cadence can guide freshness
   and review urgency, but cannot outrank canonical evidence.
3. **Exposure should lead to disposition.** If a candidate is repeatedly useful
   enough to show to agents, the system should measure whether it eventually gets
   reviewed, rejected, superseded, or handed off.
4. **Forgetting has two meanings.** Default retrieval should forget stale or
   superseded candidates, but audit retrieval must preserve the history.
5. **Surprise is a triage signal.** Contradiction, recurrence, stale drift, and
   unexpected task failure should raise review priority, not truth authority.
6. **Compression must preserve blockers.** Resume projections may be compact, but
   they must preserve the next action, failed-path warning, current blocker, and
   verification warning that determine safe continuation.

## Accepted Ideas

### P1: Consolidation Audit

The system should audit transitions where memory changes authority:

- trace or task event to Memory Candidate
- Memory Candidate to promoted candidate
- promoted candidate to canonical handoff
- handoff to curated Markdown or canonical operational state
- canonical change to derived refresh

For each transition, the implementation should preserve:

- source refs
- target object identity
- scope and sensitivity
- extraction kind
- expected target snapshot hash where a canonical target is patched
- interaction id or retrieval trace link when the transition came from an agentic
  retrieval flow
- whether the resulting claim is still candidate-only, historical evidence, or
  answer-grounding canonical state

Acceptance criteria:

1. Candidate-only evidence never appears as `answer_ground`.
2. Promoted or compiled claims on the acceptance workload have canonical
   provenance.
3. A failed consolidation audit reports the missing evidence boundary rather than
   silently passing.
4. Scope leakage, promotion bypass, and contradiction bypass remain zero.

### P1: Sequential Retention Evaluation

The system should include end-to-end scenarios that simulate memory over time.

Required scenario shape:

```text
create canonical page A
create candidate B targeting A
surface B through retrieve_context candidate_signals
promote B and record canonical handoff
create newer candidate C that supersedes B
supersede or reject the old path
verify default retrieval hides stale active signals
verify audit retrieval preserves historical status
verify read_context still grounds factual answers in canonical evidence
```

Acceptance criteria:

1. Default retrieval hides rejected and superseded candidates outside audit mode.
2. Audit mode can still explain the historical lifecycle.
3. Current canonical answers are grounded through `read_context`.
4. Supersession does not delete source history.
5. Newer memory does not make older valid task decisions disappear as history.

### P2: Candidate Exposure To Disposition Metrics

The brain-loop audit should measure whether visible candidates move toward a
disposition.

Suggested metrics:

| Metric | Meaning |
|---|---|
| `candidate_signal_exposure_count` | Number of candidate signals surfaced in retrieval traces or audit windows. |
| `signal_to_status_event_rate` | Share of exposed candidates that later get advanced, rejected, promoted, superseded, or handed off. |
| `median_time_to_disposition_ms` | Median time from candidate creation or first exposure to terminal or handoff status. |
| `stale_unresolved_signal_count` | Active candidates older than the audit review window that are still surfaced. The default window is 14 days when the audit caller does not provide one. |
| `promoted_without_handoff_count` | Promoted candidates that still need canonical handoff. |
| `handoff_without_canonical_update_count` | Handoffs with a known canonical target where no later canonical target update is linked. |

These metrics should be aggregate observability only. They should not mutate
candidate state.

### P2: Working-Set Compression Fidelity

The Phase 1 operational-memory benchmark should include a large working-set
workload that proves compact resume output preserves safety-critical details.

The workload should seed:

- current goal and next action
- multiple active files and symbols
- one current blocker
- at least one failed attempt that should suppress repeated work
- one decision still in force
- one stale path, branch, or symbol that requires verification

The benchmark should pass only when the bounded resume projection preserves:

- the current next action
- the blocker
- the failed-path warning
- the decision in force
- the verification warning

This is a better `mbrain` translation of context compression than adopting any
neural compression mechanism.

### P2: Surprise, Drift, And Persistence Pressure

Candidate scoring and audit reports may add deterministic pressure signals.

Allowed inputs:

- contradiction with a canonical target
- repeated resurfacing in `candidate_signals`
- repeated recurrence after rejection
- stale promoted claim without handoff or canonical update
- task attempt that failed in a surprising way relative to a prior decision
- code-sensitive memory whose branch, path, symbol, or test anchor drifted

Allowed uses:

- raise review priority
- explain why an audit report highlights a candidate
- recommend `advance_to_review`, `consider_preflight`, `revalidate_stale_claim`,
  `supersede_with_newer_candidate`, or `reject_missing_provenance`

Forbidden uses:

- changing `activation` from `candidate_only` to `answer_ground`
- auto-promoting canonical truth
- overriding scope or sensitivity policy
- suppressing canonical evidence

### P2: Update Cadence Matrix

The design docs should make major memory lanes explicit:

| Lane | Update Cadence | Authority | Staleness Rule | Promotion Or Refresh Path |
|---|---|---|---|---|
| Session context | Immediate, ephemeral | Current conversation only | Expires with session context | Durable writeback routes to candidate, task, or canonical write. |
| Working Set | Fast, task-scoped | Canonical operational resume state | Stale when branch, path, symbol, test, or blocker changes | Refresh working set and record attempts or decisions. |
| Retrieval Trace | Per meaningful memory interaction | Canonical audit record | Historical, not current truth | May feed Memory Candidate creation. |
| Memory Candidate | Fast capture, slower review | Canonical governance state, not truth | Stale when unresolved beyond review window or contradicted | Reject, promote, supersede, redact, or hand off. |
| Candidate Signal | Per retrieval probe | Non-canonical exposure lane | Stale when underlying candidate status changes | Recompute from Memory Inbox state. |
| Context Map / Atlas | Background or source-change refresh | Derived orientation | Stale when source hash, extractor version, task, or code anchor changes | Rebuild or warn; never promote directly. |
| Compiled Truth | Slow, reviewed update | Canonical answer evidence | Stale when superseded or source evidence changes | Patch with provenance and target snapshot checks. |
| Profile Memory | Slow, scoped update | Canonical personal memory | Stale when unconfirmed, superseded, or scope changes | Write through personal scope preflight. |

This matrix is documentation and evaluation guidance. It must not replace
scenario routing or scope gates.

## Implementation Shape

The implementation should be split into measurable slices:

1. **Consolidation audit metrics**
   - Extend `brain-loop-audit-service` with candidate lifecycle and handoff
     aggregate fields.
   - Add tests that seed trace-linked candidate events and verify aggregate
     metrics.

2. **Sequential retention scenario**
   - Add a scenario test that exercises promoted, superseded, hidden, and audit
     visible candidate lifecycle in one flow.
   - Keep `read_context` as the only answer-grounding step.

3. **Candidate pressure scoring**
   - Add pressure fields to audit output first.
   - Only feed pressure into ranking when the implementation labels it as review
     priority and preserves `candidate_only` activation.

4. **Working-set compression benchmark**
   - Add one Phase 1 workload for compression fidelity.
   - Assert named critical fields survive bounded projection.

5. **Documentation update**
   - Add the update cadence matrix to the relevant redesign or evaluation docs.
   - Do not present the paper as the source of `mbrain` architecture; present it
     as an evaluation lens.

## Testing

Minimum tests:

- unit tests for new audit aggregate fields
- scenario test for sequential retention and supersession visibility
- candidate scoring or audit tests for pressure signals
- Phase 1 benchmark test for compression-fidelity workload shape
- existing `candidate_signals`, `retrieve_context`, `read_context`, Memory Inbox,
  and brain-loop audit tests must continue to pass

Verification commands for the implementation phase:

```bash
bun test test/brain-loop-audit-service.test.ts
bun test test/scenarios/s21-candidate-status-events-audit.test.ts
bun test test/retrieve-context-service.test.ts
bun test test/phase1-operational-memory.test.ts
bun test
```

Full pre-ship verification remains governed by `AGENTS.md`.

## Rejected Ideas

The following paper ideas are intentionally rejected for `mbrain`:

- neural Continuum Memory System blocks
- Hope architecture
- self-modifying Titans
- DGD, M3, Newton-Schulz, or optimizer internals
- trainable hidden memory inside the product
- short-term to long-term retrieval hierarchy
- surprise-based automatic canonical writes
- context-map edges as truth
- candidate recurrence as promotion authority

These ideas either target neural model internals or violate `mbrain`'s canonical,
derived, governance, scope, and local-first boundaries.

## Success Criteria

This design succeeds if the implementation makes `mbrain` better in the following
specific ways:

1. Agents can see whether candidate signals are being resolved rather than merely
   resurfaced.
2. Promotion and canonical handoff become easier to audit for evidence loss.
3. Superseded and rejected candidates disappear from default retrieval while
   remaining available for audit.
4. Resume views preserve critical continuation state under budget.
5. Review priority improves without granting non-canonical signals more authority.
6. The system gains stronger long-term memory evaluation without importing neural
   architecture complexity.
