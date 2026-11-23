/**
 * Vector recall scoring and the a2 evidence fields (plan a2, decisions 6 to 8), without a database: the pure scorer, and
 * `buildEvidenceStatus` over rows and score lines written with the real writers. The reference run and the child's
 * scoring on real primaries are in test/helpers/shadow-checks-scenarios.ts.
 *
 * Protects: a Rust answer missing a true neighbour, drawn from the wrong filter or under-filled scores below 1 against the
 * reference's own size; an empty reference, an offset and a limit under ten are skipped; every row tied at the cutoff is a
 * true neighbour; recall fields need 30 scored samples of the epoch and keep overlap apart; an inconclusive sample whose
 * rerun matched is closed while one that never got a rerun still counts as unexplained; privacy_diverged is absent until
 * something was compared and while a privacy check is unsettled, and counts pauses.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReadiness } from '../src/core/engine-swap/readiness.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { buildEvidenceStatus, renderEvidenceStatus } from '../src/shadow/evidence.ts';
import { appendFault, appendLedgerRows, type ShadowLedgerRow } from '../src/shadow/ledger.ts';
import { shadowStatusDocument } from '../src/shadow/status-document.ts';
import { scoreWithReruns } from '../src/shadow/child.ts';
import { appendRecall, firstTenKeys, IntervalGate, readEpochRecall, recallEligible, RECALL_REFERENCE_LIMIT, scoreRecall, type RankedKey } from '../src/shadow/recall.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const NOW = new Date('2026-11-30T12:00:00.000Z');
const ts = new Date(NOW.getTime() - 86_400_000).toISOString();
const epochDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-recall-')); dirs.push(dir);
  const epoch = ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 2, adapter_version: 'x', capability_set_hash: 'c', readiness_policy_hash: 'p' }, Date.parse('2026-11-24T00:00:00Z')).epoch_id;
  return { dir, epoch };
};
const row = (epoch: string, op: string, outcome: ShadowLedgerRow['outcome'], extra: Partial<ShadowLedgerRow> = {}): ShadowLedgerRow =>
  ({ ts, op, outcome, epoch_id: epoch, primary_ms: 1, rust_ms: 1, primary_rows: 1, rust_rows: 1, ...extra });
const status = (dir: string) => buildEvidenceStatus({ dir, now: NOW });

const ref = (n: number, score = (i: number) => 1 - i / 100): RankedKey[] => Array.from({ length: n }, (_, i) => ({ k: `c${i}`, s: score(i) }));
const rows = (keys: string[]) => keys.map((k) => ({ chunk_id: k, score: 0.5 }));
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `c${from + i}`);

describe('scoring', () => {
  test('Rust missing a true neighbour scores below 1 while the primary scores 1', () => {
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows([...ids(0, 9), 'c11']))).toMatchObject({ vector: 0.9, primary: 1, ref_size: 10 });
  });
  test('the wrong filter, an under-filled answer and an under-filled reference', () => {
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows(ids(20, 30)))).toMatchObject({ vector: 0, primary: 1 }); // all outside the reference
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows(ids(0, 4)))).toMatchObject({ vector: 0.4 }); // under-filled
    expect(scoreRecall(ref(4), rows(ids(0, 4)), rows(ids(0, 2)))).toMatchObject({ vector: 0.5, primary: 1, ref_size: 4 }); // only four eligible rows exist: the denominator is the reference's
  });
  test('an empty corpus is skipped, and so are an offset and a limit under ten', () => {
    expect(scoreRecall([], [], [])).toBeNull();
    expect([recallEligible([0, { limit: 10 }]), recallEligible([0, {}]), recallEligible([0, { limit: 9 }]), recallEligible([0, { limit: 10, offset: 5 }])]).toEqual([true, true, false, false]);
  });
  test('every reference row tied with the tenth is a true neighbour, whichever the engine returned', () => {
    const tied = ref(13, (i) => (i < 9 ? 1 - i / 100 : 0.5)); // c9, c10, c11 and c12 tie at the cutoff
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 9), 'c12']))).toMatchObject({ vector: 1 });
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 9), 'c13']))).toMatchObject({ vector: 0.9 });
  });
  test('tied rows fill only the top-ten places the strictly better rows leave: ten tied rows and none of nine better ones score 0.1', () => {
    const tied = ref(29, (i) => (i < 9 ? 1 - i / 100 : 0.5)); // nine strictly better rows, then twenty tied at the cutoff
    expect(scoreRecall(tied, rows(ids(0, 10)), rows(ids(9, 19)))).toMatchObject({ vector: 0.1, primary: 1 }); // the nine better rows were all missed
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 9), 'c20']))).toMatchObject({ vector: 1 }); // one tied row takes the one place left
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 8), 'c12', 'c13']))).toMatchObject({ vector: 0.9 }); // two tied rows, one place
  });
  test('a reference that fills its window with rows tied at the cutoff is unscorable: the tie may run past it', () => {
    const full = ref(RECALL_REFERENCE_LIMIT, (i) => (i < 9 ? 1 - i / 100 : 0.5)); // the fiftieth row still ties the tenth score
    expect(scoreRecall(full, rows(ids(0, 10)), rows(ids(0, 10)))).toBeNull();
    expect(scoreRecall(full, rows(ids(0, 10)), rows(ids(9, 19)))).toBeNull(); // never a miss for rows beyond the window
    expect(scoreRecall(ref(RECALL_REFERENCE_LIMIT, (i) => 1 - i / 100), rows(ids(0, 10)), rows(ids(0, 10)))).toMatchObject({ vector: 1 }); // a window whose last row is strictly worse holds the whole tie
    expect(scoreRecall(ref(RECALL_REFERENCE_LIMIT - 1, (i) => (i < 9 ? 1 - i / 100 : 0.5)), rows(ids(0, 10)), rows(ids(0, 10)))).toMatchObject({ vector: 1 }); // fewer rows than asked for: the tie is whole
  });
  test('an element that is not a row takes its place in the first ten: a null ahead of nine neighbours scores 0.9, never 1', () => {
    const nine = ids(0, 9);
    expect(scoreRecall(ref(12), rows(ids(0, 10)), [null, ...rows(nine)])).toMatchObject({ vector: 0.9, primary: 1 });
    expect(scoreRecall(ref(12), [null, 'x', ...rows(nine)], rows(ids(0, 10)))).toMatchObject({ vector: 1, primary: 0.8 }); // the same for the primary's own answer
    expect(scoreRecall(ref(12), rows(ids(0, 10)), [...rows(nine), null, ...rows(['c9'])])).toMatchObject({ vector: 0.9 }); // a hole at the tenth place pushes the next row out
    expect(scoreRecall(ref(12), rows(ids(0, 10)), null)).toMatchObject({ vector: 0 }); // not a list: nothing
  });
  test('the rerun representation of an answer keeps its holes: a null ahead of ten neighbours scores 0.9 for the primary through the rerun path too', async () => {
    const keys = firstTenKeys([null, ...rows(ids(0, 10))]); // what the serving process sends back for a moved vector sample's rerun
    expect(keys).toHaveLength(10);
    expect(keys[0]).toBeNull();
    const env = {
      timeoutMs: 1000, now: () => 0, curEpoch: () => 'e',
      ask: async (p: Record<string, unknown>) => (p.kind === 'rerun' ? { stamp: 1, epoch_id: 'e', keys, attempt: 'a1' } : p.attempt === 'a1' ? ref(12) : (() => { throw Object.assign(new Error('moved'), { code: 'moved' }); })()),
      exclusive: async (_s: number, fn: () => Promise<unknown>) => fn(),
      callRust: async () => ({ value: rows(ids(0, 10)) }),
      write: (score: unknown) => { written.push(score); },
    };
    const written: unknown[] = [];
    await scoreWithReruns(env as never, { op: 'searchVector', sid: 's', result: [], args: [] } as never, [], rows(ids(0, 10)));
    expect(written).toMatchObject([{ vector: 1, primary: 0.9 }]); // the primary lost a place to the null, so it scores 0.9, never 1
  });
  test('ten copies of one true neighbour are one neighbour, not ten', () => {
    const copies = Array.from({ length: 10 }, () => ({ chunk_id: 'c0', score: 0.5 }));
    expect(scoreRecall(ref(12), copies, copies)).toMatchObject({ vector: 0.1, primary: 0.1 });
    expect(scoreRecall(ref(12), rows(ids(0, 10)), copies)!.overlap).toBe(0.1); // distinct identities on both sides
  });
  test('overlap with the primary is its own number', () => {
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows([...ids(0, 9), 'c11']))!.overlap).toBe(0.9);
  });
  test('the gate allows one reference run a minute', () => {
    let at = 0;
    const gate = new IntervalGate(60_000, () => at);
    expect([gate.take(), gate.take(), (at = 59_999, gate.take()), (at = 60_000, gate.take())]).toEqual([true, false, false, true]);
  });
});

describe('recall fields', () => {
  const line = (dir: string, epoch: string, n: number, vector: number, primary = 1) => { for (let i = 0; i < n; i++) appendRecall(dir, { ts, epoch_id: epoch, vector, primary, overlap: 0.8, ref_size: 10 }); };
  test('absent under 30 samples of the epoch, then the epoch average, with the overlap apart', () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [row(epoch, 'getPage', 'match')]);
    line(dir, 'another-epoch', 40, 0);
    line(dir, epoch, 29, 1);
    expect(status(dir).search).toBeUndefined();
    expect(status(dir).evidence).toMatchObject({ recall_samples: 29 });
    line(dir, epoch, 1, 0.5);
    expect(status(dir).search).toEqual({ vector_recall_at_10: (29 + 0.5) / 30, primary_recall_at_10: 1 });
    expect(status(dir).evidence).toMatchObject({ recall_samples: 30 });
    expect(status(dir).evidence!.vector_overlap_with_primary).toBeCloseTo(0.8, 9);
    expect(renderEvidenceStatus(status(dir)).join('\n')).toContain('vector recall@10');
  });
  test('a malformed or out-of-range record makes recall unavailable: a missing score, a score above 1, a bad size, another epoch\'s too', () => {
    const good = { ts, epoch_id: 'E', vector: 0.5, primary: 0.5, overlap: 0.5, ref_size: 10 };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing score', { ...good, vector: undefined }], ['score above 1', { ...good, primary: 1.5 }], ['negative score', { ...good, overlap: -0.1 }],
      ['non-numeric score', { ...good, vector: '0.5' }], ['ref_size out of range', { ...good, ref_size: 0 }], ['no epoch', { ...good, epoch_id: undefined }], ['bad time', { ...good, ts: 'soon' }],
    ];
    for (const [name, bad] of cases) {
      const { dir, epoch } = epochDir();
      appendLedgerRows(dir, [row(epoch, 'findByTitleFuzzy', 'match')]);
      line(dir, epoch, 30, 1);
      expect([name, readEpochRecall(dir, epoch)!.length]).toEqual([name, 30]);
      mkdirSync(join(dir, 'recall'), { recursive: true });
      appendFileSync(join(dir, 'recall', `${ts.slice(0, 10)}.jsonl`), `${JSON.stringify(bad)}\n${JSON.stringify(good)}\n`);
      expect([name, readEpochRecall(dir, epoch)]).toEqual([name, null]); // never skipped, never trusted
      expect([name, status(dir).search?.vector_recall_at_10]).toEqual([name, undefined]);
      expect([name, status(dir).evidence!.recall_unavailable]).toEqual([name, true]);
      expect(renderEvidenceStatus(status(dir)).join('\n')).toContain('vector recall@10: unavailable');
    }
    const torn = epochDir(); // a torn last line is the one thing skipped
    line(torn.dir, torn.epoch, 30, 1);
    appendFileSync(join(torn.dir, 'recall', `${ts.slice(0, 10)}.jsonl`), '{"ts":"');
    expect(readEpochRecall(torn.dir, torn.epoch)).toHaveLength(30);
  });
  test('an unreadable score file leaves the fields absent, and a degraded Rust answer fails criterion 4', () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [row(epoch, 'findByTitleFuzzy', 'match')]);
    line(dir, epoch, 30, 0.9, 1);
    const search = { ...status(dir).search, trigram_exact_disagreements: 0, keyword_title: { ranker: 'ts_rank' as const, exact_disagreements: 0 } };
    expect(evaluateReadiness({ search }, NOW).criteria.find((c) => c.n === 4)).toMatchObject({ state: 'fail' });
    writeFileSync(join(dir, 'recall', `${ts.slice(0, 10)}.jsonl`), 'not json\n{"x":1}\n');
    expect(status(dir).search).toEqual({ trigram_exact_disagreements: 0 });
  });
});

describe('the status document', () => {
  test('carries privacy_diverged and both recall fields from shadowStatusDocument, and the evaluator reads them', () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [row(epoch, 'findByTitleFuzzy', 'match'), row(epoch, 'searchKeyword', 'match')]);
    for (let i = 0; i < 30; i++) appendRecall(dir, { ts, epoch_id: epoch, vector: 1, primary: 1, overlap: 1, ref_size: 10 });
    const doc = shadowStatusDocument({ key: 'k', dir }, NOW);
    expect([doc.privacy_diverged, doc.search?.vector_recall_at_10, doc.search?.primary_recall_at_10]).toEqual([0, 1, 1]);
    const verdict = evaluateReadiness(doc as never, NOW);
    expect(verdict.criteria.filter((c) => [4, 6].includes(c.n)).map((c) => c.state)).toEqual(['pass', 'pass']);
  });
});

describe('the residual privacy limit (reads without a privacy marker)', () => {
  const MARKERLESS = ['resolveSlugs', 'resolveSlugWithAlias', 'getTags', 'getTimeline', 'getChunks', 'findByTitleFuzzy', 'getStats', 'countKeywordPages', 'searchTakes', 'searchTakesVector'];
  const criterion3 = (dir: string) => {
    const { evidence, ...ev } = status(dir);
    return { reads: status(dir).reads, row: evaluateReadiness({ epoch_id: evidence?.epoch_id, epoch_started_at: evidence?.epoch_started_at, ...ev } as never, NOW).criteria.find((c) => c.n === 3)! };
  };
  const healthy = (epoch: string) => ['getPage', 'searchTakes', 'getTags'].map((op) => row(epoch, op, 'match'));

  test('an injected diff on each of the ten reads counts, and takes searches fail criterion 3 through the evaluator (never an explained bucket)', () => {
    for (const op of MARKERLESS) {
      const { dir, epoch } = epochDir();
      appendLedgerRows(dir, [...healthy(epoch), row(epoch, op, 'diff', { mismatch: 'diff', rerun: 'differed', reason: 'rerun_differs' })]);
      expect([op, status(dir).reads!.diverged_unexplained_7d]).toEqual([op, 1]);
    }
    for (const op of ['searchTakes', 'getTags']) {
      const { dir, epoch } = epochDir();
      appendLedgerRows(dir, [...healthy(epoch), row(epoch, op, 'diff', { mismatch: 'diff', rerun: 'differed', reason: 'rerun_differs' })]);
      expect(criterion3(dir).row).toMatchObject({ state: 'fail' });
      expect(criterion3(dir).row.detail).toContain('1 unexplained diverged');
    }
    const clean = epochDir();
    appendLedgerRows(clean.dir, healthy(clean.epoch));
    expect(criterion3(clean.dir).row.state).toBe('pass');
  });

  test('on the two take searches the same rows in another order stay reported; facts, links, finds and search rows also count a diff', () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [row(epoch, 'searchTakes', 'order_diff'), row(epoch, 'searchTakesVector', 'order_diff')]);
    expect(status(dir).reads!.diverged_unexplained_7d).toBe(0);
    for (const op of ['listFactsByEntity', 'getLinks', 'getBacklinks', 'findPages', 'findByTitleFuzzy', 'searchKeyword', 'searchKeywordChunks', 'searchTitles']) {
      const one = epochDir();
      appendLedgerRows(one.dir, [row(one.epoch, op, 'diff', { private_read: true, mismatch: 'diff', rerun: 'differed' })]);
      expect([op, status(one.dir).reads!.diverged_unexplained_7d]).toEqual([op, 1]);
    }
  });

  test('a ranked vector diff counts only under excludePrivate, and not when every extra row passed the check; the accepted ones are reported per member', () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [
      row(epoch, 'searchVector', 'diff'), // no excludePrivate: a ranking difference
      row(epoch, 'searchVector', 'diff', { private_read: true, reason: 'extra_rows_cleared' }), // accepted
      row(epoch, 'searchVector', 'diff', { private_read: true, reason: 'extra_rows_cleared' }),
    ]);
    expect(status(dir).reads!.diverged_unexplained_7d).toBe(0);
    expect(status(dir).evidence!.ranking_differences).toEqual({ searchVector: 2 });
    const text = renderEvidenceStatus(status(dir)).join('\n');
    expect(text).toContain('ranking differences accepted under that exception (reported, not unexplained): searchVector 2');
    expect(text).toContain('the one exception is a ranked vector search under excludePrivate whose extra Rust rows all passed');
    appendLedgerRows(dir, [row(epoch, 'searchVector', 'diff', { private_read: true, mismatch: 'diff', rerun: 'differed', reason: 'rerun_differs' })]);
    expect(status(dir).reads!.diverged_unexplained_7d).toBe(1);
  });
});

describe('unexplained and privacy fields', () => {
  test('a rerun that matched closes the sample; one that never ran, or still differs, is unexplained; neither is a success', () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [
      row(epoch, 'getPage', 'inconclusive', { mismatch: 'diff', rerun: 'matched' }),
      row(epoch, 'getPage', 'inconclusive', { mismatch: 'diff', rerun: 'skipped:busy' }),
      row(epoch, 'getPage', 'inconclusive', { mismatch: 'diff' }),
      row(epoch, 'getPage', 'diff', { mismatch: 'diff', rerun: 'differed', reason: 'rerun_differs' }),
      row(epoch, 'searchVector', 'inconclusive', { mismatch: 'diff', reason: 'privacy_check_moved', rerun: 'skipped:busy' }), // an unchecked ranked diff counts too
    ]);
    expect(status(dir).reads).toMatchObject({ diverged_unexplained_7d: 4 });
    expect(status(dir).reads!.ops.find((o) => o.op === 'getPage')!.successful).toBe(0);
  });
  test('privacy_diverged is absent until something was compared, counts rows and pauses, and is absent while a check is unsettled', () => {
    const { dir, epoch } = epochDir();
    expect(status(dir).privacy_diverged).toBeUndefined();
    appendLedgerRows(dir, [row(epoch, 'getPage', 'match')]);
    expect(status(dir).privacy_diverged).toBe(0);
    appendLedgerRows(dir, [row(epoch, 'listPages', 'privacy_diverged')]);
    expect(status(dir).privacy_diverged).toBe(1);
    appendFault(dir, { ts, kind: 'privacy_pause', detail: 'op=listPages reason=row_not_readable_by_caller', epoch_id: epoch });
    appendFault(dir, { ts, kind: 'privacy_pause', detail: 'privacy_diverged: the serving process line for the same pause', epoch_id: epoch }); // not a second pause
    appendFault(dir, { ts, kind: 'privacy_pause', detail: 'op=getPage reason=x', epoch_id: epoch });
    expect(status(dir).privacy_diverged).toBe(2); // a pause whose row was lost still counts
    expect(evaluateReadiness({ privacy_diverged: 2 }, NOW).criteria.find((c) => c.n === 6)).toMatchObject({ state: 'fail' });
    const open = epochDir();
    appendLedgerRows(open.dir, [row(open.epoch, 'getPage', 'match'), row(open.epoch, 'listPages', 'inconclusive', { reason: 'privacy_check_unavailable', mismatch: 'diff', rerun: 'skipped:busy' })]);
    expect(status(open.dir).privacy_diverged).toBeUndefined();
    appendLedgerRows(open.dir, [row(open.epoch, 'listPages', 'inconclusive', { reason: 'privacy_check_unavailable', mismatch: 'diff', rerun: 'matched' })]);
    expect(status(open.dir).evidence).toMatchObject({ privacy_checks_unsettled_7d: 1 }); // the matched one is settled; the earlier one is not
  });
});
