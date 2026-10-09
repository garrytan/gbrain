import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { withEnv } from './helpers/with-env.ts';

describe('relaxed keyword query planning', () => {
  // Protects bounded ranking after eligibility. Reverting the engine dispatch
  // restores unbounded ranking. Existing tests do not cover this access path.
  // No production-only testing seam is needed.
  test('bounds reranking after source, visibility, and chunk eligibility', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: undefined }, async () => {
      const fake = makeFakeSql((statement) => statement.text.startsWith('SHOW enable_seqscan')
        ? [{ enable_seqscan: 'on' }] : []);
      const engine = new PostgresEngine();
      (engine as unknown as { _sql: unknown })._sql = fake.sql;
      (engine as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
      await engine.searchKeyword('alpha beta', {
        sourceId: 'restricted-source', limit: 3, orFallback: true,
        excludePrivate: true, requireSafeChunks: true, language: 'en',
      });
      const statements = fake.statements();
      const attempts = statements.filter((statement) => statement.via === 'unsafe');
      expect(attempts).toHaveLength(2);
      const [strict, relaxed] = attempts;
      expect(strict!.text).not.toContain('OFFSET 0');
      expect(relaxed!.text).toContain('term_matches AS MATERIALIZED');
      expect(relaxed!.text).toContain('LIMIT 4096');
      expect(relaxed!.text).toContain('ORDER BY coverage DESC, page_position ASC');
      expect(relaxed!.text.indexOf('p.source_id = $')).toBeLessThan(relaxed!.text.indexOf('LIMIT 4096'));
      expect(relaxed!.text.indexOf('cc.language = $')).toBeLessThan(relaxed!.text.indexOf('LIMIT 4096'));
      expect(relaxed!.text.indexOf('LIMIT 4096')).toBeLessThan(relaxed!.text.indexOf('ts_rank(cc.search_vector'));
      for (const attempt of attempts) {
        expect(attempt.text).toContain('p.source_id = $');
        expect(attempt.text).toContain('cc.language = $');
        expect(attempt.text).toContain('p.deleted_at IS NULL');
        expect(attempt.text).toContain('COALESCE(p.chunker_version, 0) >= 4');
        expect(attempt.text).toContain('ORDER BY score DESC, page_id ASC, chunk_id ASC');
      }
      expect(strict!.params[0]).toBe('alpha beta');
      expect(relaxed!.params[0]).toBe('alpha OR beta');
      expect(relaxed!.params.slice(1)).toEqual(strict!.params.slice(1));
      expect(relaxed!.params).toContain('restricted-source');
      expect(statements.filter((statement) => statement.text === "SET LOCAL statement_timeout = '8s'")).toHaveLength(2);
    });
  });
});
