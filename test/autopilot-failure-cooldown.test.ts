/**
 * #2194 fix #2 — failure cooldown (the storm-breaker).
 *
 * A source whose autopilot-cycle keeps failing re-dispatched every 5-min tick
 * (only SUCCESS gated dispatch), so the same handful of sources failed and
 * re-fanned-out forever — 200+ dead jobs/24h. The cooldown backs a failed
 * source off with bounded exponential delay, read at dispatch from minion_jobs
 * (dead/failed rows) AND re-checked at claim time (codex #5). A success clears
 * it (codex #7). These tests pin the pure math, the engine query, the
 * null-source guard (codex #6), and the dispatch/claim-time gates.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  cooldownMinForCount,
  isInFailureCooldown,
  readRecentSourceFailures,
  isSourceInCooldown,
  selectSourcesForDispatch,
  resolveFailureCooldownOpts,
  type SourceFailure,
  type CooldownOpts,
} from '../src/commands/autopilot-fanout.ts';
import type { SourceRow } from '../src/core/engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { MinionJob } from '../src/core/minions/types.ts';
import { waitFor } from './helpers/wait-for.ts';

const OPTS: CooldownOpts = { baseMin: 10, capMin: 120 };

describe('cooldownMinForCount — bounded exponential', () => {
  test('grows 10, 20, 40, 80 then caps at 120', () => {
    expect(cooldownMinForCount(1, OPTS)).toBe(10);
    expect(cooldownMinForCount(2, OPTS)).toBe(20);
    expect(cooldownMinForCount(3, OPTS)).toBe(40);
    expect(cooldownMinForCount(4, OPTS)).toBe(80);
    expect(cooldownMinForCount(5, OPTS)).toBe(120); // 160 capped to 120
    expect(cooldownMinForCount(99, OPTS)).toBe(120);
  });
  test('zero/negative count or disabled base → 0', () => {
    expect(cooldownMinForCount(0, OPTS)).toBe(0);
    expect(cooldownMinForCount(3, { baseMin: 0, capMin: 120 })).toBe(0);
  });
});

describe('isInFailureCooldown — pure decision', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  const ago = (min: number) => new Date(now - min * 60_000);

  test('no failure record → not in cooldown', () => {
    expect(isInFailureCooldown(undefined, null, now, OPTS)).toBe(false);
  });
  test('disabled (baseMin 0) → never in cooldown', () => {
    expect(isInFailureCooldown({ count: 5, lastFailedAt: ago(1) }, null, now, { baseMin: 0, capMin: 120 })).toBe(false);
  });
  test('failed 5min ago, count 1 (cooldown 10) → in cooldown', () => {
    expect(isInFailureCooldown({ count: 1, lastFailedAt: ago(5) }, null, now, OPTS)).toBe(true);
  });
  test('failed 15min ago, count 1 (cooldown 10) → recovered by time', () => {
    expect(isInFailureCooldown({ count: 1, lastFailedAt: ago(15) }, null, now, OPTS)).toBe(false);
  });
  test('success at/after the latest failure → cleared (codex #7)', () => {
    const failure: SourceFailure = { count: 3, lastFailedAt: ago(5) };
    expect(isInFailureCooldown(failure, ago(4), now, OPTS)).toBe(false); // success 4min ago > fail 5min ago
  });
  test('success BEFORE the latest failure, still in window → suppressed', () => {
    const failure: SourceFailure = { count: 3, lastFailedAt: ago(5) };
    expect(isInFailureCooldown(failure, ago(30), now, OPTS)).toBe(true);
  });
});

describe('selectSourcesForDispatch — cooldown bucket', () => {
  const src = (id: string): SourceRow => ({ id, name: id, config: {} } as SourceRow);
  test('a stale source in cooldown is held in skippedCooldown, not dispatched', () => {
    const sources = [src('a'), src('b')];
    const failures = new Map<string, SourceFailure>([
      ['a', { count: 1, lastFailedAt: new Date(Date.now() - 60_000) }], // 1min ago, cooldown 10min
    ]);
    const r = selectSourcesForDispatch(sources, 4, Date.now(), 60, failures, OPTS);
    expect(r.dispatch.map(s => s.id)).toEqual(['b']);
    expect(r.skippedCooldown.map(s => s.id)).toEqual(['a']);
  });
});

describe('readRecentSourceFailures + isSourceInCooldown (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function addJob(status: string, sourceId: string | null, finishedMinAgo: number): Promise<void> {
    const finished = new Date(Date.now() - finishedMinAgo * 60_000).toISOString();
    const data = sourceId === null ? {} : { source_id: sourceId };
    await engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, status, data, finished_at) VALUES ('{"version":1,"kind":"application"}'::jsonb, 'autopilot-cycle', $1, $2, $3)`,
      [status, data, finished],
    );
  }

  test('groups dead/failed jobs by source with count + max(finished_at)', async () => {
    await addJob('dead', 'repo-a', 5);
    await addJob('failed', 'repo-a', 2);
    await addJob('dead', 'repo-b', 10);
    await addJob('completed', 'repo-a', 1); // not counted
    const map = await readRecentSourceFailures(engine, { sinceMin: 120 });
    expect(map.get('repo-a')?.count).toBe(2);
    expect(map.get('repo-b')?.count).toBe(1);
    expect(map.has('repo-a')).toBe(true);
    // last failed is the most recent of the two (2 min ago).
    const lastA = map.get('repo-a')!.lastFailedAt.getTime();
    expect(Date.now() - lastA).toBeLessThan(4 * 60_000);
  });

  test('null source_id rows are excluded (codex #6)', async () => {
    await addJob('dead', null, 3);
    await addJob('dead', 'repo-c', 3);
    const map = await readRecentSourceFailures(engine, { sinceMin: 120 });
    expect(map.has('repo-c')).toBe(true);
    expect([...map.keys()].some(k => !k)).toBe(false);
    expect(map.size).toBe(1);
  });

  test('failures older than the window are not counted', async () => {
    await addJob('dead', 'repo-old', 500); // way outside a 120min window
    const map = await readRecentSourceFailures(engine, { sinceMin: 120 });
    expect(map.has('repo-old')).toBe(false);
  });

  test('isSourceInCooldown: recent failure → true; cleared after a success stamp', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, created_at) VALUES ('repo-cd', 'r', '{}'::jsonb, now())`, [],
    );
    await addJob('dead', 'repo-cd', 1); // 1 min ago, count 1 → 10min cooldown
    expect(await isSourceInCooldown(engine, 'repo-cd')).toBe(true);

    // Operator repairs + a successful cycle stamps last_source_cycle_at NOW.
    await engine.updateSourceConfig('repo-cd', { last_source_cycle_at: new Date().toISOString() });
    expect(await isSourceInCooldown(engine, 'repo-cd')).toBe(false);
  });

  test('isSourceInCooldown returns false when cooldown disabled (failure_cooldown_min=0)', async () => {
    await engine.setConfig('autopilot.failure_cooldown_min', '0');
    await addJob('dead', 'repo-dis', 1);
    expect(await isSourceInCooldown(engine, 'repo-dis')).toBe(false);
    const opts = await resolveFailureCooldownOpts(engine);
    expect(opts.baseMin).toBe(0);
  });
});

describe('#7188: a cycle with one failed phase does not back off its source', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    queue = new MinionQueue(engine);
  }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  async function freshSource(): Promise<void> {
    await engine.executeRaw('DELETE FROM minion_jobs');
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'repo-phase'`);
    await engine.executeRaw(`INSERT INTO sources (id, name, config, created_at) VALUES ('repo-phase', 'r', '{}'::jsonb, now())`, []);
  }
  beforeEach(freshSource);

  const cycleWithFailedPhase = {
    partial: true, status: 'partial',
    report: { status: 'partial', phases: [{ phase: 'sync', status: 'ok' }, { phase: 'extract', status: 'fail', summary: 'extract failed' }] },
  };

  /** Run `cycles` autopilot-cycle jobs for repo-phase through a worker whose handler does `handler`. */
  async function runCycles(cycles: number, handler: () => Promise<Record<string, unknown>>): Promise<MinionJob[]> {
    const jobs: MinionJob[] = [];
    for (let i = 0; i < cycles; i++) jobs.push(await queue.add('autopilot-cycle', { source_id: 'repo-phase' }, { max_attempts: 1 }));
    const worker = new MinionWorker(engine, { pollInterval: 25 });
    worker.register('autopilot-cycle', handler);
    const running = worker.start();
    try {
      await waitFor(async () => {
        const rows = await Promise.all(jobs.map(j => queue.getJob(j.id)));
        return rows.every(r => r && ['completed', 'failed', 'dead'].includes(r.status));
      }, { timeoutMs: 15_000, label: 'cycles terminal' });
    } finally {
      worker.stop();
      await running;
    }
    return (await Promise.all(jobs.map(j => queue.getJob(j.id)))) as MinionJob[];
  }

  test('N cycles each ending failed on one phase leave the source dispatchable', async () => {
    const jobs = await runCycles(4, async () => cycleWithFailedPhase);
    for (const job of jobs) {
      expect(job.status).toBe('failed');
      expect(job.result).toMatchObject({ job_outcome: 'phase_failed', failed_phase: 'extract' });
    }
    expect((await readRecentSourceFailures(engine, { sinceMin: 120 })).has('repo-phase')).toBe(false);
    expect(await isSourceInCooldown(engine, 'repo-phase')).toBe(false);
  });

  test('a whole-cycle failure still backs the source off: a thrown handler, or blocked_by_failures', async () => {
    await runCycles(1, async () => { throw new Error('cycle crashed'); });
    expect(await isSourceInCooldown(engine, 'repo-phase')).toBe(true);
    await freshSource();
    const [blocked] = await runCycles(1, async () => ({ status: 'blocked_by_failures', reason: 'held_files' }));
    expect(blocked.result).toMatchObject({ job_outcome: 'failed' });
    expect(await isSourceInCooldown(engine, 'repo-phase')).toBe(true);
  });
});
