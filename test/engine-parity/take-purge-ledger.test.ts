/**
 * BrainEngine parity — the take purge ledger (engine-sql/facts-purge.ts `insertTakePurge`), the import overlay's
 * take purge probe (engine-sql/trust-withdrawals.ts `readSourcePurgeFlags`) and the guard that refuses a purged take
 * claim (facts/purge-schema.ts `gbrain_refuse_purged_take`, trigger `takes_refuse_purged`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a take tombstone (source, subject, fingerprint) is stored once and the source then reports a take
 *    purge; a take on a page of the source whose claim has the fingerprint, under subject '*' or the page's slug,
 *    refuses with `purged_content` on every insert (an unchanged upsert row too, as the BEFORE INSERT trigger runs on
 *    each proposed row) and on supersede; the whole batch saves nothing; a tombstone for another page, another
 *    source or another claim refuses nothing; an update that sets no claim is not refused.
 *  - Regression: the Rust store kept no take purge ledger, so `readSourcePurgeFlags` answered takes false and a
 *    purged take claim could be added again, while PGLite and Postgres reported and refused it.
 *  - Why existing coverage misses it: the take purge tests run the SQL engines only, and no parity case writes a
 *    take tombstone.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, TakeBatchInput } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/take-purge-example';
const OTHER = 'people/other-take-purge-example';
const REQUEST = '6f9619ff-8b86-4d01-b42d-00cf4fc964aa';

/** The claim's fingerprint, as purge_fact reads it (loadPurgeTarget over a fact of the same text). */
async function fingerprintOf(engine: BrainEngine, rowNum: number, claim: string): Promise<string> {
  const out = await engine.insertFacts([{ fact: claim, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: rowNum, kind: 'fact',
    visibility: 'world', source: 'fence' }] as never, { source_id: SRC }) as { ids: number[] };
  return (await engine.loadPurgeTarget(out.ids[0]!, SRC))!.fact_hash;
}

const purge = (engine: BrainEngine, subject: string, claimHash: string, sourceId = SRC) =>
  engine.insertTakePurge({ sourceId, subject, claimHash, requestId: REQUEST });

const refusal = async (run: () => Promise<unknown>) => {
  try { await run(); return 'saved'; } catch (e) { return (e as Error).message; }
};

async function pageId(engine: BrainEngine, slug: string): Promise<number> {
  await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: `${slug}.`, timeline: '' });
  return Number((await engine.getPage(slug))!.id);
}

const take = (page: number, row: number, claim: string): TakeBatchInput =>
  ({ page_id: page, row_num: row, claim, kind: 'take', holder: 'world', weight: 0.5 });

describe('engine parity: the take purge ledger', () => {
  parityTest('insertTakePurge stores a tombstone once and the source reports a take purge', {
    methods: ['insertTakePurge', 'readSourcePurgeFlags'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const before = await engine.readSourcePurgeFlags(SRC);
    const inserted = [await purge(engine, '*', 'a'.repeat(64)), await purge(engine, '*', 'a'.repeat(64)),
      await purge(engine, SLUG, 'a'.repeat(64))];
    const missing = await refusal(() => purge(engine, '*', 'b'.repeat(64), 'missing-source'));
    const after = { default: await engine.readSourcePurgeFlags(SRC), work: await engine.readSourcePurgeFlags('work') };
    expect(inserted).toEqual([true, false, true]);
    expect(missing).not.toBe('saved');
    expect({ before, after }).toEqual({ before: { facts: false, takes: false },
      after: { default: { facts: false, takes: true }, work: { facts: false, takes: false } } });
    return { inserted, before, after, missingRefused: missing !== 'saved' };
  });

  parityTest('a purged take claim refuses on insert, upsert and supersede for subject * and the page', {
    methods: ['putPage', 'getPage', 'insertFacts', 'loadPurgeTarget', 'insertTakePurge', 'addTakesBatch', 'supersedeTake',
      'updateTake', 'listTakes'],
  }, async (engine) => {
    const page = await pageId(engine, SLUG);
    const other = await pageId(engine, OTHER);
    await engine.addTakesBatch([take(page, 1, 'Acme will win the market'), take(page, 2, 'Rates fall in spring')]);
    await purge(engine, '*', await fingerprintOf(engine, 1, 'Acme will win the market'));
    await purge(engine, SLUG, await fingerprintOf(engine, 2, 'Widgets sell out'));
    await purge(engine, OTHER, await fingerprintOf(engine, 3, 'Rates fall in spring'));
    const out = {
      unchangedUpsert: await refusal(() => engine.addTakesBatch([take(page, 1, 'Acme will win the market')])),
      normalizedNew: await refusal(() => engine.addTakesBatch([take(page, 3, 'Fresh claim'), take(page, 4, '  ACME will win   the market. ')])),
      wildcardOtherPage: await refusal(() => engine.addTakesBatch([take(other, 1, 'Acme will win the market')])),
      subjectPage: await refusal(() => engine.addTakesBatch([take(page, 5, 'Widgets sell out')])),
      subjectOtherPage: await refusal(() => engine.addTakesBatch([take(other, 2, 'Widgets sell out')])),
      otherSubject: await refusal(() => engine.addTakesBatch([take(page, 6, 'Rates fall in spring')])),
      supersede: await refusal(() => engine.supersedeTake(page, 2, { claim: 'acme will win the market', kind: 'take', holder: 'world', weight: 0.5 })),
      updateNoClaim: await refusal(() => engine.updateTake(page, 1, { weight: 0.75 })),
    };
    expect(out.unchangedUpsert).toStartWith('purged_content: this take claim was purged from this source and cannot be saved again');
    expect(out.normalizedNew).toStartWith('purged_content:');
    expect(out.wildcardOtherPage).toStartWith('purged_content:');
    expect(out.subjectPage).toStartWith('purged_content:');
    expect(out.supersede).toStartWith('purged_content:');
    expect(out).toMatchObject({ subjectOtherPage: 'saved', otherSubject: 'saved', updateNoClaim: 'saved' });
    const list = async (id: number) => [...await engine.listTakes({ page_id: id }), ...await engine.listTakes({ page_id: id, active: false })]
      .map(t => [t.row_num, t.claim, t.weight, t.active]).sort((a, b) => Number(a[0]) - Number(b[0]));
    const takes = { page: await list(page), other: await list(other) };
    expect(takes).toEqual({
      page: [[1, 'Acme will win the market', 0.75, true], [2, 'Rates fall in spring', 0.5, true], [6, 'Rates fall in spring', 0.5, true]],
      other: [[2, 'Widgets sell out', 0.5, true]],
    });
    return { out, takes };
  });
});
