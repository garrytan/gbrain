/**
 * #5363 (fix wave 9) — consolidate's cluster threshold is reachable through
 * `cycle.consolidate.cluster_threshold`, and typed claims only cluster with
 * the same metric, unit and period.
 *
 * Pre-fix `clusterThreshold` was never passed by cycle.ts and no config key
 * existed, so the 0.85 default was fixed; and facts with near-identical text
 * but a different period or unit (monthly vs annual MRR, USD vs EUR) merged
 * into one take.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { parseClusterThreshold, runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
  await engine.initSchema();
});

afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM takes`);
  await engine.executeRaw(`DELETE FROM config WHERE key = 'cycle.consolidate.cluster_threshold'`);
});

const oldDate = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

/** Unit vector at cosine `c` from e0. */
function vecAt(c: number): string {
  const a = new Float32Array(1536);
  a[0] = c;
  a[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return '[' + Array.from(a).join(',') + ']';
}

async function seedPage(slug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title) VALUES ($1, 'company', 'Test') ON CONFLICT DO NOTHING`,
    [slug],
  );
}

async function seedFact(slug: string, text: string, vec: string, hoursAgo: number, claim?: { metric: string; unit?: string; period?: string }): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at, embedding_model, embedded_text_hash,
                        claim_metric, claim_unit, claim_period, claim_value)
     VALUES ('default', $1, $2, 'fact', 'test', $3::timestamptz, $4::vector, $3::timestamptz, 'openai:text-embedding-3-large', md5($2),
             $5, $6, $7, $8)
     RETURNING id`,
    [slug, text, oldDate(hoursAgo), vec, claim?.metric ?? null, claim?.unit ?? null, claim?.period ?? null, claim ? 1000 : null],
  );
  return Number(rows[0].id);
}

async function consolidatedIds(): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE consolidated_at IS NOT NULL ORDER BY id`);
  return rows.map(r => Number(r.id));
}

describe('#5363 cluster threshold is configurable', () => {
  test('cycle.consolidate.cluster_threshold lowers the bar the phase actually uses', async () => {
    await seedPage('acme-example');
    await seedFact('acme-example', 'acme ships weekly', vecAt(1), 40);
    await seedFact('acme-example', 'acme releases every week', vecAt(0.8), 39);
    await seedFact('acme-example', 'acme was founded in 2020', vecAt(0), 38);

    const atDefault = await runPhaseConsolidate(engine, {});
    expect(atDefault.details.facts_consolidated).toBe(0);
    expect(atDefault.details.cluster_threshold).toBe(0.85);

    await engine.setConfig('cycle.consolidate.cluster_threshold', '0.75');
    const lowered = await runPhaseConsolidate(engine, {});
    expect(lowered.details.cluster_threshold).toBe(0.75);
    expect(lowered.details.facts_consolidated).toBe(2);
    expect(lowered.details.takes_written).toBe(1);
  });

  test('a malformed stored value keeps the default and is reported', async () => {
    await engine.setConfig('cycle.consolidate.cluster_threshold', 'lots');
    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.cluster_threshold).toBe(0.85);
    expect(r.details.cluster_threshold_invalid).toBe('lots');
  });

  test('parseClusterThreshold accepts (0, 1] and refuses the rest', () => {
    expect(parseClusterThreshold('0.9')).toBe(0.9);
    expect(parseClusterThreshold('1')).toBe(1);
    for (const bad of ['0', '-0.2', '1.5', 'abc', '', 'NaN']) {
      expect(() => parseClusterThreshold(bad)).toThrow(/cluster_threshold/);
    }
  });
});

describe('#5363 typed claims only cluster when metric, unit and period agree', () => {
  test('monthly vs annual, and USD vs EUR, never share a take even with identical embeddings', async () => {
    await seedPage('acme-example');
    await seedFact('acme-example', 'acme mrr is 1000', vecAt(1), 40, { metric: 'mrr', unit: 'USD', period: 'monthly' });
    await seedFact('acme-example', 'acme arr is 1000', vecAt(1), 39, { metric: 'mrr', unit: 'USD', period: 'annual' });
    await seedFact('acme-example', 'acme mrr is 1000 eur', vecAt(1), 38, { metric: 'mrr', unit: 'EUR', period: 'monthly' });
    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.takes_written).toBe(0);
    expect(await consolidatedIds()).toEqual([]);
  });

  test('a typed claim never clusters with untyped prose', async () => {
    await seedPage('acme-example');
    const typed = await seedFact('acme-example', 'acme revenue grew', vecAt(1), 40, { metric: 'mrr', unit: 'USD', period: 'monthly' });
    const proseA = await seedFact('acme-example', 'acme revenue is growing', vecAt(1), 39);
    const proseB = await seedFact('acme-example', 'acme revenue keeps growing', vecAt(1), 38);
    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.facts_consolidated).toBe(2);
    const done = await consolidatedIds();
    expect(done).toEqual([proseA, proseB].sort((a, b) => a - b));
    expect(done).not.toContain(typed);
  });

  test('successive compatible values still cluster', async () => {
    await seedPage('acme-example');
    await seedFact('acme-example', 'acme mrr is 1000', vecAt(1), 40, { metric: 'mrr', unit: 'USD', period: 'monthly' });
    await seedFact('acme-example', 'acme mrr is 1200', vecAt(1), 39, { metric: 'mrr', unit: 'USD', period: 'monthly' });
    await seedFact('acme-example', 'acme mrr is 1500', vecAt(1), 38, { metric: 'mrr', unit: 'USD', period: 'monthly' });
    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.facts_consolidated).toBe(3);
    expect(r.details.takes_written).toBe(1);
  });
});
