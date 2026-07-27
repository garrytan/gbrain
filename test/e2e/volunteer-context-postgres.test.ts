/**
 * v0.43 (#2095) — volunteer_context on REAL Postgres (engine parity beyond
 * PGLite) + the RLS pin for the v117 table.
 *
 * The unit suite covers the volunteer core hermetically on PGLite; this file
 * proves the same op handler against pgvector Postgres: resolution arms,
 * the fire-and-forget event sink landing rows, the stats join, and that
 * context_volunteer_events (migration v117) has ROW LEVEL SECURITY enabled (the v35
 * auto_rls_on_create_table event trigger covers migration-created tables —
 * this is the assertion that keeps that mechanism honest for new tables).
 *
 * Gated by DATABASE_URL — skips gracefully without real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { operationsByName } from '../../src/core/operations.ts';
import {
  awaitPendingVolunteerEventWrites,
  _resetPendingVolunteerEventWritesForTests,
} from '../../src/core/context/volunteer-events.ts';

const SKIP = !hasDatabase();
const describePg = SKIP ? describe.skip : describe;

function mkCtx(engine: unknown, overrides: Record<string, unknown> = {}) {
  return {
    engine,
    config: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as never;
}

describePg('volunteer_context on real Postgres (#2095)', () => {
  beforeAll(async () => {
    await setupDB();
    const engine = getEngine();
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Alice is an early founder.',
      timeline: '',
    });
  }, 240_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('op volunteers, logs through the sink, and stats join works', async () => {
    _resetPendingVolunteerEventWritesForTests();
    const engine = getEngine();
    const op = operationsByName.volunteer_context;

    const result = (await op.handler(mkCtx(engine), {
      window: 'user: who knows the seed market?\nassistant: Alice Example does.\nuser: ask her',
      session_id: 'e2e-pg',
    })) as any;
    expect(result.count).toBe(1);
    expect(result.pages[0].slug).toBe('people/alice-example');
    expect(result.pages[0].arm).toBe('title');

    const { unfinished } = await awaitPendingVolunteerEventWrites(10_000);
    expect(unfinished).toBe(0);

    const rows = await engine.executeRaw<{ slug: string; session_id: string }>(
      `SELECT slug, session_id FROM context_volunteer_events WHERE session_id = 'e2e-pg'`,
      [],
    );
    expect(rows.length).toBe(1);

    // Mark the page as opened after volunteering → stats counts it used.
    await engine.executeRaw(
      `UPDATE pages SET last_retrieved_at = now() + interval '1 minute' WHERE slug = 'people/alice-example'`,
      [],
    );
    const stats = (await op.handler(mkCtx(engine), { stats: true })) as any;
    expect(stats.approximate).toBe(true);
    expect(stats.total_volunteered).toBeGreaterThanOrEqual(1);
    expect(stats.total_used).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test('RLS is enabled on context_volunteer_events (auto-RLS covers v117)', async () => {
    const engine = getEngine();
    const rows = await engine.executeRaw<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class
        WHERE oid = 'public.context_volunteer_events'::regclass`,
      [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].relrowsecurity).toBe(true);
  }, 60_000);
});
