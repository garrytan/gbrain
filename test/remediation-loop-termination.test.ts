// test/remediation-loop-termination.test.ts
//
// Regression test for the `onboard --auto` infinite loop (fix in
// src/core/remediation/run.ts). A step whose job reaches a terminal
// NON-completed state (failed / dead / cancelled) is recorded in the loop's
// `abortedIds`. Before the fix, the per-step recheck (D7) recomputed the plan
// from fresh health and re-introduced that step verbatim; because idempotency
// keys are content-stable (same job+params → same key) and the job already
// exhausted `max_attempts`, queue.add returned the SAME terminal row every
// iteration and the loop spun until `maxJobs` (default Infinity). A cancelled
// extract job under `onboard --auto` reproduced exactly this.
//
// `selectActiveRecs` is the extracted, pure progress-decision: it excludes
// aborted ids from the recomputed set so loop progress is monotonic. Full
// orchestrator e2e (real Minion handlers firing) stays deferred upstream until
// the per-handler stub seam lands (see test/e2e/onboard-full-flow.test.ts) —
// this pins the termination invariant at the decision boundary.

import { describe, expect, test } from 'bun:test';
import {
  makeRemediationStep,
  selectActiveRecs,
  type RemediationStatus,
} from '../src/core/remediation-step.ts';

function step(id: string, status: RemediationStatus = 'remediable') {
  return makeRemediationStep({
    id,
    job: id,
    params: {},
    severity: 'medium',
    est_seconds: 10,
    rationale: `step ${id}`,
    status,
  });
}

describe('selectActiveRecs — remediation loop termination', () => {
  test('empty abortedIds: returns all remediable steps unchanged', () => {
    const recs = [step('extract.all'), step('embed.stale')];
    const out = selectActiveRecs(recs, new Set());
    expect(out.map((r) => r.id)).toEqual(['extract.all', 'embed.stale']);
  });

  test('drops non-remediable steps (human_only / blocked)', () => {
    const recs = [step('extract.all'), step('manual.only', 'human_only'), step('blk', 'blocked')];
    const out = selectActiveRecs(recs, new Set());
    expect(out.map((r) => r.id)).toEqual(['extract.all']);
  });

  test('excludes ids already in abortedIds (the core fix)', () => {
    const recs = [step('extract.all'), step('embed.stale')];
    const out = selectActiveRecs(recs, new Set(['extract.all']));
    expect(out.map((r) => r.id)).toEqual(['embed.stale']);
  });

  test('infinite-loop scenario: a re-emitted aborted step is filtered out so recs drains', () => {
    // Models the D7 recompute cycle. The recommendation keeps re-firing because
    // its metric never improved (the job was cancelled), but once the step is in
    // abortedIds it is excluded — so the active set strictly shrinks and the
    // loop's `recs.length === 0` break fires instead of spinning forever.
    const aborted = new Set<string>();
    let recs = [step('extract.all')];

    // iteration 1: step is dispatched, its job is cancelled → recorded aborted.
    expect(selectActiveRecs(recs, aborted).map((r) => r.id)).toEqual(['extract.all']);
    aborted.add('extract.all');

    // recompute re-emits the SAME recommendation (health unchanged)…
    recs = [step('extract.all')];
    // …but selectActiveRecs now excludes it → empty → the loop terminates.
    expect(selectActiveRecs(recs, aborted)).toEqual([]);
  });

  test('monotonic: once aborted, the id stays excluded across repeated rechecks', () => {
    const aborted = new Set(['a']);
    for (let i = 0; i < 5; i++) {
      const out = selectActiveRecs([step('a'), step('b')], aborted);
      expect(out.map((r) => r.id)).toEqual(['b']);
    }
  });

  test('a NON-aborted sibling still runs while the aborted step is skipped', () => {
    // Cascade sanity: aborting one step must not starve unrelated remediable
    // steps — only the failed id is excluded.
    const recs = [step('extract.all'), step('embed.stale'), step('backlinks.fix')];
    const out = selectActiveRecs(recs, new Set(['embed.stale']));
    expect(out.map((r) => r.id)).toEqual(['extract.all', 'backlinks.fix']);
  });
});
