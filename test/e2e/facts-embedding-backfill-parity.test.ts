/**
 * #4812 parity — `listFactsNeedingEmbedding` + `updateFactEmbeddings` on
 * BOTH engines (`gbrain embed --stale --facts` backfill).
 *
 * The Postgres writer binds its batch through `executeRawJsonb` +
 * `jsonb_to_recordset(($1::jsonb)->'rows')` behind a halfvec/vector cast
 * probe — the positional-JSONB bind class PGLite cannot surface (a
 * double-encoded jsonb string scalar makes `->'rows'` NULL and the UPDATE
 * silently matches nothing). Unit coverage (test/embed-facts.test.ts) is
 * PGLite-only. This mirrors one fixture onto a fresh PGLite twin and the live
 * Postgres from helpers.setupDB and asserts the selector's ordered output and
 * the writer's count/state agree, then reads the vector back with
 * `vector_dims(embedding::vector)` to prove a real vector landed.
 *
 * DATABASE_URL gated — skips gracefully when not set.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine, StaleFactRow } from '../../src/core/engine.ts';
import { AUDIT_ROW_SOURCES } from '../../src/core/facts/audit-sources.ts';
import { readFactsEmbeddingDim } from '../../src/core/embedding-dim-check.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeBoth = hasDatabase() ? describe : describe.skip;
const asc = (a: number, b: number): number => a - b;

interface Seeded {
  live: number[];    // default source, embeddable
  other: number[];   // 'other' source, embeddable
  expired: number;   // default source, expired_at set
  audit: number[];   // default source, one per AUDIT_ROW_SOURCES
}

interface Arm {
  name: 'pglite' | 'postgres';
  engine: BrainEngine;
  /** Width + type of facts.embedding from the catalog — NOT config.embedding_dimensions,
   *  which can disagree with a persisted column (e.g. a node initialised at ZE/1280 halfvec). */
  dims: number;
  columnType: 'vector' | 'halfvec';
  seeded: Seeded;
}

interface FactState {
  id: number;
  has_embedding: boolean;
  stamped: boolean;
  dims: number | null;
  col_type: string;
}

/**
 * Insert order interleaves the four states so `ORDER BY id` is a real
 * assertion (not just "insert order"): live0 live1 | expired | audit x3 |
 * live2 | other0..2 | live3 live4. Expected no-filter order by fact text:
 * live 0, live 1, live 2, other 0, other 1, other 2, live 3, live 4.
 */
async function seed(engine: BrainEngine): Promise<Seeded> {
  // facts.source_id is an FK; both resets leave only 'default' behind.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
  let rowNum = 0; // idx_facts_fence_key is UNIQUE (source_id, slug, row_num)
  const insert = async (
    sourceId: string,
    slug: string,
    rows: Array<{ fact: string; source?: string; expired_at?: Date }>,
  ): Promise<number[]> => {
    const res = await engine.insertFacts(
      rows.map((r) => ({
        fact: r.fact,
        kind: 'fact' as const,
        source: r.source ?? 'test',
        expired_at: r.expired_at ?? null,
        row_num: ++rowNum,
        source_markdown_slug: slug,
      })),
      { source_id: sourceId },
    );
    return [...res.ids].sort(asc);
  };
  const liveFact = (i: number) => ({ fact: `live ${i}` });

  const live01 = await insert('default', 'people/alice-example', [liveFact(0), liveFact(1)]);
  const [expired] = await insert('default', 'people/bob-example', [{ fact: 'expired 0', expired_at: new Date() }]);
  const audit = await insert('default', 'people/carol-example',
    AUDIT_ROW_SOURCES.map((source, i) => ({ fact: `audit ${i}`, source })));
  const live2 = await insert('default', 'people/dave-example', [liveFact(2)]);
  const other = await insert('other', 'people/erin-example', [0, 1, 2].map((i) => ({ fact: `other ${i}` })));
  const live34 = await insert('default', 'people/frank-example', [liveFact(3), liveFact(4)]);

  return { live: [...live01, ...live2, ...live34].sort(asc), other, expired, audit };
}

