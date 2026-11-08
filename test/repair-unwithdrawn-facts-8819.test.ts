/**
 * `gbrain repair unwithdrawn-facts` (#8819), PGLite; Postgres when DATABASE_URL is set.
 *
 * Protects: facts a facts-fence generation retired although no fence of their page held them come back with their
 * original ids and lifecycle, also when that generation was the page's first (no predecessor to restore); a row a
 * stored version's fence held (a genuine withdrawal) is never restored; the apply restores exactly the previewed set,
 * bound to the page revision the preview saw, so a page written since restores nothing; a managed brain and an
 * unmanaged brain with a database-only page (no repository) both restore; doctor names the lane and clears after it.
 * Seam: the pre-fix projection's retirement is reproduced by its effect, as it ran: a fact_fence generation recorded
 * through publishFenceGeneration with each row's before-state, and the rows expired and detached in that transaction.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { pathologicalArms } from './pathological/harness.ts';
import { FACTS_FENCE, managedSource, PERSON, type ManagedSource } from './pathological/managed-fixture.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { publishFenceGeneration, readFenceBlocks, FACT_FENCE_KIND } from '../src/core/generations/fence.ts';
import { factFenceItems, factPreimages, factRetireItem } from '../src/core/generations/adapters/fact-rows.ts';
import { unwithdrawnFactsCheck } from '../src/commands/doctor/checks/unwithdrawn-facts.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const SLUG = 'people/alice-example';
const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | private | medium | 2020-01-01 |  | chat |  |`;
const FOUNDED = ROW(1, 'Alice founded acme-example');
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function repair(engine: BrainEngine, sourceId: string, opts: { expect?: string; includeAmbiguous?: boolean } = {}): Promise<RepairResult & { listing?: Array<{ item: string; class: string }> }> {
  const scope = await resolveRepairScope(engine, sourceId);
  return (await repairRunner(engine, { apply: opts.expect !== undefined, noEmbed: true, logger: quiet })).run('unwithdrawn-facts', scope,
    { explicit: true, sourceFlag: sourceId, ...opts }) as Promise<RepairResult & { listing?: Array<{ item: string; class: string }> }>;
}
const hashOf = (result: RepairResult) => result.apply_command.match(/--expect ([0-9a-f]+)/)![1]!;

async function factRow(engine: BrainEngine, sourceId: string, rowNum: number, fact: string, source = 'mcp:put_page'): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
    VALUES ($1, $2, $3, 'fact', 'private', $4, $5, $2) RETURNING id`, [sourceId, SLUG, fact, source, rowNum]);
  return Number(row!.id);
}

/** What the pre-fix projection did on a page's first fact generation: record it, retiring `ids` with their before-states, and expire them. */
async function prefixRetire(engine: BrainEngine, sourceId: string, ids: number[]): Promise<void> {
  await engine.transaction(async tx => {
    const page = (await tx.readPageSnapshot(SLUG, { sourceId }))!.page;
    await publishFenceGeneration(tx, { kind: FACT_FENCE_KIND, sourceId, slug: SLUG, read: readFenceBlocks(page, 'facts'),
      items: factFenceItems([{ row_num: 1, fact: 'Alice founded acme-example', visibility: 'private' }]),
      retire: (await factPreimages(tx, sourceId, ids)).map(factRetireItem), writer: 'projection' });
    await tx.executeRaw('UPDATE facts SET expired_at=now(), row_num=NULL WHERE source_id=$1 AND id=ANY($2::bigint[])', [sourceId, ids]);
  });
}

async function state(engine: BrainEngine, ids: number[]) {
  return (await engine.executeRaw<{ id: number; row_num: number | null; active: boolean }>(
    'SELECT id, row_num, expired_at IS NULL AS active FROM facts WHERE id=ANY($1::bigint[]) ORDER BY id', [ids]))
    .map(row => [Number(row.id), row.row_num === null ? null : Number(row.row_num), row.active]);
}

