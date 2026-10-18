/**
 * #6023 — consolidate no longer merges unrelated untyped event facts.
 *
 * Protects: two untyped facts that differ in a date, number or amount token
 * ("Invoice A due Monday" / "Invoice B due Tuesday", "$100,000" / "$82,000")
 * never share a take, however close their embeddings, and the losing fact's
 * `valid_until` is never overwritten; untyped facts need the explicit
 * duplicate bar (0.95) while typed metric facts keep the configured
 * threshold; a dry run lists the clusters it would write with private text
 * only for the local CLI.
 * Fails when: `clusterFacts` clusters untyped facts on cosine alone at the
 * configured threshold, or the dry-run envelope carries no cluster preview.
 * Seams: none. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { claimsDiverge } from '../src/core/facts/capture-dedup.ts';
import { BEHAVIOR_CHANGES } from '../src/core/behavior-change-notice.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const oldDate = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

/** Unit vector at cosine `c` from e0. */
function vecAt(c: number): string {
  const a = new Float32Array(1536);
  a[0] = c;
  a[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return '[' + Array.from(a).join(',') + ']';
}

async function seedPage(engine: BrainEngine, slug: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO pages (slug, type, title) VALUES ($1, 'company', 'Test') ON CONFLICT DO NOTHING`, [slug]);
}

async function seedFact(engine: BrainEngine, slug: string, text: string, vec: string, hoursAgo: number,
  opts: { claim?: { metric: string; unit?: string; period?: string }; visibility?: string } = {}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, valid_from, embedding, embedded_at, embedding_model, embedded_text_hash,
                        claim_metric, claim_unit, claim_period, claim_value)
     VALUES ('default', $1, $2, 'fact', 'test', $9, $3::timestamptz, $4::vector, $3::timestamptz, 'openai:text-embedding-3-large', md5($2),
             $5, $6, $7, $8)
     RETURNING id`,
    [slug, text, oldDate(hoursAgo), vec, opts.claim?.metric ?? null, opts.claim?.unit ?? null, opts.claim?.period ?? null, opts.claim ? 1000 : null, opts.visibility ?? 'world'],
  );
  return Number(rows[0].id);
}

async function factState(engine: BrainEngine): Promise<Array<{ id: number; consolidated: boolean; valid_until: string | null }>> {
  const rows = await engine.executeRaw<{ id: number; consolidated_at: Date | null; valid_until: Date | null }>(
    `SELECT id, consolidated_at, valid_until FROM facts ORDER BY id`);
  return rows.map(r => ({ id: Number(r.id), consolidated: r.consolidated_at !== null, valid_until: r.valid_until ? new Date(r.valid_until).toISOString() : null }));
}

