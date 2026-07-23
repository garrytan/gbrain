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
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeWedgedQueueCheck } from '../src/commands/doctor.ts';
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
  extra: { lockUntilSql?: string; updatedAtSql?: string } = {},
): Promise<void> {
  await base.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, lock_until, updated_at)
     VALUES ($1, $2, $3, ${extra.lockUntilSql ?? 'NULL'}, ${extra.updatedAtSql ?? 'now()'})`,
    [name, queue, status],
  );
}

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

  it('returns ok on PGLite (no multi-process worker surface)', async () => {
    const check = await computeWedgedQueueCheck(base as unknown as BrainEngine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('PGLite');
  });
});

describe('issue #1801 fix #3 — remote queue_health state→status regression', () => {
  it('doctor.ts no longer queries the non-existent `state` column', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'commands', 'doctor.ts'),
      'utf8',
    );
    // The column is `status`; the pre-fix `WHERE state = 'active'` errored every
    // run and the catch silently returned "No queue activity".
    expect(src).not.toContain("state = 'active'");
  });
});