/** A page whose fence once held a marathon row (removed by an edit) and never held two put_page rows; all three retired by generation 1. */
async function seed(s: ManagedSource): Promise<{ chess: number; lisbon: number; marathon: number }> {
  await s.put(SLUG, PERSON('Alice Example', FACTS_FENCE([FOUNDED, ROW(5, 'Alice ran a marathon')].join('\n'))));
  await s.put(SLUG, PERSON('Alice Example', FACTS_FENCE(FOUNDED)));
  await s.engine.executeRaw("DELETE FROM derived_generations WHERE source_id=$1 AND kind='fact_fence'", [s.sourceId]);
  await s.engine.executeRaw('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [s.sourceId, SLUG]);
  await factRow(s.engine, s.sourceId, 1, 'Alice founded acme-example', 'chat');
  const ids = { chess: await factRow(s.engine, s.sourceId, 2, 'Alice plays chess'), lisbon: await factRow(s.engine, s.sourceId, 3, 'Alice lives in Lisbon'),
    marathon: await factRow(s.engine, s.sourceId, 5, 'Alice ran a marathon', 'chat') };
  await prefixRetire(s.engine, s.sourceId, Object.values(ids));
  return ids;
}

describe('gbrain repair unwithdrawn-facts (#8819)', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] managed: restores first-generation retirements no fence withdrew, never a withdrawn one, bound to the previewed revision`, async () => {
      let ids!: { chess: number; lisbon: number; marathon: number };
      await managedSource(databaseUrl, async s => { ids = await seed(s); }, async ({ engine, sourceId, put }) => {
        const all = [ids.chess, ids.lisbon, ids.marathon];
        expect(await state(engine, all)).toEqual([[ids.chess, null, false], [ids.lisbon, null, false], [ids.marathon, null, false]]);
        const check = await unwithdrawnFactsCheck(engine, [sourceId]);
        expect([check.status, check.details]).toEqual(['warn', { evidenced: 2, ambiguous: 0, excluded: 1, repair: 'unwithdrawn-facts', docs: 'docs/guides/repair.md#unwithdrawn-facts' }]);

        const stale = await repair(engine, sourceId);
        await put(SLUG, PERSON('Alice Example', `An edit after the preview.\n\n${FACTS_FENCE(FOUNDED)}`));
        const refused = await repair(engine, sourceId, { expect: hashOf(stale) });
        expect(refused.applied).toBe(0);
        expect(await state(engine, all)).toEqual([[ids.chess, null, false], [ids.lisbon, null, false], [ids.marathon, null, false]]);

        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => [row.item, row.class])).toEqual([[`${sourceId}:${SLUG}#${ids.chess}`, 'evidenced'],
          [`${sourceId}:${SLUG}#${ids.lisbon}`, 'evidenced'], [`${sourceId}:${SLUG}#${ids.marathon}`, 'excluded:fence_held']]);
        const applied = await repair(engine, sourceId, { expect: hashOf(preview) });
        expect(applied.applied).toBe(1);
        const [request] = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_restore_unwithdrawn_facts' AND state='committed'", [sourceId]);
        expect(request?.state).toBe('committed');
        expect(await state(engine, all)).toEqual([[ids.chess, 2, true], [ids.lisbon, 3, true], [ids.marathon, null, false]]);
        expect((await unwithdrawnFactsCheck(engine, [sourceId])).status).toBe('ok');

        await put(SLUG, PERSON('Alice Example', `A later edit.\n\n${FACTS_FENCE(FOUNDED)}`));
        expect(await state(engine, all)).toEqual([[ids.chess, 2, true], [ids.lisbon, 3, true], [ids.marathon, null, false]]);
      });
    }, 180_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] unmanaged brain, database-only page: the same restore with no repository`, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        const sourceId = 'default';
        await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: FACTS_FENCE(FOUNDED) }, { sourceId });
        await factRow(engine, sourceId, 1, 'Alice founded acme-example', 'chat');
        const chess = await factRow(engine, sourceId, 2, 'Alice plays chess');
        await prefixRetire(engine, sourceId, [chess]);
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => row.class)).toEqual(['evidenced']);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [chess])).toEqual([[chess, 2, true]]);
      } finally { await close(); }
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a stored version kept without a body (a segmented snapshot) leaves the row ambiguous, never restored by default`, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        const sourceId = 'default';
        await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: FACTS_FENCE(FOUNDED) }, { sourceId });
        await engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, timeline, body_storage, body_generation)
          SELECT id, NULL, NULL, 'segmented', 1 FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, SLUG]);
        await factRow(engine, sourceId, 1, 'Alice founded acme-example', 'chat');
        const chess = await factRow(engine, sourceId, 2, 'Alice plays chess');
        await prefixRetire(engine, sourceId, [chess]);
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => row.class)).toEqual(['ambiguous']);
        expect((await unwithdrawnFactsCheck(engine, [sourceId])).details).toMatchObject({ evidenced: 0, ambiguous: 1 });
        expect(await state(engine, [chess])).toEqual([[chess, null, false]]);
      } finally { await close(); }
    }, 120_000);
  }
});
