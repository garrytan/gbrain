/**
 * #6721: the saved-fact match `search` and `query` run on every call is
 * served by idx_facts_match_trgm (migration v246) instead of a scan of every
 * fact row.
 *
 * 1. Protects: the planner can answer the match predicate from the index, and
 *    the match still returns the same saved fact on a remote search.
 * 2. Fails when: the migration stops creating the index, or the query's match
 *    expression drifts from the indexed one (the index silently goes unused).
 * 3. Existing coverage: test/search-other-names.test.ts checks the saved-fact
 *    block's content, not how the statement is planned.
 * 4. Seam: none. The expression is the one the production statement uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { SAVED_FACT_HAYSTACK_SQL } from '../src/core/ops/search.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES
    ('default', 'widget-co', 'Widget-co moved its renewal date to March.', 'fact', 'world', 'user update')`);
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
});

describe('idx_facts_match_trgm', () => {
  test('the saved-fact match predicate is answered from the index', async () => {
    // With one row a scan or another facts index is always cheapest, so ask the narrower question: with
    // scans off and the other facts indexes dropped (rolled back below), can the predicate use this index?
    const rollback = new Error('rollback');
    let plan: Array<Record<string, string>> = [];
    await engine.transaction(async tx => {
      const others = await tx.executeRaw<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'facts' AND indexname NOT IN ('idx_facts_match_trgm', 'facts_pkey')`);
      for (const { indexname } of others) await tx.executeRaw(`DROP INDEX ${indexname}`);
      await tx.executeRaw('SET LOCAL enable_seqscan = off');
      await tx.executeRaw('SET LOCAL enable_indexscan = off');
      plan = await tx.executeRaw<Record<string, string>>(
        `EXPLAIN SELECT f.id FROM facts f
          WHERE f.expired_at IS NULL AND ${SAVED_FACT_HAYSTACK_SQL} LIKE ANY($1::text[])`,
        [['%renewal%', '%march%']]);
      throw rollback;
    }).catch(error => { if (error !== rollback) throw error; });
    const text = plan.map(row => Object.values(row)[0]).join('\n');
    expect(text).toContain('Bitmap Index Scan on idx_facts_match_trgm');
    const [kept] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'facts'`);
    expect(kept.n).toBeGreaterThan(2);
  });

  test('a remote search still returns the matching saved fact', async () => {
    const r = await dispatchToolCall(engine, 'search', { query: 'widget-co renewal date' }, { remote: true, transport: 'http', sourceId: 'default' });
    expect(r.isError).toBeFalsy();
    const extra = r.content.slice(1).map(c => c.text ?? '').join('\n');
    expect(extra).toContain('Widget-co moved its renewal date to March.');
  });
});
