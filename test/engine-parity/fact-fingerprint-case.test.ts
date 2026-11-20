/**
 * BrainEngine parity — the fact fingerprint folds case as PGLite does on every Postgres locale, so a withdrawal or purge
 * of one letter case never reaches a case only the server's C library folds together.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a withdrawal or purge of "X \u24b6 Y" (CIRCLED LATIN CAPITAL LETTER A, which PGLite and the Rust store
 *    keep) leaves "X \u24d0 Y" (its small letter) alone, and the other way round, on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the covering check, the fence dates, the
 *    writer check, the fact guards, the purge guards, the fence overlays, a page read, the export and withdrawal
 *    discovery all answer for the spelling written only. A ledger hash a pre-v330 Postgres stored for the capital
 *    (the hash of the small letter) matches the small letter only: that is the named residual.
 *  - Regression: Postgres folded case by the server's lower(), and glibc lowers 69 code points PGLite keeps, so on
 *    en_US.utf8 "X \u24b6 Y" and "X \u24d0 Y" had one fingerprint and a purge of either refused both on Postgres only.
 *  - Why existing coverage misses it: the fingerprint goldens and parity cases hold ASCII or Latin letters, which every
 *    lower() folds the same way; only a Postgres arm reading a letter glibc and PGLite fold differently shows it.
 *  - Seam: withdrawals and facts go through the typed insertFactWithdrawal, insertFact and insertFacts. The store has
 *    no member that writes a purge tombstone, so the purge cases seed fact_purges and take_purges with SQL and the
 *    guard cases read the facts back with SQL; the Rust arm stops on the typed raw_sql refusal there. Synthetic claims
 *    only.
 */
import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { renderFactsTable, parseFactsFenceFor } from '../../src/core/facts-fence.ts';
import { FINGERPRINT_PUNCTUATION } from '../../src/core/facts/withdrawal-schema.ts';
import { isFactPurged, isFactWithdrawn } from '../../src/core/facts/withdrawal.ts';
import { dropPurgedFenceRows } from '../../src/core/facts/purge-overlay.ts';
import { loadFenceChunkOverlay } from '../../src/core/eligibility/fence-overlay.ts';
import { discoverWithdrawalTargets } from '../../src/core/facts/withdrawal-discovery.ts';
import { readExportPages, readExportWithdrawals } from '../../src/core/export-snapshot.ts';
import { PGLITE_LOWER_MAP } from '../../src/core/pg-fold.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const T1 = '2026-03-01T10:00:00.000Z';
const CAPITAL = '\u24b6', SMALL = '\u24d0';

