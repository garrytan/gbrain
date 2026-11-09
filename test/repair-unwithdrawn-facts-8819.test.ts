/**
 * `gbrain repair unwithdrawn-facts` (#8819), PGLite; Postgres when DATABASE_URL is set.
 *
 * Protects: facts a facts-fence generation retired although no fence of their page held them come back with their
 * original ids and lifecycle, also when that generation was the page's first (no predecessor to restore); a row a
 * stored version's fence held (a genuine withdrawal) is never restored; the apply restores exactly the previewed set,
 * bound to the page revision the preview saw, so a page written since restores nothing; an unmanaged brain (a
 * database-only page, no repository) lists nothing restorable, since its extract_facts reconcile would retire a restored
 * row again; doctor names the lane and clears after it.
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
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';

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

async function factRow(engine: BrainEngine, sourceId: string, rowNum: number, fact: string, source = 'mcp:put_page', page = SLUG): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
    VALUES ($1, $2, $3, 'fact', 'private', $4, $5, $6) RETURNING id`, [sourceId, SLUG, fact, source, rowNum, page]);
  return Number(row!.id);
}

/** What the pre-fix projection did on a page's first fact generation: record it, retiring `ids` with their before-states, and expire them. */
async function prefixRetire(engine: BrainEngine, sourceId: string, ids: number[], slug = SLUG): Promise<void> {
  await engine.transaction(async tx => {
    const page = (await tx.readPageSnapshot(slug, { sourceId }))!.page;
    await publishFenceGeneration(tx, { kind: FACT_FENCE_KIND, sourceId, slug, read: readFenceBlocks(page, 'facts'),
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

/**
 * A managed brain's page whose fence holds row 1, its fact ledger cleared and row 1 attached; a segmented one also has a
 * body-less stored version. `seed` writes its rows before the brain turns managed (raw fact writes are refused after);
 * `run` gets what it returned.
 */
async function managedPage<T>(databaseUrl: string | undefined, seed: (engine: BrainEngine, sourceId: string) => Promise<T>,
  run: (engine: BrainEngine, sourceId: string, seeded: T) => Promise<void>, segmented = false, fence = FOUNDED): Promise<void> {
  let seeded: T;
  await managedSource(databaseUrl, async s => {
    await s.put(SLUG, PERSON('Alice Example', FACTS_FENCE(fence)));
    await s.engine.executeRaw("DELETE FROM derived_generations WHERE source_id=$1 AND kind='fact_fence'", [s.sourceId]);
    await s.engine.executeRaw('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [s.sourceId, SLUG]);
    if (segmented) await s.engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, timeline, body_storage, body_generation)
      SELECT id, NULL, NULL, 'segmented', 1 FROM pages WHERE source_id=$1 AND slug=$2`, [s.sourceId, SLUG]);
    await factRow(s.engine, s.sourceId, 1, 'Alice founded acme-example', 'chat');
    seeded = await seed(s.engine, s.sourceId);
  }, ({ engine, sourceId }) => run(engine, sourceId, seeded));
}

/** Seeds one retired put_page row, 'Alice plays chess' at row 2. */
async function retiredChess(engine: BrainEngine, sourceId: string): Promise<number> {
  const chess = await factRow(engine, sourceId, 2, 'Alice plays chess');
  await prefixRetire(engine, sourceId, [chess]);
  return chess;
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
    test(`[${backend}] unmanaged brain, database-only page: nothing is restorable, since its reconcile would retire a restored row again`, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        const sourceId = 'default';
        await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: FACTS_FENCE(FOUNDED) }, { sourceId });
        await factRow(engine, sourceId, 1, 'Alice founded acme-example', 'chat');
        const chess = await factRow(engine, sourceId, 2, 'Alice plays chess');
        await prefixRetire(engine, sourceId, [chess]);
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => row.class)).toEqual(['excluded:unmanaged_reconcile']);
        expect((await unwithdrawnFactsCheck(engine, [sourceId])).status).toBe('ok');
        await runExtractFacts(engine, { sourceId, slugs: [SLUG] });
        expect(await state(engine, [chess])).toEqual([[chess, null, false]]);
        expect((await unwithdrawnFactsCheck(engine, [sourceId])).status).toBe('ok');
      } finally { await close(); }
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a stored version kept without a body (a segmented snapshot) leaves the row ambiguous, never restored by default`, async () => {
      await managedPage(databaseUrl, retiredChess, async (engine, sourceId, chess) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => row.class)).toEqual(['ambiguous']);
        expect((await unwithdrawnFactsCheck(engine, [sourceId])).details).toMatchObject({ evidenced: 0, ambiguous: 1 });
        expect(await state(engine, [chess])).toEqual([[chess, null, false]]);
      }, true);
    }, 120_000);
  }
});

/*
 * Coverage pass (/ship 8830 Step 7), generated by Capy.
 * Value: protects=classify never restores superseded, withdrawn, changed_since_retirement, active_duplicate or duplicate_candidate rows; fails_when=a classify guard is dropped or reordered; why_new=existing tests only reach fence_held and ambiguous; seam=none; no_claim=page_missing (needs a second page's generation; not seeded here)
 * Value: protects=--apply without --expect is invalid_params, an include_ambiguous mismatch is preview_changed, a taken row_num moves to max+1; fails_when=the expect guard, mismatch check or row_num CASE regresses; why_new=no test applies ambiguous rows or a taken row_num; seam=none; no_claim=unmanaged brains, where nothing is restorable (the unmanaged test above)
 */
describe('gbrain repair unwithdrawn-facts (#8819) coverage pass', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] exclusions: superseded, withdrawn, changed, active duplicate and duplicate candidate are listed, never restored`, async () => {
      await managedPage(databaseUrl, async (engine, s) => {
        const ids = { chess: await factRow(engine, s, 2, 'Alice plays chess'), sailsA: await factRow(engine, s, 3, 'Alice sails'), sailsB: await factRow(engine, s, 4, 'Alice sails'),
          superseded: await factRow(engine, s, 5, 'Alice owns a boat'), withdrawn: await factRow(engine, s, 6, 'Alice likes jazz'),
          changed: await factRow(engine, s, 7, 'Alice speaks French'), activeDup: await factRow(engine, s, 8, 'Alice runs') };
        await prefixRetire(engine, s, Object.values(ids));
        await factRow(engine, s, 9, 'Alice runs');
        await engine.executeRaw('UPDATE facts SET superseded_by=$2 WHERE id=$1', [ids.superseded, ids.chess]);
        await engine.executeRaw("INSERT INTO fact_withdrawals (source_id, visibility, fact_hash) SELECT source_id, visibility, gbrain_fact_fingerprint(fact) FROM facts WHERE id=$1", [ids.withdrawn]);
        await engine.executeRaw("UPDATE facts SET expired_at = expired_at + interval '1 second' WHERE id=$1", [ids.changed]);
        return ids;
      }, async (engine, s, ids) => {
        const preview = await repair(engine, s);
        expect(preview.listing!.map(row => [row.item, row.class])).toEqual([
          [`${s}:${SLUG}#${ids.chess}`, 'evidenced'], [`${s}:${SLUG}#${ids.sailsA}`, 'evidenced'], [`${s}:${SLUG}#${ids.sailsB}`, 'excluded:duplicate_candidate'],
          [`${s}:${SLUG}#${ids.superseded}`, 'excluded:superseded'], [`${s}:${SLUG}#${ids.withdrawn}`, 'excluded:withdrawn'],
          [`${s}:${SLUG}#${ids.changed}`, 'excluded:changed_since_retirement'], [`${s}:${SLUG}#${ids.activeDup}`, 'excluded:active_duplicate']]);
        expect((await repair(engine, s, { expect: hashOf(preview) })).applied).toBe(1);
        const active = (await state(engine, Object.values(ids))).filter(([, , on]) => on).map(([id]) => id);
        expect(active).toEqual([ids.chess, ids.sailsA]);
      });
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] --apply needs --expect; a taken row number moves the restored row to max+1`, async () => {
      await managedPage(databaseUrl, async (engine, sourceId) => {
        const chess = await retiredChess(engine, sourceId);
        await factRow(engine, sourceId, 2, 'Alice paints');
        return chess;
      }, async (engine, sourceId, chess) => {
        const scope = await resolveRepairScope(engine, sourceId);
        await expect((await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('unwithdrawn-facts', scope, { explicit: true, sourceFlag: sourceId }))
          .rejects.toMatchObject({ code: 'invalid_params' });
        const preview = await repair(engine, sourceId);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [chess])).toEqual([[chess, 3, true]]);
        const [{ n }] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE source_id=$2 AND source_markdown_slug=$1 AND expired_at IS NULL AND row_num=2", [SLUG, sourceId]);
        expect(Number(n)).toBe(1);
      });
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] --include-ambiguous restores ambiguous rows only under the matching flag`, async () => {
      await managedPage(databaseUrl, retiredChess, async (engine, sourceId, chess) => {
        const preview = await repair(engine, sourceId, { includeAmbiguous: true });
        expect(preview.listing!.map(row => row.class)).toEqual(['ambiguous']);
        await expect(repair(engine, sourceId, { expect: hashOf(preview) })).rejects.toMatchObject({ code: 'preview_changed' });
        expect(await state(engine, [chess])).toEqual([[chess, null, false]]);
        expect((await repair(engine, sourceId, { expect: hashOf(preview), includeAmbiguous: true })).applied).toBe(1);
        expect(await state(engine, [chess])).toEqual([[chess, 2, true]]);
      }, true);
    }, 120_000);
  }
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a fact withdrawn after the preview stays retired; the rest of the page is restored`, async () => {
      await managedPage(databaseUrl, async (engine, sourceId) => {
        const ids = { chess: await factRow(engine, sourceId, 2, 'Alice plays chess'), lisbon: await factRow(engine, sourceId, 3, 'Alice lives in Lisbon') };
        await prefixRetire(engine, sourceId, [ids.chess, ids.lisbon]);
        return ids;
      }, async (engine, sourceId, { chess, lisbon }) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => row.class)).toEqual(['evidenced', 'evidenced']);
        await engine.executeRaw("INSERT INTO fact_withdrawals (source_id, visibility, fact_hash) SELECT source_id, visibility, gbrain_fact_fingerprint(fact) FROM facts WHERE id=$1", [chess]);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [chess, lisbon])).toEqual([[chess, null, false], [lisbon, 3, true]]);
      });
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a retired row whose claim is active on the page at another visibility is excluded as an active duplicate`, async () => {
      await managedPage(databaseUrl, async (engine, sourceId) => {
        const chess = await factRow(engine, sourceId, 2, 'Alice plays chess');
        await engine.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [chess]);
        await prefixRetire(engine, sourceId, [chess]);
        await factRow(engine, sourceId, 2, 'Alice plays chess');
        return chess;
      }, async (engine, sourceId, chess) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => row.class)).toEqual(['excluded:active_duplicate']);
        expect(await state(engine, [chess])).toEqual([[chess, null, false]]);
      });
    }, 120_000);
  }
  /*
   * Coverage pass 2 (/ship 8830 Step 7), generated by Capy.
   * Value: protects=a retirement on a deleted page is excluded:page_missing and a page with a version-history gap is ambiguous; fails_when=the page_missing or history_gap branch of classify is dropped or reordered; why_new=pass 1 left both unseeded; seam=none; no_claim=a page row absent entirely (soft delete stands in)
   */
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a deleted page excludes its retirements; a version-history gap makes them ambiguous`, async () => {
      for (const [column, klass] of [['deleted_at', 'excluded:page_missing'], ['version_history_gap_at', 'ambiguous']] as const) {
        await managedPage(databaseUrl, async (engine, sourceId) => {
          const chess = await retiredChess(engine, sourceId);
          await engine.executeRaw(`UPDATE pages SET ${column}=now() WHERE source_id=$2 AND slug=$1`, [SLUG, sourceId]);
          return chess;
        }, async (engine, sourceId, chess) => {
          const preview = await repair(engine, sourceId);
          expect(preview.listing!.map(row => row.class)).toEqual([klass]);
          expect(await state(engine, [chess])).toEqual([[chess, null, false]]);
        });
      }
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a fact forgotten on its owned memory page stays retired`, async () => {
      const MEMBER = 'memory/members/alice-example';
      let ids: { chess: number; lisbon: number };
      await managedSource(databaseUrl, async s => {
        await s.put(MEMBER, PERSON('Alice Example', FACTS_FENCE(FOUNDED)));
        await s.engine.executeRaw("DELETE FROM derived_generations WHERE source_id=$1 AND kind='fact_fence'", [s.sourceId]);
        await s.engine.executeRaw('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [s.sourceId, MEMBER]);
        await factRow(s.engine, s.sourceId, 1, 'Alice founded acme-example', 'chat', MEMBER);
        ids = { chess: await factRow(s.engine, s.sourceId, 2, 'Alice plays chess', 'mcp:put_page', MEMBER),
          lisbon: await factRow(s.engine, s.sourceId, 3, 'Alice lives in Lisbon', 'mcp:put_page', MEMBER) };
        await prefixRetire(s.engine, s.sourceId, [ids.chess, ids.lisbon], MEMBER);
        await s.engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
          SELECT source_id, visibility, source_markdown_slug, gbrain_fact_fingerprint(fact) FROM facts WHERE id=$1`, [ids.chess]);
      }, async ({ engine, sourceId }) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => [row.item, row.class])).toEqual([
          [`${sourceId}:${MEMBER}#${ids.chess}`, 'excluded:withdrawn'], [`${sourceId}:${MEMBER}#${ids.lisbon}`, 'evidenced']]);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [ids.chess, ids.lisbon])).toEqual([[ids.chess, null, false], [ids.lisbon, 3, true]]);
      });
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] private and world copies of one claim: only the private copy is restored`, async () => {
      await managedPage(databaseUrl, async (engine, sourceId) => {
        const ids = { world: await factRow(engine, sourceId, 2, 'Alice plays chess'), priv: await factRow(engine, sourceId, 3, 'Alice plays chess') };
        await engine.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [ids.world]);
        await prefixRetire(engine, sourceId, [ids.world, ids.priv]);
        return ids;
      }, async (engine, sourceId, { world, priv }) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => [row.item, row.class])).toEqual([
          [`${sourceId}:${SLUG}#${world}`, 'excluded:duplicate_candidate'], [`${sourceId}:${SLUG}#${priv}`, 'evidenced']]);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [world, priv])).toEqual([[world, null, false], [priv, 3, true]]);
      });
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a claim the page's fence states at another row is not restored, since the next write would retire it again`, async () => {
      await managedPage(databaseUrl, retiredChess, async (engine, sourceId, chess) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => row.class)).toEqual(['excluded:fence_states_claim']);
        expect(await state(engine, [chess])).toEqual([[chess, null, false]]);
      }, false, [FOUNDED, ROW(4, 'Alice plays chess')].join('\n'));
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] one claim asserted by two speakers: each speaker's copy is restored`, async () => {
      await managedPage(databaseUrl, async (engine, sourceId) => {
        const ids = { user: await factRow(engine, sourceId, 2, 'Alice plays chess'), other: await factRow(engine, sourceId, 3, 'Alice plays chess') };
        await engine.executeRaw("UPDATE facts SET attributed_to=CASE WHEN id=$1 THEN 'user' ELSE 'other' END WHERE id=ANY($2::bigint[])", [ids.user, [ids.user, ids.other]]);
        await prefixRetire(engine, sourceId, [ids.user, ids.other]);
        return ids;
      }, async (engine, sourceId, { user, other }) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => [row.item, row.class])).toEqual([
          [`${sourceId}:${SLUG}#${user}`, 'evidenced'], [`${sourceId}:${SLUG}#${other}`, 'evidenced']]);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [user, other])).toEqual([[user, 2, true], [other, 3, true]]);
      });
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] an active copy whose validity has lapsed, or another speaker's, does not block a restore`, async () => {
      await managedPage(databaseUrl, async (engine, sourceId) => {
        const chess = await factRow(engine, sourceId, 2, 'Alice plays chess');
        const lisbon = await factRow(engine, sourceId, 3, 'Alice lives in Lisbon');
        await engine.executeRaw("UPDATE facts SET attributed_to='user' WHERE id=$1", [lisbon]);
        await prefixRetire(engine, sourceId, [chess, lisbon]);
        const lapsed = await factRow(engine, sourceId, 4, 'Alice plays chess');
        await engine.executeRaw("UPDATE facts SET valid_until='2020-01-01' WHERE id=$1", [lapsed]);
        const assistant = await factRow(engine, sourceId, 5, 'Alice lives in Lisbon');
        await engine.executeRaw("UPDATE facts SET attributed_to='assistant' WHERE id=$1", [assistant]);
        return { chess, lisbon };
      }, async (engine, sourceId, { chess, lisbon }) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => [row.item, row.class])).toEqual([
          [`${sourceId}:${SLUG}#${chess}`, 'evidenced'], [`${sourceId}:${SLUG}#${lisbon}`, 'evidenced']]);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [chess, lisbon])).toEqual([[chess, 2, true], [lisbon, 3, true]]);
      });
    }, 120_000);
  }

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] of two copies of one claim, the still valid copy is restored, not the one whose validity had lapsed`, async () => {
      await managedPage(databaseUrl, async (engine, sourceId) => {
        const ids = { lapsed: await factRow(engine, sourceId, 2, 'Alice plays chess'), valid: await factRow(engine, sourceId, 3, 'Alice plays chess') };
        await engine.executeRaw("UPDATE facts SET valid_until='2020-01-01' WHERE id=$1", [ids.lapsed]);
        await prefixRetire(engine, sourceId, [ids.lapsed, ids.valid]);
        return ids;
      }, async (engine, sourceId, { lapsed, valid }) => {
        const preview = await repair(engine, sourceId);
        expect(preview.listing!.map(row => [row.item, row.class])).toEqual([
          [`${sourceId}:${SLUG}#${lapsed}`, 'excluded:duplicate_candidate'], [`${sourceId}:${SLUG}#${valid}`, 'evidenced']]);
        expect((await repair(engine, sourceId, { expect: hashOf(preview) })).applied).toBe(1);
        expect(await state(engine, [lapsed, valid])).toEqual([[lapsed, null, false], [valid, 3, true]]);
      });
    }, 120_000);
  }
});
