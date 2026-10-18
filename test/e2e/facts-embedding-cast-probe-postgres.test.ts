/**
 * #6712 PR 3 (L6): the facts.embedding cast probe runs once per process, not
 * once per transaction.
 *
 * Protects: a fact insert inside a transaction caches the probed cast suffix on
 * the engine the transaction runs on, so the next publication transaction
 * skips the pg_attribute probe (one round trip per page publish).
 * Fails when: the suffix is cached only on the transaction's clone and lost
 * when the transaction ends.
 * Seams: PostgresEngine.transaction (an Object.create clone of the engine).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
const castSuffix = (engine: PostgresEngine) => (engine as unknown as { _factsEmbeddingCastSuffix: string | null })._factsEmbeddingCastSuffix;

describe.skipIf(!databaseUrl)('facts embedding cast probe (postgres)', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
    await engine.putPage('notes/cast-probe-example', { type: 'note', title: 'Cast probe example', compiled_truth: 'Body.', timeline: '' }, { sourceId: 'default' });
  });
  afterAll(async () => {
    await engine.executeRaw("DELETE FROM facts WHERE source_markdown_slug='notes/cast-probe-example'");
    await engine.executeRaw("DELETE FROM pages WHERE slug='notes/cast-probe-example' AND source_id='default'");
    await engine.disconnect();
  });

  test('a fact insert inside a transaction leaves the probed suffix on the engine for the next transaction', async () => {
    expect(castSuffix(engine)).toBeNull();
    const row = (n: number) => ({ fact: `Example claim ${n}`, kind: 'fact' as const, entity_slug: 'notes/cast-probe-example', source: 'test', row_num: n, source_markdown_slug: 'notes/cast-probe-example' });
    await engine.transaction(tx => tx.insertFacts([row(1)], { source_id: 'default' }));
    expect(['::vector', '::halfvec']).toContain(castSuffix(engine)!);
    await engine.transaction(tx => tx.insertFacts([row(2)], { source_id: 'default' }));
    const [stored] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug='notes/cast-probe-example' AND expired_at IS NULL");
    expect(stored!.n).toBe(2);
  });
});
