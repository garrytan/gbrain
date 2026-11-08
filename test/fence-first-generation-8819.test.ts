/**
 * #8819: the first managed facts-fence generation retired fact rows the page's fence never held (put_page rows with a row
 * number, no superseded_by), so a write that changed nothing in the fence expired them. A row retires only when a fence
 * held it: a fact_fence generation recorded it, the page as the writer read it carried it, or a stored version of the
 * page did. Any other row stays active with its id; a fence row claiming its number takes it and the row moves.
 * Seeds write the page without a projection, so the managed write under test publishes generation 1 with no predecessor.
 * PGLite; Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { pathologicalArms } from './pathological/harness.ts';
import { FACTS_FENCE, managedSource, PERSON, type ManagedSource } from './pathological/managed-fixture.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { fenceRowKeys, pageFenceRowKeys } from '../src/core/generations/fence-evidence.ts';
import { conversationBody } from './helpers/conversation-page.ts';

const SLUG = 'people/alice-example';
const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | private | medium | 2020-01-01 |  | chat |  |`;
const FOUNDED = ROW(1, 'Alice founded acme-example');
const CHESS = ROW(2, 'Alice plays chess');

/**
 * The page as a brain from before fact generations left it: written through `put`, then with its fact ledger cleared and
 * `rows` attached with row numbers, as a fence projection or an older put_page writer stamped them.
 */
