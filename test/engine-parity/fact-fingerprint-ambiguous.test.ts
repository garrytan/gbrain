/**
 * BrainEngine parity — a withdrawal or purge of one spelling of a claim never reaches a spelling only the old Postgres
 * whitespace fold took as the same.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a withdrawal or purge of "X Y" leaves "X\u1680Y" alone on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the fact guards neither refuse nor expire it, the take
 *    guard admits it, the withdrawal and purge checks answer false, and the fence overlays keep its row. The space
 *    spelling itself stays refused, expired and dropped.
 *  - Regression: Postgres matched every ledger hash also by the pre-v341 fingerprints (_v2, _v1), which fold the
 *    locale's [[:space:]]; on en_US.utf8 that takes U+1680, so the old hash of "X\u1680Y" is the current hash of
 *    "X Y" and a purge of "X Y" refused "X\u1680Y" on Postgres only.
 *  - Why existing coverage misses it: the fingerprint tests seed ledger rows under the old fingerprint of a claim
 *    holding U+0085 (where no current hash can collide), and PGLite's [[:space:]] is the explicit list, so only a
 *    Postgres arm writing a current hash and reading a U+1680 spelling shows it.
 *  - Seam: withdrawals and facts go through the typed insertFactWithdrawal, insertFact and insertFacts. The store has
 *    no member that writes a purge tombstone and no fact insert guard, so the purge cases seed fact_purges and
 *    take_purges with SQL and the guard cases read the facts back with SQL; the Rust arm stops on the typed raw_sql
 *    refusal there. Synthetic claims only.
 */
import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { FINGERPRINT_PUNCTUATION } from '../../src/core/facts/withdrawal-schema.ts';
import { isFactPurged, isFactWithdrawn } from '../../src/core/facts/withdrawal.ts';
import { dropPurgedFenceRows } from '../../src/core/facts/purge-overlay.ts';
import { loadFenceChunkOverlay } from '../../src/core/eligibility/fence-overlay.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const T1 = '2026-03-01T10:00:00.000Z';
const OGHAM = '\u1680';

/** The current fingerprint, as JavaScript (Rust's is_pg_space list), for the covering check's caller-side hash. */
const PG_SPACE = /[\u0009-\u000d \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+/gu;
const fingerprint = (claim: string) => {
  let out = '';
  for (const ch of claim.toLowerCase()) out += FINGERPRINT_PUNCTUATION.includes(ch) ? ' ' : ch;
  out = out.replace(PG_SPACE, ' ').replace(/\.(?=[. ]|$)/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
  return createHash('sha256').update(out).digest('hex');
};

const fence = (...claims: string[]) => renderFactsTable(claims.map((claim, i) => ({ rowNum: i + 1, claim, kind: 'fact' as const, confidence: 1,
  visibility: 'world' as const, notability: 'medium' as const, active: true, context: '' })));

/** Run `write`, answering 'saved' or the purge refusal it threw. */
async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return 'saved';
  } catch (error) {
    const text = String((error as Error)?.message ?? error);
    if (text.includes('purged_content')) return 'purged_content';
    throw error;
  }
}

/** Whether each fact of `entity` (by its claim) is expired, read with SQL (raw_sql cases only). */
async function expiredByClaim(engine: BrainEngine, entity: string): Promise<Record<string, boolean>> {
  const rows = await engine.executeRaw<{ fact: string; expired: boolean }>(
    `SELECT fact, expired_at IS NOT NULL AS expired FROM facts WHERE source_id = $1 AND entity_slug = $2 ORDER BY fact`, [SRC, entity]);
  return Object.fromEntries(rows.map(r => [r.fact, r.expired === true]));
}

