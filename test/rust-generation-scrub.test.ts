/**
 * The purge scrub of the generation ledger (generations/ledger-scrub.ts) on PGLite, Postgres and a Rust brain: the page
 * scrub and the text scrub as typed engine members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: the seven statements scrubGenerationLedger always sent, byte for byte with the same parameters, now that
 *    they are engine members (engine-sql/generation-ledger.ts), and a Rust brain answers the same walk: a page scrub
 *    deletes the page's held fence rows, nulls the purged item's preimages and every held proposal naming the page, and
 *    drops the page's recorded fence blocks; a text scrub nulls the preimages, held proposals, held contexts and fence
 *    blocks whose lowered jsonb text carries a needle (or its JSON-escaped form); another source is untouched and a
 *    second scrub changes nothing.
 *  - Regression: the statements went through `executeRaw`, which the Rust engine refuses (`raw_sql`), so the ledger
 *    scrub stopped at its first statement on a Rust brain (0120895e02).
 *  - Why existing coverage misses it: test/pathological/g1-*.test.ts and g2-*.test.ts reach the scrub through purge on
 *    the SQL engines only, and both callers (persistence/page-purge.ts, facts/purge.ts) still read through raw SQL elsewhere, so a Rust purge
 *    never reaches the scrub; this test calls scrubGenerationLedger directly.
 *  - Seam: the rows are seeded and read back through typed engine members (activateGenerationRows,
 *    recordHeldGenerationRow, heldGenerationRowsForInput, readHeldGenerationContext); a scrubbed preimage shows as a later
 *    scrub that no longer matches it. The PGLite pin wraps PGLiteEngine.prototype.executeRaw to record each statement and
 *    restores it in `finally`. Postgres runs when DATABASE_URL is set (testBackends) and checks the database name first.
 *    The Rust half needs the addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: the purge commands that call the scrub (other raw statements in those paths), and non-ASCII case
 *    folding, which follows each database's own `lower()`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { scrubGenerationLedger } from '../src/core/generations/ledger-scrub.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

/** The statements ledger-scrub.ts sent through executeRaw at 0120895e02, byte for byte. */
const OLD = {
  pageHolds: `DELETE FROM derived_generations WHERE source_id=$1 AND kind=ANY($2::text[]) AND owner_key='page:' || $3::text
      AND state='held' RETURNING 1`,
  pageItems: `UPDATE derived_generation_items i SET preimage=NULL FROM derived_generations g
      WHERE g.id=i.generation_id AND g.source_id=$1 AND i.item_key=$2 AND i.preimage IS NOT NULL RETURNING 1`,
  pageProposals: `UPDATE derived_generations SET proposal=NULL, updated_at=now()
      WHERE source_id=$1 AND proposal IS NOT NULL AND (right(owner_key, length($2) + 1) = ':' || $2 OR proposal @> jsonb_build_array(jsonb_build_object('key', $2::text)))
      RETURNING 1`,
  pageFences: `UPDATE derived_generations SET completeness=completeness - 'fence'::text, updated_at=now()
      WHERE source_id=$1 AND owner_key='page:' || $2::text AND completeness->'fence' IS NOT NULL RETURNING 1`,
  textItems: `UPDATE derived_generation_items i SET preimage=NULL FROM derived_generations g
    WHERE g.id=i.generation_id AND g.source_id=$1 AND i.preimage IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(i.preimage::text), n) > 0) RETURNING 1`,
  textHeld: `UPDATE derived_generations SET proposal=NULL, held_context=NULL, updated_at=now()
    WHERE source_id=$1 AND (proposal IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(proposal::text), n) > 0) OR held_context IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(held_context::text), n) > 0)) RETURNING 1`,
  textFences: `UPDATE derived_generations SET completeness=completeness - 'fence'::text, updated_at=now()
    WHERE source_id=$1 AND completeness->'fence' IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower((completeness->'fence')::text), n) > 0) RETURNING 1`,
};
const NAME = new Map(Object.entries(OLD).map(([name, sql]) => [sql, name]));

const SRC = 'default';
const FENCE_HOLD = { sourceId: SRC, kind: 'fact_fence', ownerKey: 'page:notes/a' };
const LIVE = { sourceId: SRC, kind: 'scrub_walk', ownerKey: 'page:notes/a' };
const PROPOSING = { sourceId: SRC, kind: 'scrub_walk', ownerKey: 'input:q' };
const QUOTED = { sourceId: SRC, kind: 'scrub_walk', ownerKey: 'page:notes/c' };

const held = (holdId: string, inputPin: string, context: unknown, proposal: unknown) => ({ holdId, runId: null, inputPin, inputSize: 1, setHash: 'h',
  reason: 'no_proof', context: JSON.stringify(context), proposal: JSON.stringify(proposal), proposalBytes: 2 });