async function seedPage(s: ManagedSource, body: string, rows: Array<[number, string, string?]>): Promise<void> {
  await s.put(SLUG, PERSON('Alice Example', body));
  await s.engine.executeRaw("DELETE FROM derived_generations WHERE source_id=$1 AND kind='fact_fence'", [s.sourceId]);
  await s.engine.executeRaw('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [s.sourceId, SLUG]);
  for (const [rowNum, fact, source] of rows) await factRow(s.engine, s.sourceId, rowNum, fact, source ?? 'mcp:put_page');
}

/** A fact row attached to the page with a row number, as a fence projection or a put_page writer stamped it. */
async function factRow(engine: BrainEngine, sourceId: string, rowNum: number, fact: string, source = 'mcp:put_page'): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
    VALUES ($1, $2, $3, 'fact', 'private', $4, $5, $2) RETURNING id`, [sourceId, SLUG, fact, source, rowNum]);
  return Number(row!.id);
}

async function facts(engine: BrainEngine, sourceId: string) {
  return (await engine.executeRaw<{ fact: string; row_num: number | null; active: boolean }>(
    'SELECT fact, row_num, expired_at IS NULL AS active FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id', [sourceId, SLUG]))
    .map(row => [row.fact, row.row_num === null ? null : Number(row.row_num), row.active]);
}

async function generations(engine: BrainEngine, sourceId: string) {
  return (await engine.executeRaw<{ generation: number; state: string; retired: number }>(`SELECT g.generation, g.state,
      (SELECT count(*)::int FROM derived_generation_items i WHERE i.generation_id=g.id AND i.action='retired') AS retired
    FROM derived_generations g WHERE g.source_id=$1 AND g.kind='fact_fence' AND g.owner_key=$2 ORDER BY g.id`, [sourceId, `page:${SLUG}`]))
    .map(row => [Number(row.generation), row.state, Number(row.retired)]);
}

describe('#8819 first managed facts-fence generation', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a write that leaves the fence alone keeps put_page rows the fence never held`, async () => {
      await managedSource(databaseUrl, async s => {
        await seedPage(s, `Alice is an example person.\n\n${FACTS_FENCE(FOUNDED)}`, [[1, 'Alice founded acme-example', 'chat'], [2, 'Alice plays chess'], [3, 'Alice lives in Lisbon']]);
      }, async ({ engine, sourceId, put }) => {
        expect(await generations(engine, sourceId)).toEqual([]);
        await put(SLUG, PERSON('Alice Example', `Alice is an example person. An edit changed this paragraph.\n\n${FACTS_FENCE(FOUNDED)}`));
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', 1, true], ['Alice plays chess', 2, true], ['Alice lives in Lisbon', 3, true]]);
        expect(await generations(engine, sourceId)).toEqual([[1, 'live', 0]]);
        await put(SLUG, PERSON('Alice Example', `Alice is an example person. A second edit.\n\n${FACTS_FENCE(FOUNDED)}`));
        expect((await facts(engine, sourceId)).every(row => row[2])).toBe(true);
      });
    }, 120_000);

    test(`[${backend}] an empty fence on a first generation retires the rows it held and keeps the rest`, async () => {
      await managedSource(databaseUrl, async s => {
        await seedPage(s, FACTS_FENCE(FOUNDED), [[1, 'Alice founded acme-example', 'chat'], [2, 'Alice plays chess']]);
      }, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE('')));
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', null, false], ['Alice plays chess', 2, true]]);
        expect(await generations(engine, sourceId)).toEqual([[1, 'live', 1]]);
      });
    }, 120_000);

    test(`[${backend}] a write that drops a row the prior fence held still retires it, with no generation before it`, async () => {
      await managedSource(databaseUrl, async s => {
        await seedPage(s, FACTS_FENCE([FOUNDED, CHESS].join('\n')), [[1, 'Alice founded acme-example', 'chat'], [2, 'Alice plays chess', 'chat'], [3, 'Alice lives in Lisbon']]);
      }, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE(FOUNDED)));
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', 1, true], ['Alice plays chess', null, false], ['Alice lives in Lisbon', 3, true]]);
        expect(await generations(engine, sourceId)).toEqual([[1, 'live', 1]]);
      });
    }, 120_000);

    test(`[${backend}] a row an earlier edit removed from the fence retires on the stored version that held it`, async () => {
      await managedSource(databaseUrl, async s => {
        await s.put(SLUG, PERSON('Alice Example', FACTS_FENCE([FOUNDED, CHESS].join('\n'))));
        await seedPage(s, FACTS_FENCE(FOUNDED), [[1, 'Alice founded acme-example', 'chat'], [2, 'Alice plays chess', 'chat']]);
      }, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', `An edit changed this paragraph.\n\n${FACTS_FENCE(FOUNDED)}`));
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', 1, true], ['Alice plays chess', null, false]]);
      });
    }, 120_000);

    test(`[${backend}] a fence row that claims a kept row's number takes it; the kept row moves and stays active across later writes`, async () => {
      await managedSource(databaseUrl, async s => {
        await seedPage(s, FACTS_FENCE(FOUNDED), [[1, 'Alice founded acme-example', 'chat'], [2, 'Alice plays chess']]);
      }, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE([FOUNDED, ROW(2, 'Alice speaks Portuguese')].join('\n'))));
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', 1, true], ['Alice plays chess', 3, true], ['Alice speaks Portuguese', 2, true]]);
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE(FOUNDED)));
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', 1, true], ['Alice plays chess', 3, true], ['Alice speaks Portuguese', null, false]]);
      });
    }, 120_000);

    /*
     * Coverage pass 2 (/ship 8830 Step 7), generated by Capy.
     * Value: protects=a kept row more trusted than the writer keeps its moved row_num (guardFenceRows skips kept ids); fails_when=the NOT (f.id = ANY(kept)) guard is dropped; why_new=the kept-row test above uses an untrusted-tier row; seam=none; no_claim=trust proposals for the guarded path
     */
    test(`[${backend}] a kept row more trusted than the writer moves past a claiming fence row and keeps its number`, async () => {
      await managedSource(databaseUrl, async s => {
        await seedPage(s, FACTS_FENCE(FOUNDED), [[1, 'Alice founded acme-example', 'chat']]);
        await s.engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug, trust_tier)
          VALUES ($1, $2, 'Alice plays chess', 'fact', 'private', 'mcp:put_page', 2, $2, 'user_confirmed')`, [s.sourceId, SLUG]);
      }, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE([FOUNDED, ROW(2, 'Alice speaks Portuguese')].join('\n'))));
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', 1, true], ['Alice plays chess', 3, true], ['Alice speaks Portuguese', 2, true]]);
      });
    }, 120_000);

    test(`[${backend}] a fence row restating a kept row's claim at another visibility retires the kept row, so no wider copy stays active`, async () => {
      await managedSource(databaseUrl, async s => {
        await seedPage(s, FACTS_FENCE(FOUNDED), [[1, 'Alice founded acme-example', 'chat']]);
        await s.engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
          VALUES ($1, $2, 'Alice plays chess', 'fact', 'world', 'mcp:put_page', 2, $2)`, [s.sourceId, SLUG]);
      }, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE([FOUNDED, CHESS].join('\n'))));
        expect(await engine.executeRaw('SELECT visibility FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3 AND expired_at IS NULL',
          [sourceId, SLUG, 'Alice plays chess'])).toEqual([{ visibility: 'private' }]);
      });
    }, 120_000);

    test(`[${backend}] the extract_facts reconcile retires a never-held row whose claim the fence restates at another number`, async () => {
      await managedSource(databaseUrl, async s => {
        await s.put(SLUG, PERSON('Alice Example', FACTS_FENCE([FOUNDED, ROW(4, 'Alice plays chess')].join('\n'))));
        await seedPage(s, FACTS_FENCE([FOUNDED, ROW(4, 'Alice plays chess')].join('\n')), [[1, 'Alice founded acme-example', 'chat'], [4, 'Alice plays chess', 'chat']]);
        await s.engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
          VALUES ($1, $2, 'Alice plays chess', 'fact', 'world', 'mcp:put_page', 2, $2)`, [s.sourceId, SLUG]);
      }, async ({ engine, sourceId }) => {
        await runExtractFacts(engine, { sourceId });
        expect(await engine.executeRaw('SELECT visibility, row_num FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3 AND expired_at IS NULL',
          [sourceId, SLUG, 'Alice plays chess'])).toEqual([{ visibility: 'private', row_num: 4 }]);
      });
    }, 120_000);

    test(`[${backend}] the extract_facts reconcile keeps rows the fence never held and still retires a withdrawn one`, async () => {
      await managedSource(databaseUrl, async s => {
        await s.put(SLUG, PERSON('Alice Example', FACTS_FENCE([FOUNDED, CHESS, ROW(5, 'Alice ran a marathon')].join('\n'))));
        await seedPage(s, FACTS_FENCE([FOUNDED, CHESS].join('\n')), [[1, 'Alice founded acme-example', 'chat'], [2, 'Alice speaks Portuguese'],
          [3, 'Alice lives in Lisbon'], [5, 'Alice ran a marathon', 'chat']]);
      }, async ({ engine, sourceId }) => {
        await runExtractFacts(engine, { sourceId });
        expect(await facts(engine, sourceId)).toEqual([['Alice founded acme-example', 1, true], ['Alice speaks Portuguese', 4, true], ['Alice lives in Lisbon', 3, true],
          ['Alice ran a marathon', null, false], ['Alice plays chess', 2, true]]);
        expect(await generations(engine, sourceId)).toEqual([[1, 'live', 1]]);
        await runExtractFacts(engine, { sourceId });
        expect((await facts(engine, sourceId)).filter(row => row[2]).length).toBe(4);
      });
    }, 120_000);
  }
});

describe('#8819 fence evidence of a segmented page', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('a segmented prior body yields its fence rows from its segments, so a removed row still counts as fence-held', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    const body = `${conversationBody(800_000, { seed: 1 })}\n\n${FACTS_FENCE([FOUNDED, CHESS].join('\n'))}\n\n${conversationBody(800_000, { seed: 2 })}\n`;
    expect(await importFromContent(engine, SLUG, PERSON('Alice Example', body), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    const page = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page;
    expect(page.body_storage).toBe('segmented');
    expect(fenceRowKeys(page, SLUG, 'default').size).toBe(0);
    expect([...await pageFenceRowKeys(engine, page, SLUG, 'default')].map(key => key.split('\u0000').slice(0, 2)))
      .toEqual([['1', 'Alice founded acme-example'], ['2', 'Alice plays chess']]);
  }, 120_000);
});