/** PGLite's lower(), from the case map pg-fold.ts spells in SQL. */
const pgliteLower = (text: string) => [...text].map(ch => String.fromCodePoint(PGLITE_LOWER_MAP.get(ch.codePointAt(0)!) ?? ch.codePointAt(0)!)).join('');
/** The current fingerprint, as JavaScript (PGLite's case fold and Rust's is_pg_space list). */
const PG_SPACE = /[\u0009-\u000d \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+/gu;
const normalize = (claim: string) => {
  let out = '';
  for (const ch of pgliteLower(claim)) out += FINGERPRINT_PUNCTUATION.includes(ch) ? ' ' : ch;
  return out.replace(PG_SPACE, ' ').replace(/\.(?=[. ]|$)/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const fingerprint = (claim: string) => sha(normalize(claim));

const pair = (word: string) => ({ capital: `${word} ${CAPITAL} claim`, small: `${word} ${SMALL} claim` });
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

describe('engine parity: a ledger row of one letter case never reaches a case only glibc folds together', () => {
  parityTest('every engine fingerprints both cases apart, as PGLite folds case', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    const { capital, small } = pair('Alpha');
    const [row] = await engine.executeRaw<{ capital: string; small: string; norm: string }>(
      'SELECT gbrain_fact_fingerprint($1) AS capital, gbrain_fact_fingerprint($2) AS small, gbrain_fact_normalize($1) AS norm', [capital, small]);
    const result = { capital: row!.capital === fingerprint(capital), small: row!.small === fingerprint(small), apart: row!.capital !== row!.small, norm: row!.norm };
    expect(result).toEqual({ capital: true, small: true, apart: true, norm: `alpha ${CAPITAL} claim` });
    return result;
  });

  parityTest('a withdrawal of one case covers that claim and not the other in the covering check and the fence dates', {
    methods: ['insertFactWithdrawal', 'hasCoveringFactWithdrawal', 'listFactWithdrawalDates'],
  }, async (engine) => {
    const { capital, small } = pair('Beta');
    const other = pair('Gamma');
    expect(await engine.insertFactWithdrawal(SRC, 'world', capital, '*', T1)).toBe(true);
    expect(await engine.insertFactWithdrawal(SRC, 'world', other.small, '*', T1)).toBe(true);
    const covering = {
      capital: await engine.hasCoveringFactWithdrawal(SRC, 'world', fingerprint(capital), capital, 'people/beta'),
      small: await engine.hasCoveringFactWithdrawal(SRC, 'world', fingerprint(small), small, 'people/beta'),
      otherCapital: await engine.hasCoveringFactWithdrawal(SRC, 'world', fingerprint(other.capital), other.capital, 'people/beta'),
      otherSmall: await engine.hasCoveringFactWithdrawal(SRC, 'world', fingerprint(other.small), other.small, 'people/beta'),
    };
    expect(covering).toEqual({ capital: true, small: false, otherCapital: false, otherSmall: true });
    const dates = (await engine.listFactWithdrawalDates(SRC, [{ row_num: 1, claim: capital, visibility: 'world' }, { row_num: 2, claim: small, visibility: 'world' },
      { row_num: 3, claim: other.capital, visibility: 'world' }, { row_num: 4, claim: other.small, visibility: 'world' }], null))
      .map(r => Number(r.row_num)).sort((a, b) => a - b);
    expect(dates).toEqual([1, 4]);
    return { covering, dates };
  });

  parityTest('a withdrawal of one case expires that claim and leaves the other active, and a writer sees the same', {
    methods: ['insertFactWithdrawal', 'insertFact', 'insertFacts', 'executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const { capital, small } = pair('Delta');
    await engine.insertFactWithdrawal(SRC, 'world', capital, '*', T1);
    await engine.insertFact({ fact: small, visibility: 'world', entity_slug: 'people/delta', source: 'chat' }, { source_id: SRC });
    await engine.insertFact({ fact: capital, visibility: 'world', entity_slug: 'people/delta', source: 'chat' }, { source_id: SRC });
    await engine.insertFacts([{ fact: small, visibility: 'world', entity_slug: 'people/delta-batch', source: 'fence', row_num: 1, source_markdown_slug: 'notes/delta' },
      { fact: capital, visibility: 'world', entity_slug: 'people/delta-batch', source: 'fence', row_num: 2, source_markdown_slug: 'notes/delta' }], { source_id: SRC });
    const single = await expiredByClaim(engine, 'people/delta');
    const batch = await expiredByClaim(engine, 'people/delta-batch');
    const withdrawn = { capital: await isFactWithdrawn(engine, SRC, 'world', capital, 'people/delta'), small: await isFactWithdrawn(engine, SRC, 'world', small, 'people/delta') };
    expect({ single, batch, withdrawn }).toEqual({ single: { [capital]: true, [small]: false }, batch: { [capital]: true, [small]: false }, withdrawn: { capital: true, small: false } });
    return { single, batch, withdrawn };
  });

  parityTest('a purge of the small letter refuses that claim and admits the capital as a fact, a fence row and a take', {
    methods: ['insertFact', 'insertFacts', 'putPage', 'getPage', 'addTakesBatch', 'executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const { capital, small } = pair('Epsilon');
    const take = pair('Zeta take');
    await engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ($1,'world','*',gbrain_fact_fingerprint($2))`, [SRC, small]);
    await engine.executeRaw(`INSERT INTO take_purges(source_id,subject,claim_hash) VALUES ($1,'*',gbrain_fact_fingerprint($2))`, [SRC, take.small]);
    const fact = (claim: string) => () => engine.insertFact({ fact: claim, visibility: 'world', entity_slug: 'people/epsilon', source: 'chat' }, { source_id: SRC });
    const row = (claim: string, rowNum: number) => () => engine.insertFacts([{ fact: claim, visibility: 'world', entity_slug: 'people/epsilon', source: 'fence',
      row_num: rowNum, source_markdown_slug: 'notes/epsilon' }], { source_id: SRC });
    await engine.putPage('notes/case-takes', { type: 'note', title: 'Takes', compiled_truth: 'Takes page.' });
    const pageId = Number((await engine.getPage('notes/case-takes'))!.id);
    const addTake = (claim: string, rowNum: number) => () => engine.addTakesBatch([{ page_id: pageId, row_num: rowNum, claim, kind: 'belief', holder: 'people/epsilon' }]);
    const saved = {
      fact: { small: await outcome(fact(small)), capital: await outcome(fact(capital)) },
      fence: { small: await outcome(row(small, 1)), capital: await outcome(row(capital, 2)) },
      take: { small: await outcome(addTake(take.small, 1)), capital: await outcome(addTake(take.capital, 2)) },
    };
    expect(saved).toEqual({ fact: { small: 'purged_content', capital: 'saved' }, fence: { small: 'purged_content', capital: 'saved' },
      take: { small: 'purged_content', capital: 'saved' } });
    const purged = { small: await isFactPurged(engine, SRC, 'world', small, 'people/epsilon'), capital: await isFactPurged(engine, SRC, 'world', capital, 'people/epsilon') };
    expect(purged).toEqual({ small: true, capital: false });
    return { saved, purged };
  });

  parityTest('a purge of the capital drops that fence row and keeps the small-letter row in both fence overlays', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    const { capital, small } = pair('Eta');
    await engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ($1,'world','*',gbrain_fact_fingerprint($2))`, [SRC, capital]);
    const body = 'Lead.\n\n' + fence(capital, small, 'A live claim');
    const kept = await dropPurgedFenceRows(engine, SRC, body, 'notes/eta');
    const overlay = await loadFenceChunkOverlay(engine, { sourceId: SRC, slug: 'notes/eta', compiled_truth: body });
    const result = { capitalKept: kept.includes(capital), smallKept: kept.includes(small), omitted: [...overlay?.omit ?? []].sort((a, b) => a - b) };
    expect(result).toEqual({ capitalKept: false, smallKept: true, omitted: [1] });
    return result;
  });

  parityTest('a withdrawal of the capital strikes that fence row only in the export', {
    methods: ['insertFactWithdrawal', 'putPage', 'getPage'],
  }, async (engine) => {
    const { capital, small } = pair('Theta');
    await engine.insertFactWithdrawal(SRC, 'world', capital, '*', T1);
    await engine.putPage('notes/theta', { type: 'note', title: 'Theta', compiled_truth: 'Lead.\n\n' + fence(capital, small, 'A live claim') });
    const page = (await engine.getPage('notes/theta'))!;
    const [exported] = await readExportPages(engine, [{ id: String(page.id), source_id: SRC, slug: 'notes/theta' }], await readExportWithdrawals(engine, SRC));
    const shown = parseFactsFenceFor(exported!.page.compiled_truth, { slug: 'notes/theta' }).facts.map(f => [f.claim, f.forgotten ?? false]);
    expect(shown).toEqual([[capital, true], [small, false], ['A live claim', false]]);
    return shown;
  });

  // The Rust page read has no withdrawal overlay yet (readPageSnapshot answers no withdrawals), so this case writes the
  // withdrawal with SQL and stops on the Rust arm's typed raw_sql refusal.
  parityTest('a withdrawal of the capital strikes that fence row only in a page read', {
    methods: ['putPage', 'readPageSnapshot', 'executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const { capital, small } = pair('Lambda');
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash,withdrawn_at) VALUES ($1,'world',gbrain_fact_fingerprint($2),$3)`, [SRC, capital, T1]);
    await engine.putPage('notes/lambda', { type: 'note', title: 'Lambda', compiled_truth: 'Lead.\n\n' + fence(capital, small, 'A live claim') });
    const read = (await engine.readPageSnapshot('notes/lambda', { sourceId: SRC }))!;
    const shown = parseFactsFenceFor(read.page.compiled_truth, { slug: 'notes/lambda' }).facts.map(f => [f.claim, f.forgotten ?? false]);
    expect(shown).toEqual([[capital, true], [small, false], ['A live claim', false]]);
    return shown;
  });

  parityTest('withdrawal discovery finds the page that holds the capital and not the one that holds the small letter', {
    methods: ['putPage', 'executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const { capital, small } = pair('Iota');
    await engine.putPage('notes/iota-capital', { type: 'note', title: 'Capital', compiled_truth: 'Lead.\n\n' + fence(capital) });
    await engine.putPage('notes/iota-small', { type: 'note', title: 'Small', compiled_truth: 'Lead.\n\n' + fence(small) });
    const slugs = (await discoverWithdrawalTargets(engine, SRC, [{ claim: capital, subject: '*', visibility: 'world', fact_hash: fingerprint(capital) }]))
      .map(t => t.slug).sort();
    expect(slugs).toEqual(['notes/iota-capital']);
    return slugs;
  });

  // Named residual: a withdrawal Postgres stored for the capital before v330 carries the hash of the small letter (the
  // server lowered it). No fold can tell that row from a withdrawal of the small letter, so it matches the small letter
  // only, on every engine; v330 adds a current-hash twin only where the claim survives in a fact or a fence.
  parityTest('a ledger hash of the glibc-lowered capital matches the small letter only', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    const { capital, small } = pair('Kappa');
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash,withdrawn_at) VALUES ($1,'world',$2,$3)`, [SRC, sha(`kappa ${SMALL} claim`), T1]);
    const withdrawn = { capital: await isFactWithdrawn(engine, SRC, 'world', capital, null), small: await isFactWithdrawn(engine, SRC, 'world', small, null) };
    expect(withdrawn).toEqual({ capital: false, small: true });
    return withdrawn;
  });
});
