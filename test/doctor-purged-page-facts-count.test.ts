/**
 * Doctor `purged_page_facts` counts what the repair would list, and stays cheap on a healthy brain.
 *
 * Protects: `countPurgedPageFacts` (the doctor count) returns the same evidenced and ambiguous totals as
 * `classifyPurgedPageFacts` (the repair preview) for every candidate class: a purged page's fact, a root slug the
 * purge ledger records, a page gone with no purge record, a fact newer than its slug's purge, and each exclusion
 * (withdrawn, superseded, named in another fact's superseded_by, referenced by an open loop); never a live page's fact,
 * a non-extraction fact, an expired or filed fact, or an unrecorded root slug. With no candidate it reports zero, and
 * past the cap it reports `capped`. On a brain whose every fact has its page, the withdrawal check (two fingerprints
 * per row) runs zero times, measured from EXPLAIN (ANALYZE, FORMAT JSON) on PGLite and Postgres.
 * Regression it catches: the exclusions evaluated on every active fact before the gone-page test, so the check grows
 * with the brain and passes its time budget. No wall-clock thresholds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyPurgedPageFacts, countPurgedPageFacts } from '../src/core/repair/purged-page-facts.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const FILLER = 3_000;
type PlanNode = { 'Relation Name'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] };

function loopsOn(node: PlanNode, relation: string): number {
  return (node['Relation Name'] === relation ? node['Actual Loops'] ?? 0 : 0) + (node.Plans ?? []).reduce((sum, child) => sum + loopsOn(child, relation), 0);
}

/** Rows as an older gbrain left them: written under replica role, so no current writer guard applies. */
const legacy = <T>(engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(async tx => {
  await tx.executeRaw('SET LOCAL session_replication_role = replica');
  return tx.executeRaw<T>(sql, params);
});

async function fact(engine: BrainEngine, source: string, context: string, opts: { text?: string; via?: string; age?: string; superseded_by?: number; filed?: string; expired?: boolean } = {}) {
  const [row] = await legacy<{ id: number }>(engine, `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, context, valid_from, superseded_by,
      source_markdown_slug, expired_at, created_at)
    VALUES ($1, NULL, $2, 'fact', 'private', 'high', $3, $4, now(), $5, $6, CASE WHEN $7 THEN now() END, now() - $8::interval) RETURNING id`,
    [source, opts.text ?? `An example claim about ${context}`, opts.via ?? 'mcp:put_page', context, opts.superseded_by ?? null, opts.filed ?? null, opts.expired === true, opts.age ?? '3 days']);
  return Number(row!.id);
}

const purgeRecord = (engine: BrainEngine, source: string, slug: string, hash: string) =>
  legacy(engine, "INSERT INTO page_purges (source_id, content_hash, slug, purged_at) VALUES ($1, $2, $3, now() - interval '1 day')", [source, hash, slug]);

async function parity(engine: BrainEngine, source: string, cap = 10_000) {
  const counted = await countPurgedPageFacts(engine, [source], cap);
  const listed = await classifyPurgedPageFacts(engine, [source]);
  expect({ evidenced: counted.evidenced, ambiguous: counted.ambiguous })
    .toEqual({ evidenced: listed.filter(f => f.class === 'evidenced').length, ambiguous: listed.filter(f => f.class === 'ambiguous').length });
  return { counted, listed };
}

for (const kind of testBackends()) {
  describe(`doctor purged_page_facts count (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      for (const id of ['source-a', 'source-b', 'source-c', 'source-d']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
    }, 240_000);
    afterAll(async () => { await close?.(); });

    test('every candidate class and every exclusion: the count equals the repair listing', async () => {
      const S = 'source-a';
      await engine.executeRaw("INSERT INTO pages (source_id, slug, type, title) VALUES ($1, 'notes/live-example', 'note', 'Live')", [S]);
      await purgeRecord(engine, S, 'atoms/purged-example', '1'.repeat(64));
      await purgeRecord(engine, S, 'rootexample', '2'.repeat(64));
      await purgeRecord(engine, S, 'notes/reused-example', '3'.repeat(64));
      const purged = await fact(engine, S, 'atoms/purged-example');
      const noted = await fact(engine, S, 'atoms/purged-example — entity inferred from text', { text: 'A second example claim' });
      const root = await fact(engine, S, 'rootexample');
      const gone = await fact(engine, S, 'meetings/gone-example');
      const reused = await fact(engine, S, 'notes/reused-example', { age: '0 days' });
      const withdrawn = await fact(engine, S, 'atoms/purged-example', { text: 'A withdrawn example claim' });
      await legacy(engine, "INSERT INTO fact_withdrawals (source_id, visibility, fact_hash) VALUES ($1, 'private', gbrain_fact_fingerprint($2))", [S, 'A withdrawn example claim']);
      const live = await fact(engine, S, 'notes/live-example');
      const superseded = await fact(engine, S, 'atoms/purged-example', { text: 'An older example claim', superseded_by: live });
      const referenced = await fact(engine, S, 'meetings/gone-example', { text: 'A replaced example claim' });
      await fact(engine, S, 'notes/live-example', { text: 'Its replacement', via: 'mcp:remember', superseded_by: referenced });
      const looped = await fact(engine, S, 'meetings/gone-example', { text: 'An example commitment' });
      await legacy(engine, `INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, detector, fact_id)
        VALUES ($1, 'example-loop', 'commitment_owed_by_me', 'An example commitment', 'manual', $2)`, [S, looped]);
      await fact(engine, S, 'atoms/purged-example', { text: 'A remembered example claim', via: 'mcp:remember' });
      await fact(engine, S, 'atoms/purged-example', { text: 'An expired example claim', expired: true });
      await fact(engine, S, 'atoms/purged-example', { text: 'A filed example claim', filed: 'atoms/purged-example' });
      await fact(engine, S, 'otherroot');

      const { counted, listed } = await parity(engine, S);
      expect(counted).toEqual({ evidenced: 3, ambiguous: 2, capped: false });
      expect(listed.map(f => [f.id, f.class === 'excluded' ? `excluded:${f.reason}` : f.class]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
        [purged, 'evidenced'], [noted, 'evidenced'], [root, 'evidenced'], [gone, 'ambiguous'], [reused, 'ambiguous'],
        [withdrawn, 'excluded:withdrawn'], [superseded, 'excluded:superseded'], [referenced, 'excluded:superseded_by_reference'],
        [looped, 'excluded:open_loop_reference']].sort((a, b) => Number(a[0]) - Number(b[0])));

      const capped = await countPurgedPageFacts(engine, [S], 2);
      expect(capped).toMatchObject({ capped: true });
      expect(capped.evidenced + capped.ambiguous).toBe(2);
    }, 120_000);

    test('zero candidates: a brain whose facts all have their page, and one whose gone-page facts are all excluded, count nothing', async () => {
      await engine.executeRaw("INSERT INTO pages (source_id, slug, type, title) VALUES ('source-b', 'notes/kept-example', 'note', 'Kept')");
      await fact(engine, 'source-b', 'notes/kept-example');
      expect((await parity(engine, 'source-b')).counted).toEqual({ evidenced: 0, ambiguous: 0, capped: false });
      expect(await classifyPurgedPageFacts(engine, ['source-b'])).toEqual([]);

      const keeper = await fact(engine, 'source-c', 'notes/kept-example', { via: 'mcp:remember' });
      await fact(engine, 'source-c', 'notes/gone-example', { superseded_by: keeper });
      const { counted, listed } = await parity(engine, 'source-c');
      expect(counted).toEqual({ evidenced: 0, ambiguous: 0, capped: false });
      expect(listed.map(f => f.reason)).toEqual(['superseded']);
    }, 120_000);

    test('a healthy brain: the withdrawal check runs on no fact', async () => {
      const S = 'source-d';
      await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title) SELECT $1, 'people/p-' || g, 'person', 'P ' || g FROM generate_series(1, $2::int) g`, [S, FILLER]);
      await legacy(engine, `INSERT INTO facts (source_id, fact, kind, visibility, notability, source, context, valid_from)
        SELECT $1, 'Example claim ' || g, 'fact', 'private', 'high', 'sync:import', 'people/p-' || g || ' — line ' || g, now() FROM generate_series(1, $2::int) g`, [S, FILLER]);
      await engine.executeRaw('ANALYZE facts');
      await engine.executeRaw('ANALYZE pages');
      const loops: number[] = [];
      const measured = new Proxy(engine, { get(target, key) {
        if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
          const [plan] = await target.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params, opts as never);
          const parsed = (typeof plan!['QUERY PLAN'] === 'string' ? JSON.parse(plan!['QUERY PLAN'] as string) : plan!['QUERY PLAN']) as Array<{ Plan: PlanNode }>;
          loops.push(loopsOn(parsed[0]!.Plan, 'fact_withdrawals'));
          return target.executeRaw(sql, params, opts as never);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      expect(await countPurgedPageFacts(measured, [S], 10_000)).toEqual({ evidenced: 0, ambiguous: 0, capped: false });
      expect(loops).toEqual([0]);
    }, 240_000);
  });
}
