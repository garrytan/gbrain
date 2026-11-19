/**
 * BrainEngine parity — the fact purge ledger (engine-sql/facts-purge.ts `insertFactPurge`) and the reads and writes
 * that honour it: the fence overlay's `purged` (engine-sql/cli-reads-ops.ts `readFenceOverlayRows`), the belief
 * ledger's purge probe (`readLedgerSource`), and the guard that refuses a purged claim on insert
 * (facts/insert-guard-schema.ts `gbrain_guard_inserted_facts`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a purge tombstone (source, visibility, subject, fingerprint) is stored once; the fence overlay reports
 *    a world row purged when a tombstone at its visibility names its fingerprint under subject '*' or the page;
 *    the source then reports purges possible; and inserting the claim again, for subject '*', the entity, or an
 *    unbacked name key, refuses with `purged_content` and saves nothing; an extraction outcome marker is not refused.
 *  - Regression: purge_fact wrote the tombstone through `executeRaw`, which the Rust engine refuses, so a Rust brain
 *    kept no purges: `purged` was always false, `purgesPossible` was always false and a purged claim could be saved
 *    again, while PGLite and Postgres hid and refused it.
 *  - Why existing coverage misses it: test/fact-purge*.test.ts run the SQL engines only, and the fence overlay parity
 *    case seeds no purge.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/purge-example';
const OTHER = 'people/other-purge-example';
const REQUEST = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
/** An extraction outcome source (facts/audit-sources.ts); its EXTRACTION_COMPLETE row is a marker, not a claim. */
const TERMINAL = 'cli:extract-conversation-facts:terminal:v2';

/** Inserts one fence fact of SLUG and returns its fingerprint (loadPurgeTarget, the purge's own read). */
async function fingerprintOf(engine: BrainEngine, rowNum: number, claim: string, visibility: 'world' | 'private' = 'world'): Promise<string> {
  const out = await engine.insertFacts([{ fact: claim, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: rowNum, kind: 'fact', visibility,
    source: 'fence' }] as never, { source_id: SRC }) as { ids: number[] };
  const target = await engine.loadPurgeTarget(out.ids[0]!, SRC);
  return target!.fact_hash;
}

const purge = (engine: BrainEngine, visibility: string, subject: string, factHash: string) =>
  engine.insertFactPurge({ sourceId: SRC, visibility, subject, factHash, requestId: REQUEST, actor: 'owner:local', reason: 'parity' });

const refusal = async (run: () => Promise<unknown>) => {
  try { await run(); return 'saved'; } catch (e) { return (e as Error).message; }
};

describe('engine parity: the fact purge ledger', () => {
  parityTest('insertFactPurge stores a tombstone once and the fence overlay reports it', {
    methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'insertFactPurge', 'readFenceOverlayRows', 'readLedgerSource'],
  }, async (engine) => {
    await engine.putPage(SLUG, { type: 'person', title: 'Ana Example', compiled_truth: 'Ana Example.', timeline: '' });
    const before = (await engine.readLedgerSource(SRC))?.purgesPossible;
    const bees = await fingerprintOf(engine, 1, 'Ana keeps bees');
    const paints = await fingerprintOf(engine, 2, 'Ana paints');
    const opera = await fingerprintOf(engine, 3, 'Ana sings opera');
    const swims = await fingerprintOf(engine, 4, 'Ana swims daily');
    const inserted = [
      await purge(engine, 'world', '*', bees),
      await purge(engine, 'world', '*', bees),
      await purge(engine, 'world', SLUG, paints),
      await purge(engine, 'world', OTHER, opera),
      await purge(engine, 'private', '*', swims),
    ];
    expect(inserted).toEqual([true, false, true, true, true]);
    const after = (await engine.readLedgerSource(SRC))?.purgesPossible;
    expect({ before, after }).toEqual({ before: false, after: true });
    const incoming = [['Ana keeps bees', 1], ['Ana paints', 2], ['Ana sings opera', 3], ['Ana swims daily', 4], ['  ANA keeps   bees. ', 5]]
      .map(([claim, row_num]) => ({ row_num: row_num as number, claim: claim as string, visibility: 'world', fp: null }));
    const rows = await engine.readFenceOverlayRows({ sourceId: SRC, slug: SLUG }, incoming, { hideHeld: false });
    const purged = rows.map(r => [r.row_num, r.purged]);
    expect(purged).toEqual([[1, true], [2, true], [3, false], [4, false], [5, true]]);
    return { inserted, before, after, purged };
  });

  parityTest('a purged claim refuses on insert for every subject the tombstone reaches', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'loadPurgeTarget', 'insertFactPurge', 'listFactsByEntity'],
  }, async (engine) => {
    await engine.putPage(SLUG, { type: 'person', title: 'Ana Example', compiled_truth: 'Ana Example.', timeline: '' });
    const bees = await fingerprintOf(engine, 1, 'Ana keeps bees');
    const paints = await fingerprintOf(engine, 2, 'Ana paints');
    await purge(engine, 'world', '*', bees);
    await purge(engine, 'world', SLUG, paints);
    await purge(engine, 'world', '*', await fingerprintOf(engine, 3, 'EXTRACTION_COMPLETE'));
    const row = (fact: string, entity: string | null, rowNum: number | null, visibility = 'world') => ({ fact, entity_slug: entity,
      source_markdown_slug: rowNum === null ? null : SLUG, row_num: rowNum, kind: 'fact', visibility, source: 'fence' });
    const out = {
      globalBatch: await refusal(() => engine.insertFacts([row('Ana likes tea', SLUG, 10), row('ana KEEPS bees', SLUG, 11)] as never, { source_id: SRC })),
      globalSingle: await refusal(() => engine.insertFact(row('Ana keeps bees.', OTHER, null) as never, { source_id: SRC })),
      subject: await refusal(() => engine.insertFacts([row('Ana paints', SLUG, 12)] as never, { source_id: SRC })),
      unbackedName: await refusal(() => engine.insertFact(row('Ana paints', 'ana', null) as never, { source_id: SRC })),
      otherSubject: await refusal(() => engine.insertFact(row('Ana paints', OTHER, null) as never, { source_id: SRC })),
      otherVisibility: await refusal(() => engine.insertFacts([row('Ana keeps bees', SLUG, 13, 'private')] as never, { source_id: SRC })),
      marker: await refusal(() => engine.insertFacts([{ ...row('EXTRACTION_COMPLETE', SLUG, 14), source: TERMINAL }] as never, { source_id: SRC })),
      notMarker: await refusal(() => engine.insertFacts([row('EXTRACTION_COMPLETE', SLUG, 15)] as never, { source_id: SRC })),
    };
    expect(out.globalBatch).toStartWith('purged_content: this claim was purged from this source and cannot be saved again');
    expect(out.globalSingle).toStartWith('purged_content:');
    expect(out.subject).toStartWith('purged_content:');
    expect(out.unbackedName).toStartWith('purged_content:');
    expect(out.notMarker).toStartWith('purged_content:');
    expect(out).toMatchObject({ otherSubject: 'saved', otherVisibility: 'saved', marker: 'saved' });
    const kept = (await engine.listFactsByEntity(SRC, SLUG, { activeOnly: false } as never)).map(f => f.fact).sort();
    expect(kept).toEqual(['Ana keeps bees', 'Ana keeps bees', 'Ana paints', 'EXTRACTION_COMPLETE', 'EXTRACTION_COMPLETE']);
    return { out, kept };
  });
});
