/**
 * #6023 residual: two typed claims with the same metric, unit and period at the
 * same effective instant. Confidence and row id cannot tell which statement
 * corrects the other, so consolidation used to promote the higher-confidence
 * one and give the other a zero-length validity interval: a real fact silently
 * marked superseded, with no exact undo. The cluster is now held unchanged and
 * reported with a count and an agent-actionable next step, on the unmanaged
 * writer, the managed submitter and the managed preparer of an already
 * admitted intent. `gbrain repair consolidate-ties` lists and, after a
 * preview, restores facts an earlier release closed this way.
 *
 * Reproduction reported on issue #6023 (in-memory PGLite, synthetic fixture).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { maintenancePreflight, submitMaintenanceConsolidation } from '../src/core/persistence/prepared-maintenance.ts';
import { resolveRepairScope, runRepair, type RepairHandler } from '../src/core/repair/core.ts';
import { operationsByName } from '../src/core/operations.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const AT = '2026-01-01T00:00:00Z';
const VECTOR = '[' + [1, ...Array(1535).fill(0)].join(',') + ']';
const DEPOSIT = { metric: 'deposit_amount', unit: 'USD', period: '2026-01-01' };
const ORIGINAL = 'The deposit amount was initially reported as $100,000.';
const CORRECTION = 'Correction: the deposit amount is $82,000, replacing the initially reported $100,000.';

async function seedTyped(engine: BrainEngine, slug: string, fact: string, confidence: number, value: number,
  at = AT, claim: { metric: string; unit: string; period: string } | null = DEPOSIT): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,valid_from,confidence,embedding,embedded_at,embedding_model,
       embedded_text_hash,claim_metric,claim_unit,claim_period,claim_value)
     VALUES('default',$1,$2,'fact','synthetic fixture','world',$3::timestamptz,$4,$5::vector,$3::timestamptz,'openai:text-embedding-3-large',md5($2),
       $6,$7,$8,$9) RETURNING id`,
    [slug, fact, at, confidence, VECTOR, claim?.metric ?? null, claim?.unit ?? null, claim?.period ?? null, claim ? value : null]);
  return Number(row.id);
}

/** The issue's fixture: the original and its correction at one instant, plus an unrelated unembedded fact for the bucket minimum. */
async function seedIssueFixture(engine: BrainEngine, slug: string): Promise<number[]> {
  const original = await seedTyped(engine, slug, ORIGINAL, 1, 100000);
  const correction = await seedTyped(engine, slug, CORRECTION, 0.9, 82000);
  await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,valid_from)
    VALUES('default',$1,'A separate invoice has not been approved.','fact','synthetic fixture','world',$2::timestamptz)`, [slug, AT]);
  return [original, correction];
}

const factRows = (engine: BrainEngine) => engine.executeRaw<{ id: number; valid_until: string | null; consolidated_into: number | null }>(
  'SELECT id, valid_until::text AS valid_until, consolidated_into FROM facts ORDER BY id');
const takeCount = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM takes'))[0].n);

async function tiesHandler(): Promise<RepairHandler> {
  const path = '../src/core/repair/consolidate-ties.ts';
  return (await import(path)).consolidateTiesRepair as RepairHandler;
}

const ctxFor = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId: 'default',
  remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

async function seedClosedTie(engine: BrainEngine): Promise<number[]> {
  const [original, correction] = await seedIssueFixture(engine, 'companies/probe-example');
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='companies/probe-example'");
  const [take] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight,since_date,source,active)
    VALUES($1,1,$2,'fact','self',0.95,'2026-01-01','synthetic fixture',true) RETURNING id`, [page.id, ORIGINAL]);
  // The pre-fix writeback: both facts consolidated into the take; the tie-broken one closed at its own instant.
  await engine.executeRaw('UPDATE facts SET consolidated_at=now(), consolidated_into=$1 WHERE id = ANY($2::bigint[])', [take.id, [original, correction]]);
  await engine.executeRaw('UPDATE facts SET valid_until=valid_from WHERE id=$1', [original]);
  return [original, correction];
}

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => resetGateway());

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#6023 same-instant typed claims (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM facts');
      await engine.executeRaw('DELETE FROM takes');
      await engine.executeRaw("INSERT INTO pages(slug,type,title) VALUES('companies/probe-example','company','Probe Example') ON CONFLICT DO NOTHING");
    });

    test('the issue fixture: the cluster is held unchanged, counted and given a next step; no take, no zero-length interval', async () => {
      const [original, correction] = await seedIssueFixture(engine, 'companies/probe-example');
      const before = await factRows(engine);
      const result = await runPhaseConsolidate(engine, { sourceId: 'default' });
      expect(await factRows(engine)).toEqual(before);
      expect(await takeCount(engine)).toBe(0);
      expect(result.status).toBe('warn');
      expect(result.details.facts_consolidated).toBe(0);
      expect(result.details.clusters_held_same_instant).toBe(1);
      const [held] = result.details.same_instant_clusters as Array<Record<string, unknown>>;
      expect(held).toMatchObject({ source_id: 'default', entity_slug: 'companies/probe-example', metric: 'deposit_amount', unit: 'USD', period: '2026-01-01' });
      expect([...(held.fact_ids as number[])].sort((a, b) => a - b)).toEqual([original, correction].sort((a, b) => a - b));
      expect(held.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'forget', '<FACT_ID>'] });
      expect(String(result.summary)).toContain('same effective time');
    });

    test('exact duplicates at one instant are held too', async () => {
      await seedTyped(engine, 'companies/probe-example', 'The deposit amount is $82,000.', 0.9, 82000);
      await seedTyped(engine, 'companies/probe-example', 'The deposit amount is $82,000.', 0.9, 82000);
      await seedTyped(engine, 'companies/probe-example', 'The deposit amount is $82,000.', 0.8, 82000);
      const before = await factRows(engine);
      const result = await runPhaseConsolidate(engine, { sourceId: 'default' });
      expect(await factRows(engine)).toEqual(before);
      expect(await takeCount(engine)).toBe(0);
      expect(result.details.clusters_held_same_instant).toBe(1);
    });

    test('a dry run lists the held cluster and does not offer it for promotion', async () => {
      await seedIssueFixture(engine, 'companies/probe-example');
      const result = await runPhaseConsolidate(engine, { sourceId: 'default', dryRun: true, remote: false });
      expect(result.details.clusters).toEqual([]);
      expect(result.details.takes_written).toBe(0);
      expect(result.details.clusters_held_same_instant).toBe(1);
    });

    test('a typed series at distinct instants still consolidates with its chronological writeback', async () => {
      const first = await seedTyped(engine, 'companies/probe-example', 'The deposit amount is $100,000.', 1, 100000, '2026-01-01T00:00:00Z');
      await seedTyped(engine, 'companies/probe-example', 'The deposit amount is $82,000.', 0.9, 82000, '2026-01-02T00:00:00Z');
      await seedTyped(engine, 'companies/probe-example', 'The deposit amount is $90,000.', 0.8, 90000, '2026-01-03T00:00:00Z');
      const result = await runPhaseConsolidate(engine, { sourceId: 'default' });
      expect(result.details.facts_consolidated).toBe(3);
      expect(result.details.clusters_held_same_instant).toBe(0);
      const rows = await factRows(engine);
      expect(Date.parse(rows.find(r => Number(r.id) === first)!.valid_until!)).toBe(Date.parse('2026-01-02T00:00:00Z'));
    });

    test('repair consolidate-ties previews facts an earlier release closed at their own instant, restores exactly those on --apply, and refuses a stale preview', async () => {
      const [original, correction] = await seedClosedTie(engine);
      // A zero-length fact with no tied partner in a take is not this case and is never touched.
      const other = await seedTyped(engine, 'companies/probe-example', 'The headcount is 12.', 1, 12, AT, { metric: 'headcount', unit: 'people', period: '2026-01-01' });
      await engine.executeRaw('UPDATE facts SET valid_until=valid_from WHERE id=$1', [other]);
      const handler = await tiesHandler();
      const scope = await resolveRepairScope(engine);
      await expect(runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true })).rejects.toThrow(/preview/i);
      const before = await factRows(engine);
      const preview = await runRepair(ctxFor(engine), handler, scope, { apply: false, explicit: true });
      expect(preview.preview_hash).toMatch(/^[0-9a-f]{12,}$/);
      expect(preview.affected).toBe(1);
      expect(preview.listing!.map(l => l.item)).toEqual([`default:${original}`]);
      expect(preview.listing![0].detail).toContain(String(correction));
      expect(await factRows(engine)).toEqual(before);
      await expect(runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true, expect: 'f'.repeat(64) })).rejects.toThrow(/preview/i);
      const applied = await runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.applied).toBe(1);
      const rows = await factRows(engine);
      expect(rows.find(r => Number(r.id) === original)!.valid_until).toBeNull();
      expect(rows.find(r => Number(r.id) === original)!.consolidated_into).not.toBeNull();
      expect(rows.find(r => Number(r.id) === other)!.valid_until).not.toBeNull();
      expect((await runRepair(ctxFor(engine), handler, scope, { apply: false, explicit: true })).affected).toBe(0);
    });

    test('a fact that changed since the preview is kept as changed_since_preview', async () => {
      const [original] = await seedClosedTie(engine);
      const handler = await tiesHandler();
      const scope = await resolveRepairScope(engine);
      const preview = await runRepair(ctxFor(engine), handler, scope, { apply: false, explicit: true });
      await engine.executeRaw('UPDATE facts SET expired_at=now() WHERE id=$1', [original]);
      const applied = await runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.applied).toBe(0);
      expect(applied.outcomes).toMatchObject({ changed_since_preview: 1 });
    });
  });

  describe(`#6023 same-instant typed claims on a managed brain (${backend})`, () => {
    const seedManaged = async (engine: BrainEngine, ctx: OperationContext) => {
      await operationsByName.put_page.handler(ctx, { slug: 'companies/probe-example', content: '---\ntitle: Probe Example\ntype: company\n---\n\n# Probe Example\n' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try { return await seedIssueFixture(engine, 'companies/probe-example'); }
      finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    };

    test('the managed phase holds the cluster before admission: nothing is submitted', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await seedManaged(engine, ctx);
        const before = await factRows(engine);
        const result = await runPhaseConsolidate(engine, { sourceId: 'default', minOldestAgeMs: 0 });
        expect(result.details.clusters_held_same_instant).toBe(1);
        expect(await engine.executeRaw("SELECT request_id FROM persistence_requests WHERE intent->>'kind'='managed_maintenance_consolidate'")).toEqual([]);
        expect(await factRows(engine)).toEqual(before);
        expect(await takeCount(engine)).toBe(0);
      }, { databaseUrl });
    }, 120_000);

    test('an intent admitted before this release publishes nothing: the preparer skips it', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await seedManaged(engine, ctx);
        const before = await factRows(engine);
        const cluster = (await engine.listFactsByEntity('default', 'companies/probe-example', { activeOnly: true, unconsolidatedOnly: true, limit: 100 }))
          .filter(f => f.fact === ORIGINAL || f.fact === CORRECTION);
        expect(cluster).toHaveLength(2);
        const authority = (await maintenancePreflight(engine, 'default'))!;
        const receipt = await submitMaintenanceConsolidation(engine, authority, 'companies/probe-example', cluster,
          { claim: ORIGINAL, weight: 0.95, source: 'synthetic fixture', since: '2026-01-01' });
        expect(receipt).toMatchObject({ reason: 'same_instant_typed_claims', facts_consolidated: 0, takes_written: 0 });
        expect(await factRows(engine)).toEqual(before);
        expect(await takeCount(engine)).toBe(0);
      }, { databaseUrl });
    }, 120_000);
  });
}
