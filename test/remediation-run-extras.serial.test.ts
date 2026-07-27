// test/remediation-run-extras.serial.test.ts
// Regression for PR #2161 takeover: `gbrain onboard --apply --auto` dropped
// onboard-check extraRemediations. Two distinct halves of the bug:
//   1. runRemediation built the pre-flight plan + initial recs WITHOUT the
//      extras, so an extras-only plan reported "Nothing to do".
//   2. The D7 mid-run recheck rebuilt recs WITHOUT the extras after every
//      completed step, so with 2+ plannable steps all remaining extras were
//      dropped after step 1. The recheck must also filter out extras this
//      run already processed — extras carry static status:'remediable', so
//      unfiltered threading would resubmit completed extras forever.
//
// SERIAL: mock.module (queue + wait-for-completion stubs, R2) + GBRAIN_HOME
// env mutation so checkpoint files land in a tmpdir, not ~/.gbrain.

import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeRemediationStep } from '../src/core/remediation-step.ts';

// Stub the Minion queue: every submitted job is immediately 'completed'.
// runRemediation only calls queue.add + waitForCompletion(queue, id).
let nextJobId = 1;
const submittedJobs: Array<{ name: string }> = [];
mock.module('../src/core/minions/queue.ts', () => ({
  MinionQueue: class {
    async add(name: string) {
      submittedJobs.push({ name });
      return { id: nextJobId++, status: 'completed' };
    }
  },
}));
mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  waitForCompletion: async () => ({ status: 'completed' }),
}));

let engine: PGLiteEngine;
let home: string;
const prevHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-remextras-'));
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function extra(id: string, job: string) {
  return makeRemediationStep({
    id,
    job,
    params: {},
    severity: 'medium',
    est_seconds: 5,
    est_usd_cost: 0,
    rationale: 'synthetic onboard-check extra',
    status: 'remediable',
  });
}

describe('runRemediation extraRemediations threading', () => {
  test('extras-only plan runs BOTH extras and terminates (no Nothing-to-do, no resubmit loop)', async () => {
    // Empty PGLite brain → zero health-derived recommendations. Without the
    // fix, half 1 makes this run return submitted: [] via onNothingToDo.
    // With only half 1 (the original PR #2161 diff), the mid-run recheck
    // drops the second extra after step 1 — submitted has 1 entry, not 2.
    const { runRemediation } = await import('../src/core/remediation/run.ts');
    let nothingToDo = false;
    const result = await runRemediation(
      engine,
      {
        targetScore: 1,
        extraRemediations: [
          extra('onboard.extract_ner', 'extract-ner'),
          extra('onboard.extract_timeline', 'extract-timeline-from-meetings'),
        ],
        // Safety bound: an unfiltered recheck would resubmit completed
        // extras forever; maxJobs turns that regression into a fast fail
        // (extra count > 1 below) instead of a hung test.
        maxJobs: 5,
      },
      { onNothingToDo: () => { nothingToDo = true; } },
    );

    expect(nothingToDo).toBe(false);
    const ids = result.submitted.map((s) => s.id);
    expect(ids).toContain('onboard.extract_ner');
    expect(ids).toContain('onboard.extract_timeline');
    // Each extra ran exactly once — the recheck must not re-plan extras the
    // run already processed.
    expect(ids.filter((i) => i === 'onboard.extract_ner').length).toBe(1);
    expect(ids.filter((i) => i === 'onboard.extract_timeline').length).toBe(1);
    expect(result.submitted.every((s) => s.status === 'completed')).toBe(true);
    expect(submittedJobs.map((j) => j.name).sort()).toEqual([
      'extract-ner',
      'extract-timeline-from-meetings',
    ]);
  });
});
