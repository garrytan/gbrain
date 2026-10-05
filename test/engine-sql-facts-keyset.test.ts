/**
 * listFactsKeyset (delta's facts arm read contract): ascending
 * `(created_at, id)` strictly after a keyset, column-precision
 * `created_at_iso`, `id: null` = strictly after the timestamp. Both engines.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) {
  describe(`listFactsKeyset (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    async function fact(text: string, at: string, visibility: 'world' | 'private' = 'world'): Promise<number> {
      const { id } = await engine.insertFact({ fact: text, kind: 'fact', visibility, entity_slug: null, source: 'test' } as never, { source_id: 'default' });
      await engine.executeRaw(`UPDATE facts SET created_at = $1::text::timestamptz WHERE id = $2`, [at, id]);
      return id;
    }
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });

    test('oldest first; same-microsecond rows tie-break by id; ids ordered differently from timestamps', async () => {
      const late = await fact('k-late', '2026-08-10T12:00:00.000300Z');
      const tieA = await fact('k-tie-a', '2026-08-10T12:00:00.000200Z');
      const tieB = await fact('k-tie-b', '2026-08-10T12:00:00.000200Z');
      const early = await fact('k-early', '2026-08-10T12:00:00.000100Z');
      const rows = await engine.listFactsKeyset('default', null, { limit: 10 });
      expect(rows.map((r) => r.id)).toEqual([early, tieA, tieB, late]);
      expect(rows.map((r) => r.created_at_iso)).toEqual([
        '2026-08-10T12:00:00.000100Z', '2026-08-10T12:00:00.000200Z', '2026-08-10T12:00:00.000200Z', '2026-08-10T12:00:00.000300Z',
      ]);
      const afterTieA = await engine.listFactsKeyset('default', { createdAt: '2026-08-10T12:00:00.000200Z', id: tieA }, { limit: 10 });
      expect(afterTieA.map((r) => r.id)).toEqual([tieB, late]);
      const strict = await engine.listFactsKeyset('default', { createdAt: '2026-08-10T12:00:00.000200Z', id: null }, { limit: 10 });
      expect(strict.map((r) => r.id)).toEqual([late]);
    });

    test('limit, visibility and activeOnly apply before the keyset page', async () => {
      await fact('v-private', '2026-08-10T12:00:00.000100Z', 'private');
      const w1 = await fact('v-world-1', '2026-08-10T12:00:00.000200Z');
      const w2 = await fact('v-world-2', '2026-08-10T12:00:00.000300Z');
      await fact('v-expired', '2026-08-10T12:00:00.000400Z');
      await engine.executeRaw(`UPDATE facts SET expired_at = now() WHERE fact = 'v-expired'`);
      const page = await engine.listFactsKeyset('default', null, { limit: 1, visibility: ['world'], activeOnly: true });
      expect(page.map((r) => r.id)).toEqual([w1]);
      const rest = await engine.listFactsKeyset('default', { createdAt: page[0].created_at_iso!, id: page[0].id }, { limit: 10, visibility: ['world'] });
      expect(rest.map((r) => r.id)).toEqual([w2]);
    });
  });
}
