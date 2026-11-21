/**
 * The facts fence evidence reads and the kept row move (generations/fence-evidence.ts, #8819) on PGLite, Postgres and a
 * Rust brain: the fence item keys a fact_fence generation recorded, the probe for a stored version without a body, the
 * batches of stored versions that carry a facts fence, and the move of kept fact rows off the numbers a fence row claims.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: the four statements fence-evidence.ts always sent, with the same parameters and byte order, now that they
 *    are engine members (engine-sql/generation-fence-evidence.ts), and a Rust brain answers the same walk: a row is held
 *    when a generation of the page not held recorded its key (each key once, a superseded generation's too), when a stored version's fence carries it, or not at
 *    all; a version without the marker and a version above `before` are skipped; and the claimed kept rows move above
 *    the page and the claims in (row number, id) order while an unclaimed row keeps its number.
 *  - Regression: the statements went through `executeRaw`, which the Rust engine refuses (`raw_sql`), so a facts fence
 *    write that retires rows stopped at factsFenceHeld on a Rust brain (0120895e02).
 *  - Why existing coverage misses it: test/fence-first-generation-8819.test.ts runs the evidence through a managed
 *    write on the SQL engines only; this test calls the fence-evidence.ts functions directly on all three.
 *  - Seam: the ledger is made with the typed activateGenerationRows member, the versions with putPage + createVersion,
 *    the rows with insertFacts. The PGLite pin wraps PGLiteEngine.prototype.executeRaw to record each statement and
 *    restores it in `finally`. Postgres runs when DATABASE_URL is set (testBackends) and checks the database name
 *    first. The Rust half needs the addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: a version stored without a body (only a segmented page writes one; the Rust store unit test covers
 *    the probe), a held generation's items (recordHeldGenerationRow writes none; the Rust store unit test covers the
 *    state filter), and the VERSIONS_MAX stop after 1000 versions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { factsFenceHeld, moveKeptRows, type FenceRowRef } from '../src/core/generations/fence-evidence.ts';
import { factRowIdentity, fenceOwnerKey, fenceRowKey, FACT_FENCE_KIND } from '../src/core/generations/fence.ts';
import { FACTS_FENCE } from './pathological/managed-fixture.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

/** The statements fence-evidence.ts sent through executeRaw at 0120895e02, plus a byte-order ORDER BY. */
const OLD = {
  recorded: `SELECT DISTINCT i.item_key COLLATE "C" AS item_key FROM derived_generation_items i
      JOIN derived_generations g ON g.id = i.generation_id
     WHERE g.source_id = $1 AND g.kind = $2 AND g.owner_key = $3 AND g.state <> 'held' AND i.action <> 'retired' AND i.item_key = ANY($4::text[])
     ORDER BY item_key`,
  bodyless: `SELECT 1 FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NULL LIMIT 1`,
  versions: `SELECT v.id, v.compiled_truth, v.timeline FROM page_versions v
        JOIN pages p ON p.id = v.page_id
       WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NOT NULL AND ($3::bigint IS NULL OR v.id < $3::bigint)
         AND (strpos(v.compiled_truth, 'gbrain:facts:') > 0 OR strpos(COALESCE(v.timeline, ''), 'gbrain:facts:') > 0)
       ORDER BY v.id DESC LIMIT $4`,
  move: `UPDATE facts f SET row_num = m.next FROM (
      SELECT k.id, b.top + row_number() OVER (ORDER BY k.row_num, k.id) AS next FROM facts k,
        (SELECT GREATEST(COALESCE((SELECT max(row_num) FROM facts WHERE source_id = $1 AND source_markdown_slug = $2), 0),
          COALESCE((SELECT max(c) FROM unnest($4::integer[]) AS c), 0)) AS top) b
       WHERE k.source_id = $1 AND k.id = ANY($3::bigint[]) AND k.row_num = ANY($4::integer[])) m
    WHERE f.id = m.id`,
};
const NAME = new Map(Object.entries(OLD).map(([name, sql]) => [sql, name]));

