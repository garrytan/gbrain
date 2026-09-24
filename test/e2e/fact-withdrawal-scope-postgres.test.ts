import { describe, expect, test } from 'bun:test';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const describePg = hasDatabase() ? describe : describe.skip;

describePg('Postgres fact-withdrawal scope', () => {
  test('stays inside admission with source-scoped evidence while preserving unrelated pages', async () => {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const { engine } = fixture;
    const sourceId = 'withdrawal-postgres-scale';
    const claim = 'indexed withdrawal needle sentinel';
    try {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.executeRaw(`ALTER TABLE pages DISABLE TRIGGER USER`);
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter,search_vector)
        SELECT $1,'notes/scale-'||n,'note','Scale '||n,replace($2,'__N__',n::text),'','{}'::jsonb,
          to_tsvector('english','Scale '||n) FROM generate_series(1,5000) n`,
      [sourceId, renderFactsTable([{ rowNum: 1, claim: 'unrelated fence __N__', kind: 'fact', confidence: 1,
        visibility: 'world', notability: 'medium', active: true }])]);
      await engine.executeRaw(`ALTER TABLE pages ENABLE TRIGGER USER`);
      await engine.executeRaw(`ALTER TABLE content_chunks DISABLE TRIGGER USER`);
      await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source,search_vector)
        SELECT p.id,n,CASE WHEN p.slug='notes/scale-4999' AND n=0 THEN $2 ELSE 'unrelated filler '||p.slug||' '||n END,
          'compiled_truth',to_tsvector('english',CASE WHEN p.slug='notes/scale-4999' AND n=0 THEN $2 ELSE 'unrelated filler '||p.slug||' '||n END)
        FROM pages p CROSS JOIN generate_series(0,2) n WHERE p.source_id=$1`, [sourceId, claim]);
      await engine.executeRaw(`ALTER TABLE content_chunks ENABLE TRIGGER USER`);
      const [unrelatedBefore] = await engine.executeRaw<{ knowledge_revision: string }>(
        `SELECT knowledge_revision FROM pages WHERE source_id=$1 AND slug='notes/scale-1'`, [sourceId]);
      const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: sourceId });

      const started = performance.now();
      const result = await engine.transaction(async tx => {
        await tx.executeRaw(`SELECT set_config('statement_timeout','5000ms',true)`);
        return recordFactWithdrawal(tx, stored.id, sourceId, true);
      });

      expect(performance.now() - started).toBeLessThan(5000);
      expect(result.pages.map(page => page.slug)).toEqual(['notes/scale-4999']);
      const [unrelatedAfter] = await engine.executeRaw<{ knowledge_revision: string }>(
        `SELECT knowledge_revision FROM pages WHERE source_id=$1 AND slug='notes/scale-1'`, [sourceId]);
      expect(unrelatedAfter.knowledge_revision).toBe(unrelatedBefore.knowledge_revision);
      expect(await engine.executeRaw(`SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id
        WHERE p.source_id=$1 AND p.slug='notes/scale-4999'`, [sourceId])).toEqual([]);

      const stopwordClaim = 'not now';
      const privateFence = renderFactsTable([{ rowNum: 1, claim: stopwordClaim, kind: 'fact', confidence: 1,
        visibility: 'private', notability: 'medium', active: true }]);
      await engine.executeRaw(`UPDATE pages SET compiled_truth=$3 WHERE source_id=$1 AND slug=$2`,
        [sourceId, 'notes/scale-4998', privateFence]);
      const privateFact = await engine.insertFact({ fact: stopwordClaim, source: 'test', visibility: 'private' },
        { source_id: sourceId });
      const stopwordStarted = performance.now();
      const stopwordResult = await engine.transaction(async tx => {
        await tx.executeRaw(`SELECT set_config('statement_timeout','5000ms',true)`);
        return recordFactWithdrawal(tx, privateFact.id, sourceId, false);
      });
      expect(performance.now() - stopwordStarted).toBeLessThan(5000);
      expect(stopwordResult.pages.map(page => page.slug)).toEqual(['notes/scale-4998']);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
