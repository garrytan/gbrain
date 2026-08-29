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

  // #3063: the check must not claim "worker alive" when no worker is
  // registered for the wedged queue, and must keep the original "worker
  // alive but stuck" wording when one genuinely is.
  it('says "No worker subscribed" (not "worker alive") when no live worker is registered for the wedged queue', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike, { readWorkers: () => [] });
    expect(check.status).toBe('fail');
    expect(check.message).toContain('No worker subscribed');
    expect(check.message).not.toContain('worker alive but not claiming work');
  });

  it('keeps "worker alive but not claiming work" when a live worker IS registered for the wedged queue', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike, { readWorkers: () => [{ queue: 'default' }] });
    expect(check.status).toBe('fail');
    expect(check.message).toContain('worker alive but not claiming work');
    expect(check.message).not.toContain('No worker subscribed');
  });

  it('a throwing registry read → still fail, but liveness-unknown wording (no fabricated verdict)', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike, {
      readWorkers: () => { throw new Error('registry dir unreadable'); },
    });
    expect(check.status).toBe('fail');
    expect(check.message).toContain('worker registry unreadable');
    expect(check.message).not.toContain('worker alive but not claiming work');
    expect(check.message).not.toContain('No worker subscribed');
    expect(check.details?.worker_registry_unreadable).toBe(true);
  });

  it('mixed stuck + no-worker queues → both messages, details count each subset', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    await seed('q-orphan', 'cycle', 'waiting');
    await seed('q-orphan', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike, { readWorkers: () => [{ queue: 'default' }] });
    expect(check.status).toBe('fail');
    expect(check.message).toContain('worker alive but not claiming work');
    expect(check.message).toContain("'default'");
    expect(check.message).toContain('No worker subscribed');
    expect(check.message).toContain("'q-orphan'");
    expect(check.details?.stuck_worker_queues).toBe(1);
    expect(check.details?.no_worker_queues).toBe(1);
    expect(check.details?.wedged_queues).toBe(2);
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

  it('shell-escapes an embedded single quote in the restart hint (producer-controlled queue names)', async () => {
    // The hint is copy-pasted by operators AND remediation agents, so a
    // queue named q-wedge'd must arrive POSIX-escaped, never raw.
    // A live worker must be registered for the queue, or the #3063
    // liveness split routes this to the "no worker" branch instead,
    // which never builds the restart-hint string at all.
    await seed("q-wedge'd", 'cycle', 'waiting');
    await seed("q-wedge'd", 'cycle', 'completed', { updatedAtSql: "now() - interval '30 min'" });
    const check = await computeWedgedQueueCheck(pgLike, { readWorkers: () => [{ queue: "q-wedge'd" }] });
    expect(check.status).toBe('fail');
    expect(check.message).toContain(String.raw`--queue 'q-wedge'\''d'`);
  });

  it('hint union: wedged default AND non-default queues → bare hint plus --queue variant, comma-joined', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '30 min'" });
    await seed('q-side', 'cycle', 'waiting');
    await seed('q-side', 'cycle', 'completed', { updatedAtSql: "now() - interval '30 min'" });
    // Both queues need a live worker registered so the #3063 liveness
    // split routes them into the "stuck" branch that builds this
    // restart-hint union, not the "no worker" branch.
    const check = await computeWedgedQueueCheck(pgLike, {
      readWorkers: () => [{ queue: 'default' }, { queue: 'q-side' }],
    });
    expect(check.status).toBe('fail');
    // The bare pair (for 'default') terminates with a backtick — no --queue —
    // and the comma-join carries the per-queue variant right behind it.
    expect(check.message).toContain('`gbrain jobs supervisor stop && gbrain jobs supervisor start`, `');
    expect(check.message).toContain("--queue 'q-side'");
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
    // No owner metadata seeded → the legacy bucket, whose ONLY advertised
    // remediation is the retriage preview (never a worker restart).
    expect(check.message).toContain('gbrain dream retriage');
    expect(check.details).toMatchObject({
      orphaned_private_queues: 1,
      waiting_jobs: 1,
      legacy_unowned_queues: 1,
      recoverable_queues: 0,
    });
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

  it('runs on PGLite too (no engine short-circuit): a dead-parent queue is flagged', async () => {
    // PGLite mints the same dream-inline-* queues (children are inlined
    // precisely because no worker process can run) — the old short-circuit
    // hid exactly the brains with the fewest recovery lanes.
    await seed('dream-inline-pglite-dead', 'subagent', 'waiting', {
      createdAtSql: "now() - interval '2 hours'",
    });
    const check = await computeOrphanedPrivateQueueCheck(base as unknown as BrainEngine);
    expect(check.status).toBe('fail');
    // Engine-aware remediation: on PGLite the auto-recovery trigger is the
    // next dream run, never a supervisor command.
    expect(check.message).not.toContain('supervisor start`');
  });

  it('buckets a metadata-backed orphan as recoverable with the auto-recovery remediation', async () => {
    // Terminal owner + expired lease → the classifier verdict is 'orphan':
    // auto-recovery cancels it at the next worker spawn / cycle start.
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at) VALUES ('parent', 'cycle', 'completed', now() - interval '3 hours')`,
    );
    const owner = await base.executeRaw<{ id: number }>(`SELECT max(id)::int AS id FROM minion_jobs`);
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, updated_at, private_queue_owner_job_id, private_queue_owner_token, private_queue_lease_until)
       VALUES ('child', 'dream-inline-owned-dead', 'waiting', now() - interval '2 hours', now() - interval '2 hours', $1, 'tok', now() - interval '1 hour')`,
      [owner[0].id],
    );
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('Auto-recovery cancels the metadata-backed queue(s)');
    expect(check.details).toMatchObject({ recoverable_queues: 1, legacy_unowned_queues: 0 });
  });

  it('suppresses a queue whose owner lease is still in the future (live, never flagged)', async () => {
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, private_queue_owner_token, private_queue_lease_until)
       VALUES ('child', 'dream-inline-leased', 'waiting', now() - interval '2 hours', 'tok', now() + interval '30 min')`,
    );
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ suppressed_by_live_lease: 1 });
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

describe('orphaned private dream queues — classify cap, buckets, flagged-only counts (749a7dcb)', () => {
  beforeEach(async () => {
    // Leftover live cycle locks from earlier describes must not suppress
    // these candidates via the ownership correlation.
    await base.executeRaw('DELETE FROM gbrain_cycle_locks');
  });

  it('caps classification at 100 candidates and reports the remainder as unclassified (fail path)', async () => {
    // 101 metadata-backed orphan candidates (aged, waiting, expired lease —
    // classifier verdict 'orphan'), one row per queue for speed.
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, updated_at, private_queue_lease_until)
       SELECT 'subagent', 'dream-inline-cap-' || i, 'waiting',
              now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour'
         FROM generate_series(1, 101) AS i`,
    );
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect((check.details as any).orphaned_private_queues).toBeLessThanOrEqual(100);
    expect((check.details as any).orphaned_private_queues).toBe(100);
    expect((check.details as any).unclassified_candidates).toBe(1);
  });

  it('ok-path truncation honesty: 100 live + 1 never-classified is NOT a clean bill of health', async () => {
    // First 100 candidates classify 'live' (future lease + fresh updated_at);
    // the 101st never gets classified. Status stays ok but the message and
    // details must still surface the unclassified remainder.
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, updated_at, private_queue_lease_until)
       SELECT 'subagent', 'dream-inline-live-' || i, 'waiting',
              now() - interval '2 hours', now(), now() + interval '30 minutes'
         FROM generate_series(1, 101) AS i`,
    );
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('unclassified');
    expect((check.details as any).unclassified_candidates).toBe(1);
    expect((check.details as any).suppressed_by_live_lease).toBe(100);
  });

  it('buckets a NON-terminal unclaimed owner as owner_pending with the inspect-first remediation', async () => {
    // Owner job still waiting (not claimed, no lock) → verdict not_orphan:
    // doctor must say "inspect the owner", never advertise cancellation.
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at) VALUES ('dream-cycle', 'default', 'waiting', now() - interval '3 hours')`,
    );
    const owner = await base.executeRaw<{ id: number }>(`SELECT max(id)::int AS id FROM minion_jobs`);
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, updated_at, private_queue_owner_job_id, private_queue_owner_token)
       VALUES ('subagent', 'dream-inline-owner-pending', 'waiting', now() - interval '2 hours', now() - interval '2 hours', $1, 'tok')`,
      [owner[0].id],
    );
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('inspect it with');
    expect(check.message).toContain('gbrain jobs get');
    expect(check.details).toMatchObject({
      owner_pending_queues: 1,
      recoverable_queues: 0,
      legacy_unowned_queues: 0,
    });
  });

  it('PGLite recoverable fixture advertises `gbrain dream` as the trigger, never the supervisor', async () => {
    // Terminal owner + aged + expired lease → recoverable bucket. On PGLite
    // the engine-aware remediation must name the dream trigger (a supervisor
    // command is impossible advice — no worker process can ever run there).
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at) VALUES ('dream-cycle', 'default', 'completed', now() - interval '3 hours')`,
    );
    const owner = await base.executeRaw<{ id: number }>(`SELECT max(id)::int AS id FROM minion_jobs`);
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, updated_at, private_queue_owner_job_id, private_queue_owner_token, private_queue_lease_until)
       VALUES ('subagent', 'dream-inline-pglite-recoverable', 'waiting', now() - interval '2 hours', now() - interval '2 hours', $1, 'tok', now() - interval '1 hour')`,
      [owner[0].id],
    );
    const check = await computeOrphanedPrivateQueueCheck(base as unknown as BrainEngine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('Auto-recovery cancels the metadata-backed queue(s)');
    expect(check.message).toContain('trigger now: `gbrain dream`');
    expect(check.message).not.toContain('supervisor start`');
  });

  it('waiting_jobs counts FLAGGED queues only — live-lease-suppressed waiting rows are excluded (749a7dcb)', async () => {
    // Recoverable orphan with 3 waiting rows (terminal owner, expired lease).
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at) VALUES ('dream-cycle', 'default', 'completed', now() - interval '3 hours')`,
    );
    const owner = await base.executeRaw<{ id: number }>(`SELECT max(id)::int AS id FROM minion_jobs`);
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, updated_at, private_queue_owner_job_id, private_queue_owner_token, private_queue_lease_until)
       SELECT 'subagent', 'dream-inline-orphan-n', 'waiting',
              now() - interval '2 hours', now() - interval '2 hours', $1, 'tok', now() - interval '1 hour'
         FROM generate_series(1, 3)`,
      [owner[0].id],
    );
    // Aged candidate suppressed by a live lease, carrying 2 waiting rows that
    // must NOT leak into waiting_jobs (pre-fix it summed N+M during the scan).
    await base.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, created_at, updated_at, private_queue_lease_until)
       SELECT 'subagent', 'dream-inline-lively-m', 'waiting',
              now() - interval '2 hours', now() - interval '2 hours', now() + interval '30 minutes'
         FROM generate_series(1, 2)`,
    );
    const check = await computeOrphanedPrivateQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.details).toMatchObject({
      orphaned_private_queues: 1,
      waiting_jobs: 3,
      suppressed_by_live_lease: 1,
    });
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
