/**
 * BrainEngine parity — the import overlay's take purge match (engine-sql/trust-withdrawals.ts `listPurgedTakeRows`,
 * facts/purge-overlay.ts `dropPurgedFenceRows`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `listPurgedTakeRows` answers the row numbers of the incoming take rows whose claim fingerprint a take
 *    tombstone of the source names, under subject '*' or the subject (any subject when the subject is null), each
 *    once; a tombstone of another source names nothing. The overlay drops those rows from a takes fence, reserves
 *    their numbers and keeps the other rows and reservations.
 *  - Regression: the overlay's take match ran through `executeRaw`, which the Rust engine refuses, so an import on a
 *    Rust brain could not drop a purged take row that PGLite and Postgres dropped.
 *  - Why existing coverage misses it: test/purge-overlay-reservations.test.ts runs PGLite only, and
 *    take-purge-ledger.test.ts checks the probe and the guard, not the match.
 *  - Seam: none. Real engines, typed methods only. The match has no set order, so the case sorts it.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dropPurgedFenceRows } from '../../src/core/facts/purge-overlay.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, renderTakesFence } from '../../src/core/takes-fence.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/take-overlay-example';
const OTHER = 'people/other-take-overlay-example';
const REQUEST = '6f9619ff-8b86-4d01-b42d-00cf4fc964ab';

/** The claim's fingerprint, as purge_fact reads it (loadPurgeTarget over a fact of the same text). */
async function fingerprintOf(engine: BrainEngine, rowNum: number, claim: string): Promise<string> {
  const out = await engine.insertFacts([{ fact: claim, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: rowNum, kind: 'fact',
    visibility: 'world', source: 'fence' }] as never, { source_id: SRC }) as { ids: number[] };
  return (await engine.loadPurgeTarget(out.ids[0]!, SRC))!.fact_hash;
}

async function tombstone(engine: BrainEngine, sourceId: string, subject: string, rowNum: number, claim: string): Promise<void> {
  await engine.insertTakePurge({ sourceId, subject, claimHash: await fingerprintOf(engine, rowNum, claim), requestId: REQUEST });
}

const sorted = (rows: number[]) => [...rows].sort((a, b) => a - b);

/** One take row as the fence parser reads it. */
const take = (rowNum: number, claim: string) => parseTakesFence(`${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| ${rowNum} | ${claim} | take | alice-example | 0.5 |  | chat |
${TAKES_FENCE_END}`).takes[0]!;

describe('engine parity: the take purge overlay', () => {
  parityTest('listPurgedTakeRows names the rows a tombstone of the source covers, for subject * or the subject', {
    methods: ['insertFacts', 'loadPurgeTarget', 'insertTakePurge', 'listPurgedTakeRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await tombstone(engine, SRC, '*', 1, 'Acme will win the market');
    await tombstone(engine, SRC, SLUG, 2, 'Widgets sell out');
    await tombstone(engine, SRC, OTHER, 3, 'Rates fall in spring');
    await tombstone(engine, 'work', '*', 4, 'Prices rise in summer');
    const takes = [
      { row_num: 1, claim: 'Acme will win the market' }, { row_num: 2, claim: 'Widgets sell out' },
      { row_num: 3, claim: 'Rates fall in spring' }, { row_num: 4, claim: 'Prices rise in summer' },
      { row_num: 5, claim: '  ACME will win   the market. ' }, { row_num: 6, claim: 'A claim nobody purged' },
      { row_num: 5, claim: 'Widgets sell out' },
    ];
    const out = {
      subject: sorted(await engine.listPurgedTakeRows(SRC, takes, SLUG)),
      other: sorted(await engine.listPurgedTakeRows(SRC, takes, OTHER)),
      anySubject: sorted(await engine.listPurgedTakeRows(SRC, takes, null)),
      work: sorted(await engine.listPurgedTakeRows('work', takes, SLUG)),
      none: await engine.listPurgedTakeRows(SRC, [], SLUG),
    };
    expect(out).toEqual({ subject: [1, 2, 5], other: [1, 3, 5], anySubject: [1, 2, 3, 5], work: [4], none: [] });
    return out;
  });

  parityTest('the import overlay drops a purged take row and reserves its number', {
    methods: ['insertFacts', 'loadPurgeTarget', 'insertTakePurge', 'readSourcePurgeFlags', 'listPurgedTakeRows'],
  }, async (engine) => {
    await tombstone(engine, SRC, '*', 1, 'Purge this claim');
    await tombstone(engine, SRC, SLUG, 2, 'Purge this one for the page');
    const fence = renderTakesFence([take(1, 'Keep this claim'), take(3, 'Purge this claim'), take(4, 'Purge this one for the page'),
      take(5, 'Keep this one too')], [2]);
    const body = `# Page\n\n${fence}\n`;
    const forPage = await dropPurgedFenceRows(engine, SRC, body, SLUG);
    const forOther = await dropPurgedFenceRows(engine, SRC, body, OTHER);
    const read = (text: string) => {
      const parsed = parseTakesFence(text);
      return { takes: parsed.takes.map(t => [t.rowNum, t.claim]), reserved: sorted(parsed.reservedRowNums), warnings: parsed.warnings };
    };
    const out = { forPage: read(forPage), forOther: read(forOther) };
    expect(out).toEqual({
      forPage: { takes: [[1, 'Keep this claim'], [5, 'Keep this one too']], reserved: [2, 3, 4], warnings: [] },
      forOther: { takes: [[1, 'Keep this claim'], [4, 'Purge this one for the page'], [5, 'Keep this one too']], reserved: [2, 3], warnings: [] },
    });
    return { out, forPage };
  });
});
