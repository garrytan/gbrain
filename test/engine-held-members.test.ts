/**
 * Two engine members the member layer adds before any caller uses them (engine-sql/trust-tier-reads.ts,
 * engine-sql/op-checkpoint.ts), run on PGLite: the pending core-edit notices read (newest per page, unacknowledged,
 * optionally limited to sources) and the stale applied-capture purge (rows past the retention only, and how many).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('listPendingCoreEditNotices', () => {
  test('answers the newest unacknowledged notice per page, and only the named sources when given', async () => {
    await engine.executeRaw('DELETE FROM core_edit_notices');
    await engine.executeRaw(
      `INSERT INTO core_edit_notices (source_id, slug, revision, actor, acked_at) VALUES
         ('default', 'core/a', 'r1', 'old', NULL), ('default', 'core/a', 'r2', 'new', NULL),
         ('default', 'core/b', 'r3', 'done', now()), ('other', 'core/c', 'r4', 'elsewhere', NULL)`);
    const all = await engine.listPendingCoreEditNotices(null);
    expect(all.map((row) => [row.source_id, row.slug, row.revision, row.actor])).toEqual([
      ['default', 'core/a', 'r2', 'new'], ['other', 'core/c', 'r4', 'elsewhere'],
    ]);
    const one = await engine.listPendingCoreEditNotices(['other']);
    expect(one.map((row) => row.slug)).toEqual(['core/c']);
    expect(await engine.listPendingCoreEditNotices([])).toEqual([]);
  });
});

describe('purgeStaleAppliedCaptures', () => {
  test('deletes the records past the retention, keeps newer ones, and says how many', async () => {
    await engine.executeRaw('DELETE FROM ingest_applied_captures');
    await engine.executeRaw(
      `INSERT INTO ingest_applied_captures (idempotency_key, source_id, slug, result, applied_at) VALUES
         ('old-1', 'default', 'a', '{}', now() - interval '100 days'), ('old-2', 'default', 'b', '{}', now() - interval '91 days'),
         ('recent', 'default', 'c', '{}', now() - interval '2 days')`);
    expect(await engine.purgeStaleAppliedCaptures(90)).toBe(2);
    const left = await engine.executeRaw<{ idempotency_key: string }>('SELECT idempotency_key FROM ingest_applied_captures');
    expect(left.map((row) => row.idempotency_key)).toEqual(['recent']);
    expect(await engine.purgeStaleAppliedCaptures(90)).toBe(0);
  });
});
