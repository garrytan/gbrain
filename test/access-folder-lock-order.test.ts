/**
 * GBRA-218 (A2): a rulebook install and a page write take the source's locks in one order. Page writers hold
 * `sources FOR SHARE` and their stamping trigger then takes `access_policy_state FOR SHARE`; an install now takes
 * `sources FOR NO KEY UPDATE` before `access_policy_state FOR UPDATE`, so a page write already holding the source
 * finishes first and the install stamps it, instead of the two deadlocking. Real Postgres only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'lock-order';
const SKIP = !process.env.DATABASE_URL;

describe.skipIf(SKIP)('folder rule install vs an open page write (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
  }, 120_000);
  afterAll(async () => { await close(); });

  test('a page written in a transaction held open across proposeRevision ends up stamped', async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let holding!: () => void;
    const held = new Promise<void>(resolve => { holding = resolve; });
    const write = engine.transaction(async tx => {
      await tx.executeRaw('SELECT incarnation FROM sources WHERE id = $1 FOR SHARE', [SRC]);
      holding();
      await released;
      await tx.putPage('partners/secret-example/plan', { type: 'note', title: 'Plan', compiled_truth: 'Plan notes.', timeline: '', frontmatter: {} }, { sourceId: SRC });
    });
    await held;
    const install = proposeRevision(engine, SRC, [{ id: 'secret', prefix: 'partners/secret-example/', readable_by: ['member:alice-example'] }],
      { origin: 'cli', store: 'database' });
    const deadline = Date.now() + 30_000;
    while ((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"))[0]!.n === 0) {
      if (Date.now() > deadline) throw new Error('proposeRevision never waited on the open page write');
      await Bun.sleep(50);
    }
    release();
    const settled = await Promise.allSettled([write, install]);
    expect(settled.map(s => (s.status === 'rejected' ? String(s.reason) : 'ok'))).toEqual(['ok', 'ok']);
    const [page] = await engine.executeRaw<{ folder_rule_ids: string[] | null }>(
      "SELECT folder_rule_ids FROM pages WHERE source_id = $1 AND slug = 'partners/secret-example/plan'", [SRC]);
    expect(page?.folder_rule_ids).toEqual([`${SRC}:secret`]);
  }, 120_000);
});
