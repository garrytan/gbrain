// test/remediation-run-protected.serial.test.ts
//
// runRemediation's protected-job gate.
//
// The runner computes its OWN base recommendations via computeRecommendations,
// so a caller that filters its `extraRemediations` has NOT filtered the plan.
// That became load-bearing when 'sync' joined PROTECTED_JOB_NAMES: `sync.repo`
// is a base recommendation, so an untrusted caller (MCP run_onboard without
// the run_protected_onboard scope) would otherwise reach a protected
// submission through a list it never supplied.
//
// Two directions are pinned here:
//   - allowProtected omitted → protected steps dropped and reported, never
//     submitted (fail-closed).
//   - allowProtected: true   → protected steps run, and queue.add receives
//     the allowProtectedSubmit flag MinionQueue.add requires.
//
// SERIAL: mock.module (queue + wait-for-completion stubs) + GBRAIN_HOME env
// mutation so checkpoint files land in a tmpdir, not ~/.gbrain.

import { describe, expect, test, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeRemediationStep } from '../src/core/remediation-step.ts';

let nextJobId = 1;
let submittedJobs: Array<{ name: string; trusted: unknown }> = [];
mock.module('../src/core/minions/queue.ts', () => ({
  MinionQueue: class {
    async add(name: string, _data?: unknown, _opts?: unknown, trusted?: unknown) {
      submittedJobs.push({ name, trusted });
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
  home = mkdtempSync(join(tmpdir(), 'gbrain-remprot-'));
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

beforeEach(() => {
  submittedJobs = [];
});

// A protected step and a plain one, so every assertion can show that the
// gate is selective rather than just refusing everything.
function step(id: string, job: string) {
  return makeRemediationStep({
    id,
    job,
    params: {},
    severity: 'medium',
    est_seconds: 5,
    est_usd_cost: 0,
    rationale: 'synthetic step',
    status: 'remediable',
  });
}

describe('runRemediation — protected job gate', () => {
  test('without allowProtected: protected step is dropped, reported, and never submitted', async () => {
    const { runRemediation } = await import('../src/core/remediation/run.ts');
    const result = await runRemediation(engine, {
      targetScore: 1,
      maxJobs: 5,
      extraRemediations: [step('t.sync', 'sync'), step('t.plain', 'extract-ner')],
    });

    const submittedNames = submittedJobs.map((j) => j.name);
    expect(submittedNames).toContain('extract-ner');
    expect(submittedNames).not.toContain('sync');

    expect(result.skipped_protected).toBeDefined();
    expect(result.skipped_protected!.map((s) => s.job)).toContain('sync');
    expect(result.skipped_protected!.find((s) => s.job === 'sync')!.id).toBe('t.sync');
  });

  test('the skipped report does not accumulate duplicates across the D7 recheck', async () => {
    // The mid-run recheck re-derives the plan every iteration. A naive filter
    // would append the same dropped step once per loop.
    const { runRemediation } = await import('../src/core/remediation/run.ts');
    const result = await runRemediation(engine, {
      targetScore: 1,
      maxJobs: 5,
      extraRemediations: [
        step('t.sync', 'sync'),
        step('t.a', 'extract-ner'),
        step('t.b', 'extract-timeline-from-meetings'),
      ],
    });
    expect(result.skipped_protected!.filter((s) => s.id === 't.sync').length).toBe(1);
  });

  test('with allowProtected: protected step runs and carries allowProtectedSubmit', async () => {
    const { runRemediation } = await import('../src/core/remediation/run.ts');
    const result = await runRemediation(engine, {
      targetScore: 1,
      maxJobs: 5,
      allowProtected: true,
      extraRemediations: [step('t.sync', 'sync')],
    });

    expect(result.skipped_protected).toEqual([]);
    const syncSubmit = submittedJobs.find((j) => j.name === 'sync');
    expect(syncSubmit).toBeDefined();
    // MinionQueue.add throws on a protected name unless this exact flag is
    // set, so asserting the payload is asserting the submission works.
    expect(syncSubmit!.trusted).toEqual({ allowProtectedSubmit: true });
  });

  test('non-protected steps never get the trusted flag, even under allowProtected', async () => {
    const { runRemediation } = await import('../src/core/remediation/run.ts');
    await runRemediation(engine, {
      targetScore: 1,
      maxJobs: 5,
      allowProtected: true,
      extraRemediations: [step('t.plain', 'extract-ner')],
    });
    const plain = submittedJobs.find((j) => j.name === 'extract-ner');
    expect(plain!.trusted).toBeUndefined();
  });
});
