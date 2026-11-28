/**
 * GST-4049: consolidation places a fact with no event date (valid_from NULL, #10288) in its cluster's valid_until chain
 * at its save time, under three constraints designed together:
 *  1. an undated fact (say, extracted today from an old document) never ends a dated one at its save time;
 *  2. a close never moves an expiry a fact already carries (remember --ttl) later: LEAST(valid_until, successor);
 *  3. closes keep the successor's full precision and ids are read as bigint;
 *  4. one batch of facts shares a single save time, so an undated fact is ended only by a member strictly after it,
 *     and undated facts never form a same-instant tie that holds their cluster.
 * Unmanaged writer and managed preparer; synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { consolidationCloses } from '../src/core/persistence/prepared-maintenance.ts';
import { operationsByName } from '../src/core/operations.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'companies/chain-example';
const VECTOR = '[' + [1, ...Array(1535).fill(0)].join(',') + ']';
const DEPOSIT = { metric: 'deposit_amount', unit: 'USD', period: 'total' };
const HEADCOUNT = { metric: 'headcount', unit: 'people', period: 'total' };

interface Seed { fact: string; value: number; claim?: typeof DEPOSIT; validFrom?: string | null; createdAt?: string; validUntil?: string; id?: number }

/** One typed, embedded fact; validFrom null is an undated fact saved at createdAt. */
async function seed(engine: BrainEngine, s: Seed): Promise<number> {
  const claim = s.claim ?? DEPOSIT;
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts(${s.id ? 'id,' : ''}source_id,entity_slug,fact,kind,source,visibility,valid_from,valid_until,created_at,confidence,embedding,embedded_at,
       embedding_model,embedded_text_hash,claim_metric,claim_unit,claim_period,claim_value)
     VALUES(${s.id ? '$11,' : ''}'default',$1,$2,'fact','synthetic fixture','world',$3::timestamptz,$4::timestamptz,COALESCE($5::timestamptz,now()),1,$6::vector,now(),
       'openai:text-embedding-3-large',md5($2),$7,$8,$9,$10) RETURNING id`,
    [SLUG, s.fact, s.validFrom === undefined ? '2026-01-01T00:00:00Z' : s.validFrom, s.validUntil ?? null, s.createdAt ?? null, VECTOR,
      claim.metric, claim.unit, claim.period, s.value, ...(s.id ? [s.id] : [])]);
  return Number(row!.id);
}

const state = async (engine: BrainEngine, id: number) => (await engine.executeRaw<{ valid_until: string | null; created_at: string; consolidated: boolean }>(
  'SELECT valid_until::text AS valid_until, created_at::text AS created_at, consolidated_at IS NOT NULL AS consolidated FROM facts WHERE id=$1', [id]))[0]!;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => resetGateway());

test('constraint 4 on the shared close rule: members at one save time end each other only when both are dated', () => {
  const claim = (m: { text: string; dated: boolean }) => ({ text: m.text, value: null, at: 1_000, dated: m.dated });
  expect(consolidationCloses([{ text: 'a', dated: false }, { text: 'b', dated: false }], claim)).toEqual([]);
  expect(consolidationCloses([{ text: 'a', dated: false }, { text: 'b', dated: true }], claim)).toEqual([]);
  expect(consolidationCloses([{ text: 'a', dated: true }, { text: 'b', dated: true }], claim).map(c => c.member.text)).toEqual(['a']);
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`GST-4049 undated facts in the consolidation chain (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM facts');
      await engine.executeRaw('DELETE FROM takes');
      await engine.executeRaw(`INSERT INTO pages(slug,type,title) VALUES('${SLUG}','company','Chain Example') ON CONFLICT DO NOTHING`);
    });

    test('an undated fact takes its place at its save time, and its close keeps the successor\'s microseconds', async () => {
      const first = await seed(engine, { fact: 'The deposit amount is $100,000.', value: 100000, validFrom: null, createdAt: '2026-01-01T00:00:00.123456Z' });
      const second = await seed(engine, { fact: 'The deposit amount is $90,000.', value: 90000, validFrom: null, createdAt: '2026-01-02T00:00:00.654321Z' });
      await seed(engine, { fact: 'The deposit amount is $82,000.', value: 82000, validFrom: '2026-01-03T00:00:00Z' });
      const result = await runPhaseConsolidate(engine, { sourceId: 'default' });
      expect(result.details.facts_consolidated).toBe(3);
      expect((await state(engine, first)).valid_until).toBe((await state(engine, second)).created_at);
      expect(Date.parse((await state(engine, second)).valid_until!)).toBe(Date.parse('2026-01-03T00:00:00Z'));
    });

    test('constraint 1: an undated fact saved today never ends a dated value at today\'s save time', async () => {
      const older = await seed(engine, { fact: 'The deposit amount is $120,000.', value: 120000, validFrom: '2025-12-01T00:00:00Z' });
      const current = await seed(engine, { fact: 'The deposit amount is $100,000.', value: 100000, validFrom: '2026-01-01T00:00:00Z' });
      const fromOldDocument = await seed(engine, { fact: 'The deposit amount is $82,000.', value: 82000, validFrom: null });
      const result = await runPhaseConsolidate(engine, { sourceId: 'default' });
      expect(result.details.facts_consolidated).toBe(3);
      expect(Date.parse((await state(engine, older)).valid_until!)).toBe(Date.parse('2026-01-01T00:00:00Z'));
      expect((await state(engine, current)).valid_until).toBeNull();
      expect((await state(engine, fromOldDocument)).valid_until).toBeNull();
    });

    test('constraint 2: a later successor never extends a remember --ttl expiry', async () => {
      const ttl = inDays(1);
      const expiring = await seed(engine, { fact: 'The deposit amount is $100,000.', value: 100000, validFrom: '2026-01-01T00:00:00Z', validUntil: ttl });
      await seed(engine, { fact: 'The deposit amount is $90,000.', value: 90000, validFrom: inDays(30) });
      await seed(engine, { fact: 'The team has 12 people.', value: 12, claim: HEADCOUNT });
      await runPhaseConsolidate(engine, { sourceId: 'default' });
      expect((await state(engine, expiring)).consolidated).toBe(true);
      expect(Date.parse((await state(engine, expiring)).valid_until!)).toBe(Date.parse(ttl));
    });

    test('constraint 4: two typed undated claims saved in one batch both stay current, and the cluster is not held', async () => {
      const at = '2026-01-01T00:00:00.5Z';
      const a = await seed(engine, { fact: 'The deposit amount is $100,000.', value: 100000, validFrom: null, createdAt: at });
      const b = await seed(engine, { fact: 'The deposit amount is $82,000.', value: 82000, validFrom: null, createdAt: at });
      await seed(engine, { fact: 'The team has 12 people.', value: 12, claim: HEADCOUNT });
      const result = await runPhaseConsolidate(engine, { sourceId: 'default' });
      expect(result.details.clusters_held_same_instant).toBe(0);
      for (const id of [a, b]) expect(await state(engine, id)).toMatchObject({ valid_until: null, consolidated: true });
    });

    test('constraint 4: untyped undated facts saved in one transaction are never expired at their own save time', async () => {
      const ids = await engine.transaction(async tx => {
        const insert = (fact: string) => tx.executeRaw<{ id: number }>(
          `INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,valid_from,confidence,embedding,embedded_at,embedding_model,embedded_text_hash)
           VALUES('default',$1,$2,'fact','synthetic fixture','world',NULL,1,$3::vector,now(),'openai:text-embedding-3-large',md5($2)) RETURNING id`, [SLUG, fact, VECTOR]);
        return [Number((await insert('Chain Example ships from a warehouse in Ohio.'))[0]!.id), Number((await insert('Chain Example ships orders from Ohio.'))[0]!.id)];
      });
      expect((await state(engine, ids[0]!)).created_at).toBe((await state(engine, ids[1]!)).created_at);
      const result = await runPhaseConsolidate(engine, { sourceId: 'default', minOldestAgeMs: 0, minFactsPerBucket: 2 });
      expect(result.details.facts_consolidated).toBe(2);
      for (const id of ids) expect(await state(engine, id)).toMatchObject({ valid_until: null, consolidated: true });
    });
  });

  describe(`GST-4049 undated facts in the managed consolidation chain (${backend})`, () => {
    test('the preparer reads bigint ids, keeps a --ttl expiry and closes an undated fact at its successor\'s exact save time', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await operationsByName.put_page.handler(ctx, { slug: SLUG, content: '---\ntitle: Chain Example\ntype: company\n---\n\n# Chain Example\n' });
        await settleManagedGitEffects(engine);
        const ttl = inDays(1);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        let expiring: number, first: number, second: number;
        try {
          expiring = await seed(engine, { id: 3_000_000_001, fact: 'The deposit amount is $100,000.', value: 100000, validFrom: '2026-01-01T00:00:00Z', validUntil: ttl });
          await seed(engine, { id: 3_000_000_002, fact: 'The deposit amount is $90,000.', value: 90000, validFrom: inDays(30) });
          first = await seed(engine, { id: 3_000_000_003, fact: 'The team has 12 people.', value: 12, claim: HEADCOUNT, validFrom: null, createdAt: '2026-01-01T00:00:00.123456Z' });
          second = await seed(engine, { id: 3_000_000_004, fact: 'The team has 15 people.', value: 15, claim: HEADCOUNT, validFrom: null, createdAt: '2026-01-02T00:00:00.654321Z' });
        } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
        const result = await runPhaseConsolidate(engine, { sourceId: 'default', minOldestAgeMs: 0 });
        await settleManagedGitEffects(engine);
        expect(result.details.buckets_failed).toBe(0);
        expect(result.details.facts_consolidated).toBe(4);
        expect(Date.parse((await state(engine, expiring!)).valid_until!)).toBe(Date.parse(ttl));
        expect((await state(engine, first!)).valid_until).toBe((await state(engine, second!)).created_at);
        expect((await state(engine, second!)).valid_until).toBeNull();
      }, { databaseUrl });
    }, 120_000);
  });

  describe(`GST-4049 fence closes keep their precision (${backend})`, () => {
    test('a fenced fact closed at a successor inside the same second keeps the milliseconds, so it never ends before it began', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const row = (rowNum: number, claim: string, value: number, validFrom: string, metric = DEPOSIT) => ({ rowNum, claim, kind: 'fact', confidence: 1,
          visibility: 'world', notability: 'medium', validFrom, source: 'synthetic fixture', active: true,
          claimMetric: metric.metric, claimValue: value, claimUnit: metric.unit, claimPeriod: metric.period }) as ParsedFact;
        const table = renderFactsTable([row(1, 'The deposit amount is $100,000.', 100000, '2026-01-01T00:00:00.250Z'),
          row(2, 'The deposit amount is $82,000.', 82000, '2026-01-01T00:00:00.750Z'), row(3, 'The team has 12 people.', 12, '2026-01-01', HEADCOUNT)]);
        await operationsByName.put_page.handler(ctx, { slug: SLUG, content: `---\ntitle: Chain Example\ntype: company\n---\n\n# Chain Example\n\n## Facts\n\n${table}\n` });
        await settleManagedGitEffects(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        try {
          await engine.executeRaw(`UPDATE facts SET embedding=$1::vector, embedded_at=now(), embedding_model='openai:text-embedding-3-large', embedded_text_hash=md5(fact)
            WHERE entity_slug=$2`, [VECTOR, SLUG]);
        } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
        const result = await runPhaseConsolidate(engine, { sourceId: 'default', minOldestAgeMs: 0 });
        await settleManagedGitEffects(engine);
        expect(result.details.buckets_failed).toBe(0);
        const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [SLUG]);
        expect(parseFactsFence(page!.compiled_truth).facts.find(f => f.rowNum === 1)!.validUntil).toBe('2026-01-01T00:00:00.750Z');
        const [fact] = await engine.executeRaw<{ valid_from: string; valid_until: string }>(
          'SELECT valid_from::text AS valid_from, valid_until::text AS valid_until FROM facts WHERE entity_slug=$1 AND row_num=1 AND expired_at IS NULL', [SLUG]);
        expect(Date.parse(fact!.valid_until)).toBe(Date.parse('2026-01-01T00:00:00.750Z'));
        expect(Date.parse(fact!.valid_until)).toBeGreaterThan(Date.parse(fact!.valid_from));
      }, { databaseUrl });
    }, 120_000);
  });
}