async function seed(engine: BrainEngine): Promise<void> {
  await engine.transaction(tx => tx.recordHeldGenerationRow(FENCE_HOLD, held('hold-1', 'p1', { slug: 'notes/a' }, [])));
  await engine.transaction(tx => tx.activateGenerationRows(LIVE, null, { generation: 1, runId: null, operationId: 'scrub-op', inputPin: 'p2', inputSize: 1,
    completeness: JSON.stringify({ fence: { text: 'Hello World' }, complete: true }), setHash: 'h', restoreOf: null, activationId: null, locator: null }, [
    { item_key: 'notes/a', identity_hash: 'a', action: 'published', preimage: { body: 'Hello World' }, preimage_bytes: 20, pending: false },
    { item_key: 'notes/b', identity_hash: 'b', action: 'published', preimage: { body: 'other text' }, preimage_bytes: 20, pending: false },
  ]));
  await engine.transaction(tx => tx.recordHeldGenerationRow(PROPOSING, held('hold-2', 'p3', { note: 'HELLO world' }, [{ key: 'notes/a', n: 1 }])));
  await engine.transaction(tx => tx.recordHeldGenerationRow(QUOTED, held('hold-3', 'p4', { note: 'say "hi" again' }, [{ key: 'notes/c' }])));
}

/** The scrub walk each engine runs; every engine must answer the same EXPECTED. */
async function walk(engine: BrainEngine) {
  await seed(engine);
  const scrub = (target: { slug: string } | { needles: readonly string[] }, sourceId = SRC) =>
    engine.transaction(tx => scrubGenerationLedger(tx, sourceId, target));
  const noNeedles = await scrub({ needles: [''] });
  const otherSource = await scrub({ slug: 'notes/a' }, 'elsewhere');
  const page = await scrub({ slug: 'notes/a' });
  const fenceHoldGone = await engine.heldGenerationRowsForInput(FENCE_HOLD, 'p1');
  const proposingKept = await engine.readHeldGenerationContext(PROPOSING, 'hold-2');
  const pageAgain = await scrub({ slug: 'notes/a' });
  // notes/a's preimage and the live row's fence block are gone, so only hold-2's context still says hello world.
  const hello = await scrub({ needles: ['Hello World'] });
  const proposingScrubbed = await engine.readHeldGenerationContext(PROPOSING, 'hold-2');
  const other = await scrub({ needles: ['OTHER text'] });
  // The JSON-escaped form of the needle matches the jsonb text of the context.
  const quoted = await scrub({ needles: ['SAY "hi"'] });
  const quotedRow = await engine.heldGenerationRowsForInput(QUOTED, 'p4');
  const quotedContext = await engine.readHeldGenerationContext(QUOTED, 'hold-3');
  const textAgain = await scrub({ needles: ['hello world', 'other text', 'say "hi"'] });
  return { noNeedles, otherSource, page, fenceHoldGone, proposingKept, pageAgain, hello, proposingScrubbed, other, quoted, quotedRow, quotedContext, textAgain };
}

const none = { derived_generation_items: 0, derived_generations: 0 };
const EXPECTED: Record<string, unknown> = {
  noNeedles: none,
  otherSource: none,
  // hold-1 deleted, hold-2's proposal nulled, the live row's fence block dropped; notes/a's preimage nulled.
  page: { derived_generation_items: 1, derived_generations: 3 },
  fenceHoldGone: [],
  proposingKept: { held_context: { note: 'HELLO world' } },
  pageAgain: none,
  hello: { derived_generation_items: 0, derived_generations: 1 },
  proposingScrubbed: { held_context: null },
  other: { derived_generation_items: 1, derived_generations: 0 },
  quoted: { derived_generation_items: 0, derived_generations: 1 },
  quotedRow: [{ hold_id: 'hold-3', item_set_hash: 'h', held_reason: 'no_proof' }],
  quotedContext: { held_context: null },
  textAgain: none,
};

async function clean(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind IN ('fact_fence', 'scrub_walk')`, [SRC]);
}

describe('scrubGenerationLedger on every engine', () => {
  let pg: PGLiteEngine;
  let pgHome: string;
  const quiet = console.error;

  beforeAll(async () => {
    console.error = () => {};
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-generation-scrub-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    console.error = quiet;
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements ledger-scrub.ts always sent', async () => {
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
      await scrubGenerationLedger(pg, SRC, { slug: 'notes/a' });
      expect(sent).toEqual([
        { name: 'pageHolds', params: [SRC, ['fact_fence', 'take_fence'], 'notes/a'] },
        { name: 'pageItems', params: [SRC, 'notes/a'] },
        { name: 'pageProposals', params: [SRC, 'notes/a'] },
        { name: 'pageFences', params: [SRC, 'notes/a'] },
      ]);
      sent.length = 0;
      await scrubGenerationLedger(pg, SRC, { needles: ['Say "Hi"', ''] });
      const needles = ['say "hi"', 'say \\"hi\\"'];
      expect(sent).toEqual([
        { name: 'textItems', params: [SRC, needles] },
        { name: 'textHeld', params: [SRC, needles] },
        { name: 'textFences', params: [SRC, needles] },
      ]);
      sent.length = 0;
      await scrubGenerationLedger(pg, SRC, { needles: [''] });
      expect(sent).toEqual([]);
    } finally {
      proto.executeRaw = original;
    }
  });

  test('PGLite walks a scrub', async () => {
    await clean(pg);
    expect(await walk(pg)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    await clean(pg);
  });

  postgresRun('Postgres walks a scrub', async () => {
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

  rustRun('Rust walks a scrub', async () => {
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
