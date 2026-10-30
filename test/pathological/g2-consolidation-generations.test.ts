/**
 * GBRA-161 PR 2 (B-17, #6023): the dream consolidate phase publishes through the generation primitive. A cluster whose
 * typed claims tie at one instant is held (`generation_held`, reason `tie`) with nothing written; a strict
 * chronological chain records each member's before-state, and `gbrain repair generations --kind consolidation --mode
 * restore` reopens it. PGLite; Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { runPhaseConsolidate } from '../../src/core/cycle/phases/consolidate.ts';
import type { GenerationsSelection } from '../../src/core/generations/repair.ts';
import { generationHeldCheck } from '../../src/commands/doctor/checks/generations.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const SLUG = 'companies/probe-example';
const VECTOR = '[' + [1, ...Array(1535).fill(0)].join(',') + ']';

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g2c-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await engine.executeRaw("INSERT INTO pages(slug,type,title) VALUES($1,'company','Probe Example') ON CONFLICT DO NOTHING", [SLUG]);
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function seed(engine: BrainEngine, fact: string, at: string, claim?: { metric: string; unit: string; period: string; value: number }): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,valid_from,confidence,embedding,embedded_at,embedding_model,embedded_text_hash,
       claim_metric,claim_unit,claim_period,claim_value)
     VALUES('default',$1,$2,'fact','synthetic fixture','world',$3::timestamptz,0.9,$4::vector,$3::timestamptz,'openai:text-embedding-3-large',md5($2),$5,$6,$7,$8)
     RETURNING id`, [SLUG, fact, at, VECTOR, claim?.metric ?? null, claim?.unit ?? null, claim?.period ?? null, claim?.value ?? null]);
  return Number(row.id);
}

const facts = (engine: BrainEngine) => engine.executeRaw<{ id: number; valid_until: string | null; consolidated: boolean; into: number | null }>(
  'SELECT id::int AS id, valid_until::text AS valid_until, consolidated_at IS NOT NULL AS consolidated, consolidated_into::int AS "into" FROM facts ORDER BY id');

async function repair(engine: BrainEngine, selection: GenerationsSelection, expectHash?: string): Promise<RepairResult> {
  const scope = await resolveRepairScope(engine, 'default');
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  return (await repairRunner(engine, { apply: expectHash !== undefined, noEmbed: true, logger: quiet })).run('generations', scope,
    { explicit: true, sourceFlag: 'default', generations: selection, ...(expectHash ? { expect: expectHash } : {}) });
}

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => resetGateway());

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 PR 2 consolidation generations (${backend})`, () => {
    test('#6023: a same-instant tie is held as generation_held tie with nothing written', async () => {
      await withBrain(databaseUrl, async engine => {
        const claim = { metric: 'deposit_amount', unit: 'USD', period: '2026-01-01' };
        const a = await seed(engine, 'The deposit amount was initially reported as $100,000.', '2026-01-01T00:00:00Z', { ...claim, value: 100000 });
        const b = await seed(engine, 'Correction: the deposit amount is $82,000.', '2026-01-01T00:00:00Z', { ...claim, value: 82000 });
        await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,valid_from)
          VALUES('default',$1,'A separate invoice has not been approved.','fact','synthetic fixture','world','2026-01-01T00:00:00Z')`, [SLUG]);
        await runPhaseConsolidate(engine, {});
        expect((await facts(engine)).slice(0, 2)).toEqual([{ id: a, valid_until: null, consolidated: false, into: null }, { id: b, valid_until: null, consolidated: false, into: null }]);
        const held = await engine.executeRaw<{ owner_key: string; held_reason: string }>(
          "SELECT owner_key, held_reason FROM derived_generations WHERE kind='consolidation' AND state='held'");
        expect(held).toEqual([{ owner_key: `entity:${SLUG}:cluster:${a},${b}`, held_reason: 'tie' }]);
        expect((await generationHeldCheck(engine, ['default'])).status).toBe('warn');
        await runPhaseConsolidate(engine, {});
        expect(await engine.executeRaw("SELECT 1 FROM derived_generations WHERE kind='consolidation'")).toHaveLength(1);
      });
    }, 120_000);

    test('a strict chain records each member before-state and repair generations restore reopens it', async () => {
      await withBrain(databaseUrl, async engine => {
        const claim = 'Acme-example reports steady recurring revenue growth.';
        const ids = [await seed(engine, claim, '2026-01-15T00:00:00Z'), await seed(engine, claim, '2026-04-12T00:00:00Z'), await seed(engine, claim, '2026-07-08T00:00:00Z')];
        const result = await runPhaseConsolidate(engine, {});
        expect(result.details.facts_consolidated).toBe(3);
        const closed = await facts(engine);
        expect(closed.map(row => [row.valid_until !== null, row.consolidated])).toEqual([[true, true], [true, true], [false, true]]);
        const selection: GenerationsSelection = { kind: 'consolidation', mode: 'restore', key: `entity:${SLUG}:cluster:${ids.join(',')}` };
        const preview = await repair(engine, selection);
        expect(preview.listing).toEqual([{ item: `default:${selection.key}`, class: 'restore', detail: 'generation 2 back to 1: revive 3, retire 0' }]);
        expect((await repair(engine, selection, preview.preview_hash)).outcomes).toEqual({ restored: 1 });
        expect(await facts(engine)).toEqual(ids.map(id => ({ id, valid_until: null, consolidated: false, into: null })));
        await runPhaseConsolidate(engine, {});
        expect(await facts(engine)).toEqual(ids.map(id => ({ id, valid_until: null, consolidated: false, into: null })));
      });
    }, 120_000);
  });
}
