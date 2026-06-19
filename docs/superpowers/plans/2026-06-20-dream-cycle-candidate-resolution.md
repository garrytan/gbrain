# Dream Cycle Candidate Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dream Cycle and memory-report treat hard-blocked canonical-target proposals as safe classification outcomes instead of generic unresolved exposed candidate debt.

**Architecture:** Add a shared candidate resolution classifier, then thread it through inbox debt, candidate signals, memory-report collection, and Dream Cycle maintenance counts. Keep canonical write authority unchanged.

**Tech Stack:** TypeScript, Bun test, SQLite/PGLite test engines, existing MBrain Memory Inbox services.

---

## File Map

- Create: `src/core/services/candidate-resolution-state-service.ts`
  - Classifies a candidate using handoff and canonical target proposal state.
- Modify: `src/core/services/inbox-lead-service.ts`
  - Uses the classifier for debt metrics and pressure reasons.
- Modify: `src/core/services/candidate-signal-service.ts`
  - Uses blocked proposal state for summaries and hints.
- Modify: `src/core/services/dream-cycle-maintenance-service.ts`
  - Counts hard-blocked proposal outcomes in maintenance output.
- Modify: `src/core/types/episode-capture.ts`
  - Adds optional candidate debt metrics for hard-blocked proposals.
- Modify: tests below.

## Task 1: Shared Resolution Classifier

**Files:**
- Create: `src/core/services/candidate-resolution-state-service.ts`
- Test: `test/candidate-resolution-state-service.test.ts`

- [x] **Step 1: Write the failing classifier tests**

```ts
import { describe, expect, test } from 'bun:test';
import { classifyCandidateResolutionState } from '../src/core/services/candidate-resolution-state-service.ts';

const baseCandidate = {
  id: 'candidate:1',
  status: 'captured',
  sensitivity: 'work',
  source_refs: ['source:1'],
  target_object_id: null,
} as any;

describe('candidate resolution state service', () => {
  test('classifies unstable-subject blocked proposals as hard blocked instead of unresolved', () => {
    const result = classifyCandidateResolutionState({
      candidate: baseCandidate,
      has_canonical_handoff: false,
      canonical_target_proposal: {
        id: 'proposal:1',
        status: 'blocked',
        status_reason: 'unstable_subject_identity',
      } as any,
    });

    expect(result.state).toBe('hard_blocked_by_proposal');
    expect(result.counts_as_unresolved_exposed).toBe(false);
    expect(result.pressure_reasons).not.toContain('unresolved_exposed_candidate');
  });

  test('keeps targetless candidates without proposals unresolved', () => {
    const result = classifyCandidateResolutionState({
      candidate: baseCandidate,
      has_canonical_handoff: false,
      canonical_target_proposal: null,
    });

    expect(result.state).toBe('actionable_unresolved');
    expect(result.counts_as_unresolved_exposed).toBe(true);
    expect(result.pressure_reasons).toContain('unresolved_exposed_candidate');
  });
});
```

- [x] **Step 2: Run the RED test**

Run: `bun test test/candidate-resolution-state-service.test.ts`

Expected: fail because `candidate-resolution-state-service.ts` does not exist.

- [x] **Step 3: Implement the classifier**

Create the classifier with no engine dependency. It accepts plain candidate and
proposal objects so report, signals, and tests can share it.

- [x] **Step 4: Run the classifier test**

Run: `bun test test/candidate-resolution-state-service.test.ts`

Expected: pass.

- [x] **Step 5: Commit**

```bash
git add src/core/services/candidate-resolution-state-service.ts test/candidate-resolution-state-service.test.ts
git commit -m "add candidate resolution classifier"
```

## Task 2: Proposal-Aware Debt Metrics

**Files:**
- Modify: `src/core/services/inbox-lead-service.ts`
- Modify: `src/core/types/episode-capture.ts`
- Test: `test/inbox-lead-service.test.ts`

- [x] **Step 1: Write failing debt metric tests**

Add a test showing a candidate linked to an unstable-subject blocked proposal
does not increment `unresolved_exposed_count`, while the metric records the hard
blocked count.

- [x] **Step 2: Run the RED test**

Run: `bun test test/inbox-lead-service.test.ts`

Expected: fail because candidate debt input does not accept proposal state and
does not track hard-blocked proposals.

- [x] **Step 3: Thread proposals into candidate debt**