const SRC = 'default';
const SLUG = 'fence-evidence-walk/alice';
const OTHER = 'fence-evidence-walk/bob';
const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | private | medium | 2020-01-01 |  | chat |  |`;
const CLAIMS: Record<number, string> = { 1: 'Alice founded acme-example', 2: 'Alice plays chess', 3: 'Alice lives in Lisbon', 4: 'Alice speaks Portuguese',
  9: 'Alice was never in a fence' };
const keyOf = (n: number) => fenceRowKey(n, factRowIdentity({ row_num: n, fact: CLAIMS[n]!, visibility: 'private' }));
const ref = (id: number, n: number | null): FenceRowRef => ({ id, row_num: n, fact: n == null ? 'unnumbered' : CLAIMS[n]!, visibility: 'private' });
const ledger = (n: number, action: string) => ({ item_key: keyOf(n), identity_hash: `id-${n}`, action, preimage: null, preimage_bytes: null, pending: false });
const activation = (generation: number) => ({ generation, runId: null, operationId: `op-${generation}`, inputPin: `pin-${generation}`, inputSize: 1,
  completeness: JSON.stringify({ complete: true }), setHash: `set-${generation}`, restoreOf: null, activationId: null, locator: null });

/** The fence evidence walk each engine runs; every engine must answer the same EXPECTED. */
async function walk(engine: BrainEngine) {
  // Stored versions: a fence holding row 2, a body without the marker, a fence holding row 3.
  const bodies = [`v-one\n\n${FACTS_FENCE(ROW(2, CLAIMS[2]!))}`, 'v-two has no fence', `v-three\n\n${FACTS_FENCE(ROW(3, CLAIMS[3]!))}`];
  for (const body of bodies) {
    await engine.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: body });
    await engine.createVersion(SLUG, { sourceId: SRC });
  }
  await engine.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: 'the page now' });
  const label = (rows: Array<{ id: number | string; compiled_truth: string; timeline: string | null }>) =>
    rows.map(row => ({ first: row.compiled_truth.split('\n')[0], timeline: row.timeline ?? null, id: typeof Number(row.id) }));
  const all = await engine.listFenceVersionBodies(SRC, SLUG, null, 50);
  const ids = all.map(row => Number(row.id));
  const versions = label(all);
  const belowNewest = label(await engine.listFenceVersionBodies(SRC, SLUG, ids[0]!, 50));
  const limited = label(await engine.listFenceVersionBodies(SRC, SLUG, null, 1));
  const none = label(await engine.listFenceVersionBodies(SRC, SLUG, null, 0));
  const missingVersions = await engine.listFenceVersionBodies(SRC, 'fence-evidence-walk/nobody', null, 50);
  const bodyless = await engine.hasBodylessPageVersion(SRC, SLUG);
  const bodylessMissing = await engine.hasBodylessPageVersion(SRC, 'fence-evidence-walk/nobody');

  // The ledger: generation 1 records rows 1 and 4, generation 2 keeps row 1 and retires row 4; another page records row 9.
  const key = { sourceId: SRC, kind: FACT_FENCE_KIND, ownerKey: fenceOwnerKey(SLUG) };
  await engine.transaction(async tx => {
    const first = await tx.activateGenerationRows(key, null, activation(1), [ledger(1, 'published'), ledger(4, 'published')]);
    await tx.activateGenerationRows(key, first, activation(2), [ledger(1, 'kept'), ledger(4, 'retired')]);
    await tx.activateGenerationRows({ ...key, ownerKey: fenceOwnerKey(OTHER) }, null, activation(1), [ledger(9, 'published')]);
  });
  // The statement has no ORDER BY; the walk compares the set in key order.
  const recorded = (await engine.listRecordedFenceItemKeys(key, [keyOf(9), keyOf(4), keyOf(1), keyOf(1), 'no-such-key']))
    .sort((a, b) => (a.item_key < b.item_key ? -1 : a.item_key > b.item_key ? 1 : 0));
  const recordedEmpty = await engine.listRecordedFenceItemKeys(key, []);
  const recordedOtherKind = await engine.listRecordedFenceItemKeys({ ...key, kind: 'take_fence' }, [keyOf(1)]);

  const heldOf = async (rows: FenceRowRef[], prior?: Set<string>) => {
    const out = await factsFenceHeld(engine, { sourceId: SRC, slug: SLUG, rows, prior });
    return { held: [...out.held].sort((a, b) => a - b), complete: out.complete };
  };
  const held = await heldOf([ref(101, 1), ref(102, 2), ref(103, 3), ref(104, 4), ref(109, 9), ref(110, null)]);
  const heldNone = await heldOf([ref(110, null)]);
  const heldPrior = await heldOf([ref(109, 9)], new Set([`9\u0000${CLAIMS[9]}\u0000private`]));

  // The move: rows 1, 2 and 3 of the page; rows 1 and 2 are claimed (with 7), row 3 is not; row 5 of another page is claimed.
  const inserted = await engine.insertFacts([1, 2, 3].map(n => ({ fact: CLAIMS[n]!, kind: 'fact' as const, entity_slug: SLUG, source: 'test',
    row_num: n, source_markdown_slug: SLUG })), { source_id: SRC });
  const otherRow = await engine.insertFacts([{ fact: 'Bob row', kind: 'fact' as const, entity_slug: OTHER, source: 'test', row_num: 2,
    source_markdown_slug: OTHER }], { source_id: SRC });
  const [r1, r2, r3] = inserted.ids;
  const numbers = async (slug: string) => (await engine.listFactsForPage(SRC, slug)).map(row => ({ id: Number(row.id), row_num: Number(row.row_num) }))
    .sort((a, b) => a.id - b.id).map(row => ({ who: [r1, r2, r3, otherRow.ids[0]].indexOf(row.id), row_num: row.row_num }));
  await engine.transaction(tx => moveKeptRows(tx, SRC, SLUG, [], [1]));
  await engine.transaction(tx => moveKeptRows(tx, SRC, SLUG, [r1!], []));
  const unmoved = await numbers(SLUG);
  await engine.transaction(tx => moveKeptRows(tx, SRC, SLUG, [r3!, r2!, r1!], [2, 1, 7]));
  const moved = await numbers(SLUG);
  // A claimed row of another page moves too: the statement does not name the page for the moving rows.
  await engine.transaction(tx => moveKeptRows(tx, SRC, SLUG, [otherRow.ids[0]!], [2]));
  const movedOther = await numbers(OTHER);
  return { versions, belowNewest, limited, none, missingVersions, bodyless, bodylessMissing, recorded, recordedEmpty, recordedOtherKind,
    held, heldNone, heldPrior, unmoved, moved, movedOther };
}

const V = (first: string) => ({ first, timeline: '', id: 'number' });
const EXPECTED: Record<string, unknown> = {
  versions: [V('v-three'), V('v-one')],
  belowNewest: [V('v-one')],
  limited: [V('v-three')],
  none: [],
  missingVersions: [],
  bodyless: false,
  bodylessMissing: false,
  // Generation 1 is superseded, not held, so its published row 4 still counts as recorded.
  recorded: [keyOf(1), keyOf(4)].sort().map(item_key => ({ item_key })),
  recordedEmpty: [],
  recordedOtherKind: [],
  held: { held: [101, 102, 103, 104], complete: true },
  heldNone: { held: [], complete: true },
  heldPrior: { held: [109], complete: true },
  unmoved: [{ who: 0, row_num: 1 }, { who: 1, row_num: 2 }, { who: 2, row_num: 3 }],
  moved: [{ who: 0, row_num: 8 }, { who: 1, row_num: 9 }, { who: 2, row_num: 3 }],
  movedOther: [{ who: 3, row_num: 10 }],
};

async function clean(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug LIKE 'fence-evidence-walk/%'`, [SRC]);
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key LIKE 'page:fence-evidence-walk/%'`, [SRC, FACT_FENCE_KIND]);
  await engine.executeRaw(`DELETE FROM pages WHERE source_id=$1 AND slug LIKE 'fence-evidence-walk/%'`, [SRC]);
}

describe('facts fence evidence on every engine', () => {
  let pg: PGLiteEngine;
  let pgHome: string;
  const quiet = console.error;

  beforeAll(async () => {
    console.error = () => {};
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-generation-fence-evidence-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    console.error = quiet;
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements fence-evidence.ts always sent', async () => {
    await clean(pg);
    const sent: Array<{ name: string; params: unknown[] | undefined }> = [];
    const proto = PGLiteEngine.prototype as unknown as { executeRaw: BrainEngine['executeRaw'] };
    const original = proto.executeRaw;
    proto.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      const name = NAME.get(sql);
      if (name) sent.push({ name, params });
      return original.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      await factsFenceHeld(pg, { sourceId: SRC, slug: SLUG, rows: [ref(101, 1), ref(110, null)] });
      await pg.transaction(tx => moveKeptRows(tx, SRC, SLUG, [5, 6], [1, 7]));
      expect(sent).toEqual([
        { name: 'recorded', params: [SRC, FACT_FENCE_KIND, fenceOwnerKey(SLUG), [keyOf(1)]] },
        { name: 'bodyless', params: [SRC, SLUG] },
        { name: 'versions', params: [SRC, SLUG, null, 50] },
        { name: 'move', params: [SRC, SLUG, [5, 6], [1, 7]] },
      ]);
    } finally {
      proto.executeRaw = original;
      await clean(pg);
    }
  });

  test('PGLite walks the facts fence evidence', async () => {
    await clean(pg);
    expect(await walk(pg)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    await clean(pg);
  });

  postgresRun('Postgres walks the facts fence evidence', async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 4 } as never);
    try {
      await engine.initSchema();
      await clean(engine);
      expect(await walk(engine)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    } finally {
      await clean(engine).catch(() => {});
      await engine.disconnect();
    }
  }, 60_000);

  rustRun('Rust walks the facts fence evidence', async () => {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    try {
      expect(await walk(engine)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    } finally {
      await engine.disconnect().catch(() => {});
      removeBrainDir(brain.dir);
    }
  }, 60_000);
});