async function factStates(engine: BrainEngine): Promise<Map<number, FactState>> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id,
            (embedding IS NOT NULL) AS has_embedding,
            (embedded_at IS NOT NULL) AS stamped,
            vector_dims(embedding::vector) AS dims,
            pg_typeof(embedding)::text AS col_type
       FROM facts
      ORDER BY id`,
  );
  return new Map(rows.map((r) => {
    const id = Number(r.id);
    return [id, {
      id,
      has_embedding: r.has_embedding === true,
      stamped: r.stamped === true,
      dims: r.dims == null ? null : Number(r.dims),
      col_type: String(r.col_type),
    }];
  }));
}

const texts = (rows: StaleFactRow[]): string[] => rows.map((r) => r.fact);
const ids = (rows: StaleFactRow[]): number[] => rows.map((r) => r.fact_id);

/** Non-zero in every dimension; k/8 values are exact in half precision too. */
function vec(dims: number): Float32Array {
  return new Float32Array(dims).map((_, i) => ((i % 7) + 1) / 8);
}

describeBoth('facts embedding backfill parity — listFactsNeedingEmbedding / updateFactEmbeddings (#4812)', () => {
  let pglite: PGLiteEngine;
  let arms: Arm[];

  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    const postgres = await setupDB();
    arms = [];
    for (const [name, engine] of [['pglite', pglite], ['postgres', postgres]] as const) {
      const col = await readFactsEmbeddingDim(engine);
      if (!col.dims || !col.columnType) throw new Error(`${name}: facts.embedding column not found`);
      arms.push({ name, engine, dims: col.dims, columnType: col.columnType, seeded: { live: [], other: [], expired: 0, audit: [] } });
    }
  }, 120_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
  });

  beforeEach(async () => {
    await resetPgliteState(pglite);
    await arms[1].engine.executeRaw('TRUNCATE facts RESTART IDENTITY CASCADE');
    for (const arm of arms) arm.seeded = await seed(arm.engine);
  });

  /** Run `fn` on both arms; returns [pglite, postgres] results. */
  async function both<T>(fn: (arm: Arm) => Promise<T>): Promise<[T, T]> {
    const [a, b] = await Promise.all(arms.map(fn));
    return [a, b];
  }

  test('selector, no filter: same ordered list on BOTH engines; expired + audit rows excluded', async () => {
    const [pl, pg] = await both((arm) => arm.engine.listFactsNeedingEmbedding({ limit: 100 }));

    expect(texts(pg)).toEqual(['live 0', 'live 1', 'live 2', 'other 0', 'other 1', 'other 2', 'live 3', 'live 4']);
    expect(texts(pl)).toEqual(texts(pg));
    for (const [arm, rows] of [[arms[0], pl], [arms[1], pg]] as const) {
      expect(ids(rows)).toEqual([...arm.seeded.live, ...arm.seeded.other].sort(asc));
      expect(ids(rows)).not.toContain(arm.seeded.expired);
      for (const auditId of arm.seeded.audit) expect(ids(rows)).not.toContain(auditId);
      for (const row of rows) expect(typeof row.fact_id).toBe('number');
    }
  });

  test('selector, sourceId filter: scopes identically on BOTH engines', async () => {
    const [plOther, pgOther] = await both((arm) => arm.engine.listFactsNeedingEmbedding({ limit: 100, sourceId: 'other' }));
    expect(texts(pgOther)).toEqual(['other 0', 'other 1', 'other 2']);
    expect(texts(plOther)).toEqual(texts(pgOther));
    expect(ids(plOther)).toEqual(arms[0].seeded.other);
    expect(ids(pgOther)).toEqual(arms[1].seeded.other);

    const [plDefault, pgDefault] = await both((arm) => arm.engine.listFactsNeedingEmbedding({ limit: 100, sourceId: 'default' }));
    expect(texts(pgDefault)).toEqual(['live 0', 'live 1', 'live 2', 'live 3', 'live 4']);
    expect(texts(plDefault)).toEqual(texts(pgDefault));
    expect(ids(plDefault)).toEqual(arms[0].seeded.live);
    expect(ids(pgDefault)).toEqual(arms[1].seeded.live);

    // null is "no filter", not "source IS NULL".
    const [plNull, pgNull] = await both((arm) => arm.engine.listFactsNeedingEmbedding({ limit: 100, sourceId: null }));
    expect(plNull).toHaveLength(8);
    expect(pgNull).toHaveLength(8);
  });

  test('selector, keyset paging: afterId is exclusive and two pages stitch identically on BOTH engines', async () => {
    const [plAll, pgAll] = await both((arm) => arm.engine.listFactsNeedingEmbedding({ limit: 100 }));
    const [plPages, pgPages] = await both(async (arm) => {
      const page1 = await arm.engine.listFactsNeedingEmbedding({ limit: 5 });
      const page2 = await arm.engine.listFactsNeedingEmbedding({ limit: 5, afterId: page1[page1.length - 1].fact_id });
      const page3 = await arm.engine.listFactsNeedingEmbedding({ limit: 5, afterId: page2[page2.length - 1].fact_id });
      return { page1, page2, page3 };
    });

    for (const [all, pages] of [[plAll, plPages], [pgAll, pgPages]] as const) {
      expect(pages.page1).toHaveLength(5);
      expect(pages.page2).toHaveLength(3);
      expect(pages.page3).toHaveLength(0);
      expect(ids([...pages.page1, ...pages.page2])).toEqual(ids(all));
      // Exclusive cursor: the anchor row never re-appears on the next page.
      expect(ids(pages.page2)).not.toContain(pages.page1[4].fact_id);
    }
    expect(texts(plPages.page1)).toEqual(texts(pgPages.page1));
    expect(texts(plPages.page2)).toEqual(texts(pgPages.page2));
  });

  test('writer: count, NOT NULL state, expired skipped, idempotent re-run, real vector stored — identical on BOTH engines', async () => {
    const batchOf = (arm: Arm) => [
      { fact_id: arm.seeded.live[0], embedding: vec(arm.dims) },
      { fact_id: arm.seeded.live[1], embedding: vec(arm.dims) },
      { fact_id: arm.seeded.expired, embedding: vec(arm.dims) }, // skipped, not an error
    ];

    const [plCount, pgCount] = await both((arm) => arm.engine.updateFactEmbeddings(batchOf(arm)));
    expect(pgCount).toBe(2);
    expect(plCount).toBe(pgCount);

    const check = async (arm: Arm): Promise<void> => {
      const state = await factStates(arm.engine);
      for (const id of [arm.seeded.live[0], arm.seeded.live[1]]) {
        const s = state.get(id)!;
        expect(s.has_embedding).toBe(true);
        expect(s.stamped).toBe(true);
        // A double-encoded JSONB bind would have matched nothing above; a
        // string-typed store would fail the ::vector cast. Real vector, right
        // width, in the column type the engine's cast probe resolved.
        expect(s.dims).toBe(arm.dims);
        expect(s.col_type).toBe(arm.columnType);
      }
      const expired = state.get(arm.seeded.expired)!;
      expect(expired.has_embedding).toBe(false);
      expect(expired.stamped).toBe(false);
      // Everything else untouched.
      for (const id of [...arm.seeded.live.slice(2), ...arm.seeded.other, ...arm.seeded.audit]) {
        expect(state.get(id)!.has_embedding).toBe(false);
      }
    };
    await Promise.all(arms.map(check));

    // Fill-only: the same batch again matches nothing (the two rows already
    // carry a vector), so a late writer can never overwrite a successor; state unchanged.
    const [plAgain, pgAgain] = await both((arm) => arm.engine.updateFactEmbeddings(batchOf(arm)));
    expect(pgAgain).toBe(0);
    expect(plAgain).toBe(pgAgain);
    await Promise.all(arms.map(check));

    // The selector no longer offers the two embedded rows, on both engines.
    const [plRest, pgRest] = await both((arm) => arm.engine.listFactsNeedingEmbedding({ limit: 100 }));
    expect(texts(pgRest)).toEqual(['live 2', 'other 0', 'other 1', 'other 2', 'live 3', 'live 4']);
    expect(texts(plRest)).toEqual(texts(pgRest));

    expect(await arms[1].engine.updateFactEmbeddings([])).toBe(0);
  });
});