Extend `CandidateDebtInput` with optional `canonical_target_proposals`. Use the
shared classifier in `computeCandidateDebtMetrics`.

- [x] **Step 4: Run the debt test**

Run: `bun test test/inbox-lead-service.test.ts`

Expected: pass.

- [x] **Step 5: Commit**

```bash
git add src/core/services/inbox-lead-service.ts src/core/types/episode-capture.ts test/inbox-lead-service.test.ts
git commit -m "make candidate debt proposal aware"
```

## Task 3: Report and Signal Integration

**Files:**
- Modify: `src/commands/memory-report.ts`
- Modify: `src/core/services/memory-review-report-service.ts`
- Modify: `src/core/services/candidate-signal-service.ts`
- Test: `test/memory-review-report-service.test.ts`
- Test: `test/candidate-signal-service.test.ts`

- [x] **Step 1: Write failing report and signal tests**

Add report coverage where only hard-blocked unstable-subject proposals remain.
Expected health is `ok`, `candidate_unresolved_exposed` is `0`, and
`candidate_hard_blocked_by_proposal` is nonzero.

Add signal coverage where a blocked proposal summary says the candidate has a
blocked canonical-target proposal and does not use `needs_canonical_target_proposal`.

- [x] **Step 2: Run the RED tests**

Run:

```bash
bun test test/memory-review-report-service.test.ts test/candidate-signal-service.test.ts
```

Expected: fail with old unresolved-exposed counts or old proposal hint text.

- [x] **Step 3: Pass proposal state to debt metrics and signals**

Pass collected canonical target proposals into `computeCandidateDebtMetrics`.
Update candidate-signal active proposal lookup to include blocked proposals and
use the classifier for hints and pressure reasons.

- [x] **Step 4: Run the report and signal tests**

Run:

```bash
bun test test/memory-review-report-service.test.ts test/candidate-signal-service.test.ts
```

Expected: pass.

- [x] **Step 5: Commit**

```bash
git add src/commands/memory-report.ts src/core/services/memory-review-report-service.ts src/core/services/candidate-signal-service.ts test/memory-review-report-service.test.ts test/candidate-signal-service.test.ts
git commit -m "report hard-blocked proposal state"
```

## Task 4: Dream Cycle Maintenance Counts

**Files:**
- Modify: `src/core/services/dream-cycle-maintenance-service.ts`
- Test: `test/canonical-target-proposal-dream.test.ts`

- [x] **Step 1: Write failing Dream Cycle test**

Add coverage for a targetless candidate that produces an
`unstable_subject_identity` blocked proposal. Expected:

- `canonical_target_proposals_blocked` increments,
- a new `canonical_target_proposals_hard_blocked` count increments,
- the candidate is not promoted, bound, or page-written.

- [x] **Step 2: Run the RED test**

Run: `bun test test/canonical-target-proposal-dream.test.ts`

Expected: fail because the new hard-blocked count does not exist.

- [x] **Step 3: Add Dream Cycle hard-blocked counts**

Count blocked proposals whose status reason is hard blocked. Keep existing
blocked count unchanged for compatibility.

- [x] **Step 4: Run the Dream Cycle test**

Run: `bun test test/canonical-target-proposal-dream.test.ts`

Expected: pass.

- [x] **Step 5: Commit**

```bash
git add src/core/services/dream-cycle-maintenance-service.ts test/canonical-target-proposal-dream.test.ts
git commit -m "count hard-blocked dream proposals"
```

## Task 5: Final Verification

**Files:**
- All modified files.

- [x] **Step 1: Run focused tests**

Run:

```bash
bun test test/candidate-resolution-state-service.test.ts test/canonical-target-proposal-dream.test.ts test/candidate-signal-service.test.ts test/inbox-lead-service.test.ts test/memory-review-report-service.test.ts
```

Expected: all tests pass.

- [x] **Step 2: Run broader checks**

Run:

```bash
bun run typecheck
bun run test:episode-capture
bun run test:dream-guardrails
```

Expected: all checks pass.

- [x] **Step 3: Run live smoke against current local DB**

Run:

```bash
bun run src/cli.ts memory-report --json --limit 20
```

Expected: hard-blocked unstable-subject proposal candidates no longer produce a
generic `candidate_unresolved_exposed` warning.

- [x] **Step 4: Commit remaining changes**

```bash
git status --short
git commit -m "verify dream candidate resolution"
```

Only commit if verification changed tracked files.
