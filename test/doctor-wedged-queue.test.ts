/**
 * issue #1801 fix #3 — doctor surfaces the wedged-queue signature as a health
 * ERROR (and the latent `state`→`status` regression in the remote queue_health
 * check is gone).
 *
 * computeWedgedQueueCheck is Postgres-only (short-circuits to ok on PGLite), so
 * we run its grouped SQL on a real PGLite engine behind a `kind: 'postgres'`
 * stub. Seeds verify: wedged → fail; live-lock → ok; null-completions →
 * conservative ok (the supervisor's startup-grace-aware watchdog owns that case);
 * per-queue grouping so a healthy queue doesn't mask a wedged one (Codex #15).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { doctorSource } from './helpers/doctor-source.ts';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  computeOrphanedPrivateQueueCheck,
  computeQueueHealthCheck,
  computeWedgedQueueCheck,
} from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let base: PGLiteEngine;
let pgLike: BrainEngine;

beforeAll(async () => {
  base = new PGLiteEngine();
  await base.connect({});
  await base.initSchema();
  // computeWedgedQueueCheck only reads .kind + .executeRaw.
  pgLike = {
    kind: 'postgres',
    executeRaw: base.executeRaw.bind(base),
  } as unknown as BrainEngine;
});

afterAll(async () => {
  await base.disconnect();
});

beforeEach(async () => {
  // Wipe only minion_jobs (preserve config/version that ensureSchema reads).
  await base.executeRaw('DELETE FROM minion_jobs');
});

async function seed(
  queue: string,
  name: string,
  status: string,
  extra: { lockUntilSql?: string; updatedAtSql?: string; createdAtSql?: string } = {},
): Promise<void> {
  await base.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, lock_until, updated_at, created_at)
     VALUES ($1, $2, $3, ${extra.lockUntilSql ?? 'NULL'}, ${extra.updatedAtSql ?? 'now()'}, ${extra.createdAtSql ?? 'now()'})`,
    [name, queue, status],
  );
}

describe('issue #2557 — queue_health catches deferred embed with no worker', () => {
  it('warns when old embed-backfill jobs have no live worker for their queue', async () => {
    await seed('default', 'embed-backfill', 'waiting', {
      createdAtSql: "now() - interval '3 hours'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [],
      oldWaitingHours: 1,
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('embed-backfill');
    expect(check.message).toContain('no live worker');
    expect(check.message).toContain('gbrain jobs work --queue default');
  });

  it('does not warn for old embed-backfill jobs when a worker is live on that queue', async () => {
    await seed('default', 'embed-backfill', 'waiting', {
      createdAtSql: "now() - interval '3 hours'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [{ queue: 'default' }],
      oldWaitingHours: 1,
    });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('no old embed-backfill jobs without a worker');
  });
});

describe('issue #1801 fix #3 — computeWedgedQueueCheck', () => {
  it('flags a wedged queue (waiting, 0 active_healthy, stale completion) as fail', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain("'default'");
  });

  it('does NOT flag when a job holds a live lock (active_healthy > 0)', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'active', { lockUntilSql: "now() + interval '5 min'" });
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('ok');
  });

  it('does NOT flag an expired-lock active row as healthy — still wedged (Codex #6)', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'active', { lockUntilSql: "now() - interval '2 min'" }); // expired
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('fail'); // expired lock does not count as active_healthy
  });

  it('is conservative on never-completed queues (null mins → ok)', async () => {
    await seed('default', 'cycle', 'waiting'); // no completed row → mins null
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('ok');
  });

  it('groups by queue — a healthy queue does not mask a wedged one (Codex #15)', async () => {
    // healthy queue
    await seed('q-healthy', 'cycle', 'active', { lockUntilSql: "now() + interval '5 min'" });
    await seed('q-healthy', 'cycle', 'completed', { updatedAtSql: 'now()' });
    // wedged queue
    await seed('q-wedged', 'cycle', 'waiting');
    await seed('q-wedged', 'cycle', 'completed', { updatedAtSql: "now() - interval '30 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain("'q-wedged'");
    expect(check.message).not.toContain("'q-healthy'");
  });

  it('does NOT misclassify parent-owned dream queues as worker wedges', async () => {
    await seed('dream-inline-dead-parent', 'subagent', 'waiting', {
      createdAtSql: "now() - interval '2 hours'",
    });
    await seed('dream-inline-dead-parent', 'subagent', 'completed', {
      updatedAtSql: "now() - interval '2 hours'",
    });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('ok');
  });

  it('returns ok on PGLite (no multi-process worker surface)', async () => {
    const check = await computeWedgedQueueCheck(base as unknown as BrainEngine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('PGLite');
  });
});

describe('orphaned private dream queues', () => {
  it('flags an old private queue with waiting jobs and no live parent', async () => {
    await seed('dream-inline-dead-parent', 'subagent', 'waiting', {
      createdAtSql: "now() - interval '2 hours'",
    });
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('supervisor restart cannot consume');
    expect(check.message).toContain('queue-reconciliation dry run');
    expect(check.details).toMatchObject({ orphaned_private_queues: 1, waiting_jobs: 1 });
  });

  it('does not flag a private queue whose parent still holds a live job lock', async () => {
    await seed('dream-inline-live-parent', 'subagent', 'waiting', {
      createdAtSql: "now() - interval '2 hours'",
    });
    await seed('dream-inline-live-parent', 'subagent', 'active', {
      lockUntilSql: "now() + interval '5 min'",
    });
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
  });

  it('allows a startup grace period for a new private queue', async () => {
    await seed('dream-inline-new-parent', 'subagent', 'waiting', {
      createdAtSql: "now() - interval '10 min'",
    });
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
  });

  it('returns ok on PGLite', async () => {
    const check = await computeOrphanedPrivateQueueCheck(base as unknown as BrainEngine);
    expect(check.status).toBe('ok');
  });
});

describe('orphaned private dream queues — cycle-lock liveness + ownership correlation (#4250)', () => {
  async function seedWithData(
    queue: string,
    status: string,
    dataJson: Record<string, unknown>,
    extra: { createdAtSql?: string } = {},
  ): Promise<void> {
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data, created_at)
       VALUES ($1, $2, $3, $4::text::jsonb, ${extra.createdAtSql ?? 'now()'})`,
      ['subagent', queue, status, JSON.stringify(dataJson)],
    );
  }

  async function seedLock(id: string, acquiredAtSql: string): Promise<void> {
    await base.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, 1234, 'test-host', ${acquiredAtSql}, now() + interval '10 min', now())
       ON CONFLICT (id) DO UPDATE SET acquired_at = ${acquiredAtSql}, ttl_expires_at = now() + interval '10 min'`,
      [id],
    );
  }

  function inlineQueueName(bornMsAgo: number): string {
    return `dream-inline-${Date.now() - bornMsAgo}-abcdef01`;
  }

  beforeEach(async () => {
    await base.executeRaw('DELETE FROM gbrain_cycle_locks');
  });

  it('a live per-source lock acquired BEFORE the queue was born suppresses it (possibly owned)', async () => {
    const q = inlineQueueName(2 * 3600_000); // born 2h ago
    await seedWithData(q, 'waiting', { source_id: 'repo-a' }, { createdAtSql: "now() - interval '2 hours'" });
    await seedLock('gbrain-cycle:repo-a', "now() - interval '3 hours'"); // acquired before birth
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
    expect((check.details as any)?.suppressed_by_live_lock).toBe(1);
  });

  it('a live lock acquired AFTER the queue was born cannot own it — still flagged', async () => {
    const q = inlineQueueName(2 * 3600_000); // born 2h ago
    await seedWithData(q, 'waiting', { source_id: 'repo-a' }, { createdAtSql: "now() - interval '2 hours'" });
    await seedLock('gbrain-cycle:repo-a', "now() - interval '30 min'"); // new cycle, acquired after birth
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain(q);
  });

  it("a live lock for a DIFFERENT source does not suppress another source's dead queue", async () => {
    const q = inlineQueueName(2 * 3600_000);
    await seedWithData(q, 'waiting', { source_id: 'repo-a' }, { createdAtSql: "now() - interval '2 hours'" });
    await seedLock('gbrain-cycle:repo-b', "now() - interval '3 hours'");
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
  });

  it('the bare global lock suppresses only queues it could own (born at/after acquisition)', async () => {
    const oldQ = inlineQueueName(4 * 3600_000); // predates the lock → flagged
    const newQ = inlineQueueName(90 * 60_000);  // born after acquisition, >60m old → suppressed
    await seedWithData(oldQ, 'waiting', {}, { createdAtSql: "now() - interval '4 hours'" });
    await seedWithData(newQ, 'waiting', {}, { createdAtSql: "now() - interval '90 min'" });
    await seedLock('gbrain-cycle', "now() - interval '2 hours'");
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain(oldQ);
    expect(check.message).not.toContain(newQ);
    expect((check.details as any)?.suppressed_by_live_lock).toBe(1);
  });

  it('delayed rows count toward the waiting-class (retriage repairs waiting|delayed)', async () => {
    await seedWithData('dream-inline-delayed-only', 'delayed', {}, { createdAtSql: "now() - interval '2 hours'" });
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect((check.details as any)?.waiting_jobs).toBe(1);
  });

  it('paused rows never fail the check (no advertised repair path) but surface in details', async () => {
    await seedWithData('dream-inline-paused-only', 'paused', {}, { createdAtSql: "now() - interval '2 hours'" });
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
    expect((check.details as any)?.paused_jobs).toBe(1);
  });

  it('GBRAIN_ORPHANED_PRIVATE_QUEUE_MINUTES overrides the age threshold', async () => {
    await seedWithData('dream-inline-fresh-orphan', 'waiting', {}, { createdAtSql: "now() - interval '10 min'" });
    await withEnv({ GBRAIN_ORPHANED_PRIVATE_QUEUE_MINUTES: '5' }, async () => {
      const check = await computeOrphanedPrivateQueueCheck(pgLike);
      expect(check.status).toBe('fail'); // 10min > 5min override; default 60 would pass
    });
  });

  it('a TTL-lapsed lock refreshed within the steal grace still counts as live (starved-but-alive holder)', async () => {
    const q = inlineQueueName(2 * 3600_000);
    await seedWithData(q, 'waiting', { source_id: 'repo-slow' }, { createdAtSql: "now() - interval '2 hours'" });
    // TTL lapsed 1 min ago, but the holder refreshed 30s ago and acquired
    // BEFORE the queue was born — db-lock's steal path would not kill this
    // holder, so doctor must not point operators at cancelling its queue.
    await base.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-cycle:repo-slow', 1234, 'test-host', now() - interval '3 hours', now() - interval '1 min', now() - interval '30 sec')`,
    );
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
    expect((check.details as any)?.suppressed_by_live_lock).toBe(1);
  });

  it('clock-skew tolerance: a lock acquired seconds AFTER the queue birth still owns it', async () => {
    // Host Date.now (queue name) vs DB NOW() (acquired_at) can skew by
    // seconds on remote engines; the maintenance lane mints its queue right
    // after acquiring the lock. A 30s gap must suppress, not flag.
    const q = inlineQueueName(2 * 3600_000);
    await seedWithData(q, 'waiting', { source_id: 'repo-skew' }, { createdAtSql: "now() - interval '2 hours'" });
    await seedLock('gbrain-cycle:repo-skew', "now() - interval '2 hours' + interval '30 sec'");
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
    expect((check.details as any)?.suppressed_by_live_lock).toBe(1);
  });
});

describe('Minions-visibility wave — computeQueueHealthCheck structured details', () => {
  it('ok path carries {depth, oldest_age_seconds, worker_alive} (messages unchanged)', async () => {
    const check = await computeQueueHealthCheck(pgLike, { readWorkers: () => [] });
    expect(check.status).toBe('ok');
    // Message text is pinned elsewhere by prose consumers — unchanged.
    expect(check.message).toContain('No stalled-forever jobs');
    // Empty queue: zero depth, null oldest age, vacuously worker_alive.
    expect(check.details).toEqual({ depth: 0, oldest_age_seconds: null, worker_alive: true });
  });

  it('warn path reports total waiting depth + oldest age + worker_alive=false when a waiting queue has no worker', async () => {
    await seed('default', 'embed-backfill', 'waiting', {
      createdAtSql: "now() - interval '3 hours'",
    });
    await seed('default', 'embed', 'waiting', {
      createdAtSql: "now() - interval '10 minutes'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [],
      oldWaitingHours: 1,
    });
    expect(check.status).toBe('warn');
    const d = check.details as { depth: number; oldest_age_seconds: number; worker_alive: boolean };
    expect(d.depth).toBe(2);
    expect(d.oldest_age_seconds).toBeGreaterThanOrEqual(3 * 3600 - 60);
    expect(d.worker_alive).toBe(false);
  });

  it('worker_alive=true when every waiting queue has a live registered worker', async () => {
    await seed('default', 'embed', 'waiting');
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [{ queue: 'default' }],
    });
    const d = check.details as { worker_alive: boolean };
    expect(d.worker_alive).toBe(true);
  });
});

describe('issue #1801 fix #3 — remote queue_health state→status regression', () => {
  it('doctor.ts no longer queries the non-existent `state` column', () => {
    const src = doctorSource();
    // The column is `status`; the pre-fix `WHERE state = 'active'` errored every
    // run and the catch silently returned "No queue activity".
    expect(src).not.toContain("state = 'active'");
  });
});