describe('engine parity: a ledger row of one spelling never reaches a U+1680 spelling', () => {
  parityTest('a withdrawal of "X Y" covers that claim and not "X\\u1680Y" in the covering check and the fence dates', {
    methods: ['insertFactWithdrawal', 'hasCoveringFactWithdrawal', 'listFactWithdrawalDates'],
  }, async (engine) => {
    const spaced = 'Alpha withdrawn claim', ogham = `Alpha${OGHAM}withdrawn claim`;
    expect(await engine.insertFactWithdrawal(SRC, 'world', spaced, '*', T1)).toBe(true);
    const covering = {
      spaced: await engine.hasCoveringFactWithdrawal(SRC, 'world', fingerprint(spaced), spaced, 'people/alpha'),
      ogham: await engine.hasCoveringFactWithdrawal(SRC, 'world', fingerprint(ogham), ogham, 'people/alpha'),
    };
    expect(covering).toEqual({ spaced: true, ogham: false });
    const dates = (await engine.listFactWithdrawalDates(SRC, [{ row_num: 1, claim: spaced, visibility: 'world' }, { row_num: 2, claim: ogham, visibility: 'world' }], null))
      .map(r => ({ row_num: Number(r.row_num), withdrawn_at: new Date(r.withdrawn_at).toISOString() })).sort((a, b) => a.row_num - b.row_num);
    expect(dates).toEqual([{ row_num: 1, withdrawn_at: T1 }]);
    return { covering, dates };
  });

  // The withdrawal insert guard is a database trigger; the Rust store has none yet, so this case reads the facts it
  // wrote back with SQL and stops on the Rust arm's typed raw_sql refusal.
  parityTest('a withdrawal of "X Y" expires that claim and leaves "X\\u1680Y" active when either is written', {
    methods: ['insertFactWithdrawal', 'insertFact', 'insertFacts', 'executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const spaced = 'Beta withdrawn claim', ogham = `Beta${OGHAM}withdrawn claim`;
    await engine.insertFactWithdrawal(SRC, 'world', spaced, '*', T1);
    await engine.insertFact({ fact: ogham, visibility: 'world', entity_slug: 'people/alpha', source: 'chat' }, { source_id: SRC });
    await engine.insertFact({ fact: spaced, visibility: 'world', entity_slug: 'people/alpha', source: 'chat' }, { source_id: SRC });
    await engine.insertFacts([{ fact: ogham, visibility: 'world', entity_slug: 'people/beta', source: 'fence', row_num: 1, source_markdown_slug: 'notes/beta' },
      { fact: spaced, visibility: 'world', entity_slug: 'people/beta', source: 'fence', row_num: 2, source_markdown_slug: 'notes/beta' }], { source_id: SRC });
    const single = await expiredByClaim(engine, 'people/alpha');
    const batch = await expiredByClaim(engine, 'people/beta');
    expect(single).toEqual({ [spaced]: true, [ogham]: false });
    expect(batch).toEqual({ [spaced]: true, [ogham]: false });
    return { single, batch };
  });

  parityTest('a withdrawal of "X Y" is not a withdrawal of "X\\u1680Y" for a writer', { methods: ['insertFactWithdrawal'], requires: 'raw_sql' }, async (engine) => {
    const spaced = 'Gamma withdrawn claim', ogham = `Gamma${OGHAM}withdrawn claim`;
    await engine.insertFactWithdrawal(SRC, 'world', spaced, '*', T1);
    const withdrawn = {
      spaced: await isFactWithdrawn(engine, SRC, 'world', spaced, 'people/gamma'),
      ogham: await isFactWithdrawn(engine, SRC, 'world', ogham, 'people/gamma'),
    };
    expect(withdrawn).toEqual({ spaced: true, ogham: false });
    return withdrawn;
  });

  parityTest('a purge of "X Y" refuses that claim and admits "X\\u1680Y" as a fact, a fence row and a take', {
    methods: ['insertFact', 'insertFacts', 'putPage', 'getPage', 'addTakesBatch', 'executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const spaced = 'Delta purged claim', ogham = `Delta${OGHAM}purged claim`;
    const takeSpaced = 'Epsilon purged take', takeOgham = `Epsilon${OGHAM}purged take`;
    await engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ($1,'world','*',gbrain_fact_fingerprint($2))`, [SRC, spaced]);
    await engine.executeRaw(`INSERT INTO take_purges(source_id,subject,claim_hash) VALUES ($1,'*',gbrain_fact_fingerprint($2))`, [SRC, takeSpaced]);
    const fact = (claim: string) => () => engine.insertFact({ fact: claim, visibility: 'world', entity_slug: 'people/delta', source: 'chat' }, { source_id: SRC });
    const row = (claim: string, rowNum: number) => () => engine.insertFacts([{ fact: claim, visibility: 'world', entity_slug: 'people/delta', source: 'fence',
      row_num: rowNum, source_markdown_slug: 'notes/delta' }], { source_id: SRC });
    await engine.putPage('notes/takes', { type: 'note', title: 'Takes', compiled_truth: 'Takes page.' });
    const pageId = Number((await engine.getPage('notes/takes'))!.id);
    const take = (claim: string, rowNum: number) => () => engine.addTakesBatch([{ page_id: pageId, row_num: rowNum, claim, kind: 'belief', holder: 'people/delta' }]);
    const saved = {
      fact: { spaced: await outcome(fact(spaced)), ogham: await outcome(fact(ogham)) },
      fence: { spaced: await outcome(row(spaced, 1)), ogham: await outcome(row(ogham, 2)) },
      take: { spaced: await outcome(take(takeSpaced, 1)), ogham: await outcome(take(takeOgham, 2)) },
    };
    expect(saved).toEqual({ fact: { spaced: 'purged_content', ogham: 'saved' }, fence: { spaced: 'purged_content', ogham: 'saved' },
      take: { spaced: 'purged_content', ogham: 'saved' } });
    const facts = await expiredByClaim(engine, 'people/delta');
    expect(facts).toEqual({ [ogham]: false });
    const purged = { spaced: await isFactPurged(engine, SRC, 'world', spaced, 'people/delta'), ogham: await isFactPurged(engine, SRC, 'world', ogham, 'people/delta') };
    expect(purged).toEqual({ spaced: true, ogham: false });
    return { saved, facts, purged };
  });

  parityTest('a purge of "X Y" drops that fence row and keeps the "X\\u1680Y" row in both fence overlays', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    const spaced = 'Zeta purged claim', ogham = `Zeta${OGHAM}purged claim`;
    await engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ($1,'world','*',gbrain_fact_fingerprint($2))`, [SRC, spaced]);
    const body = 'Lead.\n\n' + fence(spaced, ogham, 'A live claim');
    const kept = await dropPurgedFenceRows(engine, SRC, body, 'notes/zeta');
    const overlay = await loadFenceChunkOverlay(engine, { sourceId: SRC, slug: 'notes/zeta', compiled_truth: body });
    const result = { spacedKept: kept.includes(spaced), oghamKept: kept.includes(ogham), omitted: [...overlay?.omit ?? []].sort((a, b) => a - b) };
    expect(result).toEqual({ spacedKept: false, oghamKept: true, omitted: [1] });
    return result;
  });
});
