/**
 * Refusal-swallow sites in the job operations and the remediation run (triage rows 12 and 13): a catch around a raw-SQL
 * queue read must not turn the Rust engine's `engine_capability_missing` refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the no-worker notice and the manual-only skip list read the queue through typed members, so an engine whose
 *    `executeRaw` refuses (a Rust brain) tells the user what PGLite tells them.
 *  - Regression: the raw reads were refused and dropped, so `submit_job` on a Rust brain never said "no worker is running"
 *    and a remediation run never named the manual-only jobs an earlier run had queued.
 *  - Why existing coverage misses it: the ops and remediation tests run PGLite, where the raw reads succeed.
 *  - Seam: a PGLite engine wrapped so `executeRaw` throws the real refusal (test/helpers/refusing-engine.ts) and, where the
 *    case is reachable, a real Rust brain (needs the addon; skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { refusingEngine } from './helpers/refusing-engine.ts';
import { runRemediation } from '../src/core/remediation/index.ts';
import { makeRemediationStep } from '../src/core/remediation-step.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

let pg: PGLiteEngine;
let home: string;
beforeAll(async () => {
  pg = new PGLiteEngine();
  await pg.connect({});
  await pg.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-refusal-ops-'));
}, 120_000);
afterAll(async () => {
  await pg.disconnect();
  rmSync(home, { recursive: true, force: true });
});

const rustRun = existsSync(rustArmAddonPath()) || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' ? test : test.skip;

/** The notice codes `submit_job` emits for one queued job on `engine`, with no worker registered anywhere. */
async function submitNoticeCodes(engine: BrainEngine): Promise<string[]> {
  const notices: Notice[] = [];
  const ctx = { engine, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as OperationContext;
  await withEnv({ GBRAIN_HOME: home }, () => operationsByName.submit_job!.handler(ctx, { name: 'lint', data: {} }));
  return notices.map((n) => n.code);
}

describe('job operation refusal-swallow sites', () => {
  test('S12 emitNoWorkerNotice: the waiting count comes from the typed countJobsByStatus, so an engine whose raw SQL refuses still says no worker is running', async () => {
    expect(await submitNoticeCodes(pg)).toContain('no_worker');
    expect(await submitNoticeCodes(refusingEngine(pg))).toContain('no_worker');
  });

  rustRun('S12 on a Rust brain: submit_job says no worker is running', async () => {
    const { engine, dir } = await openRustBrain();
    try {
      expect(await submitNoticeCodes(engine as unknown as BrainEngine)).toContain('no_worker');
    } finally {
      await engine.disconnect();
      removeBrainDir(dir);
    }
  });

  test('S13 manualOnlySkips: a manual-only job an earlier run queued is found through the typed listJobs on an engine whose raw SQL refuses', async () => {
    const queued = await new MinionQueue(pg).add('unify-types', { target_pack: 'example-pack', apply: true },
      { queue: 'default', idempotency_key: 'refusal-swallow-13' }, { allowProtectedSubmit: true });
    const pack = makeRemediationStep({ id: 'onboard.pack_upgrade_example', job: 'unify-types', params: { target_pack: 'example-pack', apply: true },
      severity: 'medium', est_seconds: 5, est_usd_cost: 0, rationale: 'synthetic onboard-check extra', protected: true });
    const skipped = async (engine: BrainEngine) => {
      const write = process.stderr.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        const result = await runRemediation(engine, { targetScore: 0, inlineJobs: true, extraRemediations: [pack] });
        return result.manual_only_skipped?.[0]?.queued_jobs;
      } finally { process.stderr.write = write; }
    };
    expect(await skipped(pg)).toEqual([{ id: queued.id, status: 'waiting' }]);
    expect(await skipped(refusingEngine(pg))).toEqual([{ id: queued.id, status: 'waiting' }]);
    // A capability refusal from the typed read surfaces; any other read error still reports the skip, without the queued-job note.
    await expect(skipped(refusingEngine(pg, { needle: null, members: ['listUnfinishedJobsByName'] }))).rejects.toMatchObject({ code: 'engine_capability_missing' });
    expect(await skipped(refusingEngine(pg, { needle: null, members: ['listUnfinishedJobsByName'], error: () => new Error('connection reset') }))).toBeUndefined();
  });

  test('S13 over a page: 1,001 queued jobs of one manual-only name are all reported, by id, from one read', async () => {
    await pg.executeRaw('DELETE FROM minion_jobs');
    const queue = new MinionQueue(pg);
    const ids: number[] = [];
    for (let i = 0; i < 1001; i++) {
      ids.push((await queue.add('unify-types', { target_pack: 'example-pack', apply: true }, { queue: 'default', idempotency_key: `refusal-swallow-many-${i}` }, { allowProtectedSubmit: true })).id);
    }
    const pack = makeRemediationStep({ id: 'onboard.pack_upgrade_example', job: 'unify-types', params: { target_pack: 'example-pack', apply: true },
      severity: 'medium', est_seconds: 5, est_usd_cost: 0, rationale: 'synthetic onboard-check extra', protected: true });
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const result = await runRemediation(pg, { targetScore: 0, inlineJobs: true, extraRemediations: [pack] });
      const queued = result.manual_only_skipped![0]!.queued_jobs!;
      expect(queued).toHaveLength(1001);
      expect(queued.map((q) => q.id)).toEqual(ids);
    } finally { process.stderr.write = write; await pg.executeRaw('DELETE FROM minion_jobs'); }
  }, 60_000);
});