for (const backend of testBackends()) {
  describe(`${backend}: #6023 untyped divergence guard`, () => {
    let engine: BrainEngine;

    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
      await engine.initSchema();
    }, 180_000);

    afterAll(async () => {
      resetGateway();
      await engine.disconnect();
    });

    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM facts`);
      await engine.executeRaw(`DELETE FROM takes`);
      await engine.executeRaw(`DELETE FROM config WHERE key = 'cycle.consolidate.cluster_threshold'`);
    });

    test('the issue fixtures stay apart at cosine 0.90 and no valid_until is written', async () => {
      await seedPage(engine, 'acme-example');
      await seedFact(engine, 'acme-example', 'Invoice A is due Monday', vecAt(1), 40);
      await seedFact(engine, 'acme-example', 'Invoice B is due Tuesday', vecAt(0.9), 39);
      await seedFact(engine, 'acme-example', 'The deposit was $100,000', vecAt(1), 38);
      await seedFact(engine, 'acme-example', 'The deposit was $82,000', vecAt(0.9), 37);
      expect(claimsDiverge('Invoice A is due Monday', 'Invoice B is due Tuesday')).toBe(true);
      expect(claimsDiverge('The deposit was $100,000', 'The deposit was $82,000')).toBe(true);

      const r = await runPhaseConsolidate(engine, {});
      expect(r.details.facts_consolidated).toBe(0);
      expect(r.details.takes_written).toBe(0);
      expect(r.details.untyped_cluster_threshold).toBe(0.95);
      expect((await factState(engine)).map(f => [f.consolidated, f.valid_until])).toEqual([[false, null], [false, null], [false, null], [false, null]]);
    });

    test('a known miss is honest: Lisbon/Porto do not diverge by token, so only the 0.95 bar keeps them apart', async () => {
      expect(claimsDiverge('The office moved to Lisbon', 'The office moved to Porto')).toBe(false);
      await seedPage(engine, 'acme-example');
      await seedFact(engine, 'acme-example', 'The office moved to Lisbon', vecAt(1), 40);
      await seedFact(engine, 'acme-example', 'The office moved to Porto', vecAt(0.9), 39);
      await seedFact(engine, 'acme-example', 'acme was founded in a garage', vecAt(0), 38);
      const below = await runPhaseConsolidate(engine, {});
      expect(below.details.facts_consolidated).toBe(0);

      await engine.executeRaw(`DELETE FROM facts`);
      await seedFact(engine, 'acme-example', 'The office moved to Lisbon', vecAt(1), 40);
      await seedFact(engine, 'acme-example', 'The office moved to Porto', vecAt(0.96), 39);
      await seedFact(engine, 'acme-example', 'acme was founded in a garage', vecAt(0), 38);
      const above = await runPhaseConsolidate(engine, {});
      expect(above.details.facts_consolidated).toBe(2);
      expect(above.details.takes_written).toBe(1);
    });

    test('untyped facts ignore a lowered cluster_threshold; typed facts at 0.90 still cluster when compatible', async () => {
      await engine.setConfig('cycle.consolidate.cluster_threshold', '0.75');
      await seedPage(engine, 'acme-example');
      await seedFact(engine, 'acme-example', 'acme ships weekly', vecAt(1), 40);
      await seedFact(engine, 'acme-example', 'acme releases every week', vecAt(0.9), 39);
      await seedFact(engine, 'acme-example', 'acme was founded in a garage', vecAt(0), 38);
      const untyped = await runPhaseConsolidate(engine, {});
      expect(untyped.details.cluster_threshold).toBe(0.75);
      expect(untyped.details.untyped_cluster_threshold).toBe(0.95);
      expect(untyped.details.facts_consolidated).toBe(0);

      await engine.executeRaw(`DELETE FROM facts`);
      await seedFact(engine, 'acme-example', 'acme mrr is 1000', vecAt(1), 40, { claim: { metric: 'mrr', unit: 'USD', period: 'monthly' } });
      await seedFact(engine, 'acme-example', 'acme mrr is 1200', vecAt(0.9), 39, { claim: { metric: 'mrr', unit: 'USD', period: 'monthly' } });
      await seedFact(engine, 'acme-example', 'acme was founded in a garage', vecAt(0), 38);
      const typed = await runPhaseConsolidate(engine, {});
      expect(typed.details.facts_consolidated).toBe(2);
      expect(typed.details.takes_written).toBe(1);
      const state = await factState(engine);
      expect(state[0]!.valid_until).not.toBeNull();
      expect(state[1]!.valid_until).toBeNull();
    });

    test('a dry run lists the clusters it would write, private text only for the local CLI', async () => {
      await seedPage(engine, 'acme-example');
      const a = await seedFact(engine, 'acme-example', 'acme ships weekly', vecAt(1), 40, { visibility: 'private' });
      const b = await seedFact(engine, 'acme-example', 'acme ships weekly', vecAt(0.99), 39);
      await seedFact(engine, 'acme-example', 'acme was founded in a garage', vecAt(0), 38);

      const remote = await runPhaseConsolidate(engine, { dryRun: true });
      expect(remote.details.takes_written).toBe(1);
      expect(remote.details.clusters).toEqual([{
        source_id: 'default', entity_slug: 'acme-example', claim: 'acme ships weekly',
        members: [{ id: b, visibility: 'world', fact: 'acme ships weekly' }, { id: a, visibility: 'private', fact: null }],
      }]);
      expect(JSON.stringify(remote.details.clusters)).not.toContain(`"id":${a},"visibility":"private","fact":"acme`);

      const local = await runPhaseConsolidate(engine, { dryRun: true, remote: false });
      expect(local.details.clusters).toEqual([{
        source_id: 'default', entity_slug: 'acme-example', claim: 'acme ships weekly',
        members: [{ id: b, visibility: 'world', fact: 'acme ships weekly' }, { id: a, visibility: 'private', fact: 'acme ships weekly' }],
      }]);
      expect((await factState(engine)).every(f => !f.consolidated && f.valid_until === null)).toBe(true);
      const applied = await runPhaseConsolidate(engine, {});
      expect(applied.details.clusters).toBeUndefined();
    });
  });
}

test('the behavior notice says previous intervals were not retained', () => {
  const row = BEHAVIOR_CHANGES.find(c => typeof c.text === 'string' && c.text.includes('`consolidate` phase no longer merges'));
  expect(row).toBeDefined();
  expect(String(row!.text)).toContain('previous intervals were not retained');
  expect(String(row!.text)).toContain('no exact undo');
});
