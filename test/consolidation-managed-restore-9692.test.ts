/**
 * #9692: on a managed brain, `gbrain repair generations --kind consolidation --mode restore` refused every cluster
 * ("a generation restore here runs on unmanaged brains only"), so the member facts a dream consolidation closed into a
 * take could not be reopened. A consolidation generation records database-only rows (the members' consolidation marks
 * and validity), so a managed source restores it through the writer, journaled on the cluster's entity page.
 * Reported by @lloydsilvertwo. Synthetic fixture; real managed writer on PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { managedBrain, pathologicalArms } from './pathological/harness.ts';

const SLUG = 'companies/acme-example';
const VECTOR = '[' + [1, ...Array(1535).fill(0)].join(',') + ']';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const members = (engine: BrainEngine) => engine.executeRaw<{ valid_until: string | null; consolidated_into: number | null }>(
  "SELECT valid_until::text AS valid_until, consolidated_into FROM facts WHERE entity_slug=$1 ORDER BY id", [SLUG]);

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => resetGateway());

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`consolidation generation restore (${backend}, #9692)`, () => {
    const unmanaged = async (run: (brain: { engine: BrainEngine; ctx: OperationContext }) => Promise<void>) => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try { await run({ engine, ctx: { engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId: 'default', remote: false, dryRun: false, logger: quiet } }); }
      finally { await close(); }
    };
    for (const [label, brain] of [['managed', (run: Parameters<typeof unmanaged>[0]) => managedBrain(run, { databaseUrl })], ['unmanaged', unmanaged]] as const)
    test(`a restore previewed after a consolidate on a ${label} brain applies and reopens every member`, async () => {
      await brain(async ({ engine, ctx }) => {
        await operationsByName.put_page.handler(ctx, { slug: SLUG, content: '---\ntitle: Acme Example\ntype: company\n---\n\n# Acme Example\n' });
        const [{ enabled }] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        try {
          for (const [day, value] of [['01', 100000], ['02', 82000], ['03', 90000]] as const) {
            await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,valid_from,confidence,embedding,embedded_at,embedding_model,
                embedded_text_hash,claim_metric,claim_unit,claim_period,claim_value)
              VALUES('default',$1,$2,'fact','synthetic fixture','world',$3::timestamptz,0.9,$4::vector,$3::timestamptz,'openai:text-embedding-3-large',md5($2),
                'deposit_amount','USD','2026-01-01',$5)`, [SLUG, `The deposit amount is $${value}.`, `2026-01-${day}T00:00:00Z`, VECTOR, value]);
          }
        } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]); }
        const before = await members(engine);
        expect((await runPhaseConsolidate(engine, { sourceId: 'default', minOldestAgeMs: 0 })).details.facts_consolidated).toBe(3);
        await disposePersistenceConsumer(engine);
        expect((await members(engine)).every(row => row.consolidated_into !== null)).toBe(true);

        const scope = await resolveRepairScope(engine, 'default');
        const generations = { kind: 'consolidation', mode: 'restore' as const, since: new Date(Date.now() - 30 * 86_400_000).toISOString() };
        const preview = await (await repairRunner(engine, { apply: false, logger: quiet })).run('generations', scope, { explicit: true, sourceFlag: 'default', generations });
        expect(preview.affected).toBe(1);
        const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('generations', scope,
          { explicit: true, sourceFlag: 'default', generations, expect: preview.preview_hash });
        expect(applied.outcomes).toEqual({ restored: 1 });
        await disposePersistenceConsumer(engine);
        expect(await members(engine)).toEqual(before);
      });
    }, 240_000);
  });
}
