/**
 * #6960: the fact-embedding eligibility predicate's withdrawal anti-join.
 * `fact_hash IN (fp, fp_v1)` kept both fingerprints in the hash join's filter,
 * so each was recomputed for every (fact, withdrawal) pair: 16 s on a brain with
 * a few hundred '*' withdrawals. One NOT EXISTS per fingerprint makes fact_hash a
 * join key (Hash Cond or Index Cond), computed once per fact. The counts must not
 * change. Both backends (Postgres through the e2e twin).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { retainedFactEmbedding } from '../src/core/facts/embedding-identity.ts';
import { AUDIT_ROW_SOURCES } from '../src/core/facts/audit-sources.ts';
import { testBackends } from './helpers/test-backends.ts';

const SOURCE = 'withdrawal-6960';
const LEGACY_RETAINED = `f.expired_at IS NULL AND f.superseded_by IS NULL
  AND (f.valid_until IS NULL OR f.valid_until>now())
  AND NOT (f.source = ANY($2::text[]))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND (w.subject = '*' OR w.subject = f.entity_slug)
    AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v1(f.fact)))`;

for (const backend of testBackends()) describe(`fact embedding withdrawal anti-join (${backend})`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const { setupDB, getEngine } = await import('./e2e/helpers.ts');
      await setupDB();
      engine = getEngine();
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('${SOURCE}', '${SOURCE}') ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, source, entity_slug, visibility)
      SELECT $1, 'Claim number ' || g || '.', 'fact', 'test', 'people/alice-example-' || (g % 20),
             CASE WHEN g % 2 = 0 THEN 'world' ELSE 'private' END
        FROM generate_series(1, 400) g`, [SOURCE]);
    // Noise: '*' withdrawals that match nothing, the shape that made the old plan quadratic.
    await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
      SELECT $1, CASE WHEN g % 2 = 0 THEN 'world' ELSE 'private' END, '*', md5(g::text)
        FROM generate_series(1, 300) g`, [SOURCE]);
    // Real withdrawals: current fingerprint source-wide, v1 fingerprint source-wide, a
    // subject-scoped one that matches, one scoped to another subject, one in the other visibility.
    await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
      SELECT $1, f.visibility, w.subject, w.fp FROM facts f
        CROSS JOIN LATERAL (VALUES
          (f.fact = 'Claim number 2.', '*', gbrain_fact_fingerprint(f.fact)),
          (f.fact = 'Claim number 4.', '*', gbrain_fact_fingerprint_v1(f.fact)),
          (f.fact = 'Claim number 6.', f.entity_slug, gbrain_fact_fingerprint(f.fact)),
          (f.fact = 'Claim number 8.', 'people/someone-else-example', gbrain_fact_fingerprint(f.fact)),
          (f.fact = 'Claim number 10.', '*', gbrain_fact_fingerprint_v1(f.fact))
        ) AS w(hit, subject, fp)
       WHERE f.source_id = $1 AND w.hit`, [SOURCE]);
    await engine.executeRaw(`UPDATE fact_withdrawals SET visibility = 'private' WHERE source_id = $1
      AND fact_hash = (SELECT gbrain_fact_fingerprint_v1(fact) FROM facts WHERE source_id = $1 AND fact = 'Claim number 10.')`, [SOURCE]);
    await engine.executeRaw('ANALYZE facts');
    await engine.executeRaw('ANALYZE fact_withdrawals');
  }, 120_000);
  afterAll(async () => {
    if (backend === 'postgres') {
      const { teardownDB } = await import('./e2e/helpers.ts');
      await teardownDB();
    } else await engine?.disconnect();
  });

  const count = async (predicate: string) => (await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts f WHERE f.source_id = $1 AND ${predicate}`, [SOURCE, [...AUDIT_ROW_SOURCES]]))[0].n;

  test('withdrawn facts are excluded exactly as before', async () => {
    // 400 facts minus claims 2, 4 and 6; claim 8's withdrawal names another subject, claim 10's another visibility.
    expect(await count(retainedFactEmbedding)).toBe(397);
    expect(await count(retainedFactEmbedding)).toBe(await count(LEGACY_RETAINED));
  });

  test('fact_hash is a join key, never only a per-pair filter', async () => {
    const plan = (await engine.executeRaw<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) SELECT count(*) FROM facts f WHERE f.source_id = $1 AND ${retainedFactEmbedding}`,
      [SOURCE, [...AUDIT_ROW_SOURCES]])).map(r => r['QUERY PLAN']);
    const lines = plan.filter(l => l.includes('fact_hash'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.trim()).toMatch(/^(Hash Cond|Index Cond|Merge Cond):/);
  });

  test('on the primary-key path, fact_hash is part of the Index Cond', async () => {
    const plan = await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL enable_hashjoin = off');
      await tx.executeRaw('SET LOCAL enable_mergejoin = off');
      return (await tx.executeRaw<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT count(*) FROM facts f WHERE f.source_id = $1 AND ${retainedFactEmbedding}`,
        [SOURCE, [...AUDIT_ROW_SOURCES]])).map(r => r['QUERY PLAN']);
    });
    const conds = plan.filter(l => l.trim().startsWith('Index Cond:') && l.includes('fact_hash'));
    expect(conds.map(l => /fact_hash = gbrain_fact_fingerprint(_v1)?\(f\.fact\)/.test(l))).toEqual([true, true]);
  });
});
