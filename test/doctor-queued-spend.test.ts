/**
 * doctor `legacy_job_authority` reports queued paid jobs by spend basis and
 * flags spend-authorized rows that wait while workers run (an un-upgraded
 * worker is fenced off them); the post-upgrade banner names queued rows that
 * run under the legacy default cap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { jobSpendAuthorization } from '../src/core/minions/spend-authorization.ts';
import { registerWorker } from '../src/core/minions/worker-registry.ts';
import { legacyDefaultSpendBannerNote, legacyJobAuthorityEntry } from '../src/commands/doctor/checks/legacy-job-authority.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-queued-spend-'));
}, 60_000);
afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

const spend = () => jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 3, cap_source: 'user', via: 'max_usd' }, { command: 'enrich', of: 1 });
const run = () => withEnv({ GBRAIN_HOME: home }, () => legacyJobAuthorityEntry.run({ engine } as never)) as Promise<Array<Record<string, any>>>;

describe('queued spend in doctor', () => {
  test('counts queued paid jobs by basis; unpaid jobs are not counted', async () => {
    await queue.add('subagent', { prompt: 'x' }, { idempotency_key: 'book-mirror:a-book:ch-1' }, { allowProtectedSubmit: true });
    await queue.add('enrich', { sourceId: 'default' }, {}, { spendAuthorization: spend() });
    await queue.add('subagent', { prompt: 'y' }, {}, { allowProtectedSubmit: true });
    await queue.add('fixture', {});
    const [check] = await run();
    expect(check).toMatchObject({ status: 'ok', details: { queued_spend: { by_basis: { legacy_default: 1, authorized: 1, unrecorded: 1 }, long_waiting: 0 } } });
    expect(check!.message).toContain('Queued paid jobs by spend basis:');
    expect(await legacyDefaultSpendBannerNote(engine)).toContain('1 queued paid job(s)');
  });

  test('a spend-authorized row waiting over 10 minutes while a worker runs is flagged with a read-only fix', async () => {
    const job = await queue.add('enrich', { sourceId: 'default' }, {}, { spendAuthorization: spend() });
    await engine.executeRaw(`UPDATE minion_jobs SET updated_at = now() - interval '20 minutes' WHERE id = $1`, [job.id]);
    expect((await run())[0]!.status).toBe('ok');
    const unregister = await withEnv({ GBRAIN_HOME: home }, () =>
      registerWorker({ pid: process.pid, queue: 'default', nice_requested: null, nice_effective: null, started_at: Date.now() }));
    try {
      const [check] = await run();
      expect(check).toMatchObject({ status: 'warn', details: { queued_spend: { long_waiting_ids: [job.id] }, live_workers: 1 } });
      expect(check!.message).toContain('un-upgraded worker may be fenced off');
      expect(check!.fix).toMatchObject({ argv: ['gbrain', 'jobs', 'list', '--status', 'waiting', '--json'], consent: [] });
    } finally { await withEnv({ GBRAIN_HOME: home }, () => unregister()); }
  });

  test('an unreadable worker registry reports live_workers unknown instead of failing the check', async () => {
    const job = await queue.add('enrich', { sourceId: 'default' }, {}, { spendAuthorization: spend() });
    await engine.executeRaw(`UPDATE minion_jobs SET updated_at = now() - interval '20 minutes' WHERE id = $1`, [job.id]);
    const brokenHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-queued-spend-unreadable-'));
    try {
      mkdirSync(join(brokenHome, '.gbrain'), { recursive: true });
      writeFileSync(join(brokenHome, '.gbrain', 'workers'), 'not a directory');
      const [check] = await (withEnv({ GBRAIN_HOME: brokenHome }, () => legacyJobAuthorityEntry.run({ engine } as never)) as Promise<Array<Record<string, any>>>);
      expect(check).toMatchObject({ status: 'ok', details: { queued_spend: { long_waiting_ids: [job.id] }, live_workers: null, worker_registry_unreadable: true, worker_registry_errno: 'ENOTDIR' } });
    } finally { rmSync(brokenHome, { recursive: true, force: true }); }
  });

  test('no banner line without legacy rows', async () => {
    await queue.add('enrich', { sourceId: 'default' }, {}, { spendAuthorization: spend() });
    expect(await legacyDefaultSpendBannerNote(engine)).toBeNull();
  });
});
