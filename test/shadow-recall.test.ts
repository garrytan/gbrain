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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReadiness } from '../src/core/engine-swap/readiness.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { buildEvidenceStatus, renderEvidenceStatus } from '../src/shadow/evidence.ts';
import { SHADOW_OUTCOMES, type ShadowOutcome } from '../src/shadow/classify.ts';
import { appendFault, appendLedgerRows, type ShadowLedgerRow } from '../src/shadow/ledger.ts';
import { shadowStatusDocument } from '../src/shadow/status-document.ts';
import { RERUN_ATTEMPTS, RERUN_BACKOFF_JITTER, RERUN_BACKOFF_MS, RERUN_BACKOFF_TOTAL_MS, rerunBackoffMs, scoreWithReruns } from '../src/shadow/child.ts';
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
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows([...ids(0, 9), 'c11']))).toMatchObject({ vector: 0.9, primary: 1, ref_size: 10 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
  });
  test('the wrong filter, an under-filled answer and an under-filled reference', () => {
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows(ids(20, 30)))).toMatchObject({ vector: 0, primary: 1 }); // all outside the reference // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows(ids(0, 4)))).toMatchObject({ vector: 0.4 }); // under-filled // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(ref(4), rows(ids(0, 4)), rows(ids(0, 2)))).toMatchObject({ vector: 0.5, primary: 1, ref_size: 4 }); // only four eligible rows exist: the denominator is the reference's
  });
  test('an empty corpus is skipped, and so are an offset and a limit under ten', () => {
    expect(scoreRecall([], [], [])).toBeNull();
    expect([recallEligible([0, { limit: 10 }]), recallEligible([0, {}]), recallEligible([0, { limit: 9 }]), recallEligible([0, { limit: 10, offset: 5 }])]).toEqual([true, true, false, false]);
  });
  test('every reference row tied with the tenth is a true neighbour, whichever the engine returned', () => {
    const tied = ref(13, (i) => (i < 9 ? 1 - i / 100 : 0.5)); // c9, c10, c11 and c12 tie at the cutoff
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 9), 'c12']))).toMatchObject({ vector: 1 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 9), 'c13']))).toMatchObject({ vector: 0.9 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
  });
  test('tied rows fill only the top-ten places the strictly better rows leave: ten tied rows and none of nine better ones score 0.1', () => {
    const tied = ref(29, (i) => (i < 9 ? 1 - i / 100 : 0.5)); // nine strictly better rows, then twenty tied at the cutoff
    expect(scoreRecall(tied, rows(ids(0, 10)), rows(ids(9, 19)))).toMatchObject({ vector: 0.1, primary: 1 }); // the nine better rows were all missed // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 9), 'c20']))).toMatchObject({ vector: 1 }); // one tied row takes the one place left // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(tied, rows(ids(0, 10)), rows([...ids(0, 8), 'c12', 'c13']))).toMatchObject({ vector: 0.9 }); // two tied rows, one place // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
  });
  test('a reference that fills its window with rows tied at the cutoff is unscorable: the tie may run past it', () => {
    const full = ref(RECALL_REFERENCE_LIMIT, (i) => (i < 9 ? 1 - i / 100 : 0.5)); // the fiftieth row still ties the tenth score
    expect(scoreRecall(full, rows(ids(0, 10)), rows(ids(0, 10)))).toBeNull(); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(full, rows(ids(0, 10)), rows(ids(9, 19)))).toBeNull(); // never a miss for rows beyond the window // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(ref(RECALL_REFERENCE_LIMIT, (i) => 1 - i / 100), rows(ids(0, 10)), rows(ids(0, 10)))).toMatchObject({ vector: 1 }); // a window whose last row is strictly worse holds the whole tie // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    expect(scoreRecall(ref(RECALL_REFERENCE_LIMIT - 1, (i) => (i < 9 ? 1 - i / 100 : 0.5)), rows(ids(0, 10)), rows(ids(0, 10)))).toMatchObject({ vector: 1 }); // fewer rows than asked for: the tie is whole // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
  });
  test('an element that is not a row takes its place in the first ten: a null ahead of nine neighbours scores 0.9, never 1', () => {
    const nine = ids(0, 9);
    expect(scoreRecall(ref(12), rows(ids(0, 10)), [null, ...rows(nine)])).toMatchObject({ vector: 0.9, primary: 1 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    expect(scoreRecall(ref(12), [null, 'x', ...rows(nine)], rows(ids(0, 10)))).toMatchObject({ vector: 1, primary: 0.8 }); // the same for the primary's own answer
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    expect(scoreRecall(ref(12), rows(ids(0, 10)), [...rows(nine), null, ...rows(['c9'])])).toMatchObject({ vector: 0.9 }); // a hole at the tenth place pushes the next row out
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    expect(scoreRecall(ref(12), rows(ids(0, 10)), null)).toMatchObject({ vector: 0 }); // not a list: nothing
  });
  test('the rerun representation of an answer keeps its holes: a null ahead of ten neighbours scores 0.9 for the primary through the rerun path too', async () => {
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    const keys = firstTenKeys([null, ...rows(ids(0, 10))]); // what the serving process sends back for a moved vector sample's rerun
    expect(keys).toHaveLength(10); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    expect(keys[0]).toBeNull();
    const env = {
      timeoutMs: 1000, now: () => 0, curEpoch: () => 'e',
      ask: async (p: Record<string, unknown>) => (p.kind === 'rerun' ? { stamp: 1, epoch_id: 'e', keys, attempt: 'a1' } : p.attempt === 'a1' ? ref(12) : (() => { throw Object.assign(new Error('moved'), { code: 'moved' }); })()),
      exclusive: async (_s: number, fn: () => Promise<unknown>) => fn(),
      callRust: async () => ({ value: rows(ids(0, 10)) }), // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
      write: (score: unknown) => { written.push(score); },
    };
    const written: unknown[] = [];
    await scoreWithReruns(env as never, { op: 'searchVector', sid: 's', result: [], args: [] } as never, [], rows(ids(0, 10))); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    expect(written).toMatchObject([{ vector: 1, primary: 0.9 }]); // the primary lost a place to the null, so it scores 0.9, never 1
  });
  test('ten copies of one true neighbour are one neighbour, not ten', () => {
    const copies = Array.from({ length: 10 }, () => ({ chunk_id: 'c0', score: 0.5 }));
    expect(scoreRecall(ref(12), copies, copies)).toMatchObject({ vector: 0.1, primary: 0.1 });
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    expect(scoreRecall(ref(12), rows(ids(0, 10)), copies)!.overlap).toBe(0.1); // distinct identities on both sides
  });
  test('overlap with the primary is its own number', () => {
    expect(scoreRecall(ref(12), rows(ids(0, 10)), rows([...ids(0, 9), 'c11']))!.overlap).toBe(0.9); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
  });
  test('the gate allows one reference run a minute', () => {
    let at = 0;
    const gate = new IntervalGate(60_000, () => at);
    expect([gate.take(), gate.take(), (at = 59_999, gate.take()), (at = 60_000, gate.take())]).toEqual([true, false, false, true]);
  });
});

describe('recall fields', () => {
  const line = (dir: string, epoch: string, n: number, vector: number, primary = 1) => { for (let i = 0; i < n; i++) appendRecall(dir, { ts, epoch_id: epoch, vector, primary, overlap: 0.8, ref_size: 10 }); }; // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
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
    const good = { ts, epoch_id: 'E', vector: 0.5, primary: 0.5, overlap: 0.5, ref_size: 10 }; // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
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
      appendFileSync(join(dir, 'recall', `${ts.slice(0, 10)}.jsonl`), `${JSON.stringify(bad)}\n${JSON.stringify(good)}\n`); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
      expect([name, readEpochRecall(dir, epoch)]).toEqual([name, null]); // never skipped, never trusted
      expect([name, status(dir).search?.vector_recall_at_10]).toEqual([name, undefined]);
      expect([name, status(dir).evidence!.recall_unavailable]).toEqual([name, true]);
      expect(renderEvidenceStatus(status(dir)).join('\n')).toContain('vector recall@10: unavailable');
    }
    const torn = epochDir(); // a torn last line is the one thing skipped
    line(torn.dir, torn.epoch, 30, 1);
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
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
  test('carries privacy_diverged and both recall fields from shadowStatusDocument, and the evaluator reads them', async () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [row(epoch, 'findByTitleFuzzy', 'match'), row(epoch, 'searchKeyword', 'match')]);
    for (let i = 0; i < 30; i++) appendRecall(dir, { ts, epoch_id: epoch, vector: 1, primary: 1, overlap: 1, ref_size: 10 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    const doc = await shadowStatusDocument({ key: 'k', dir }, NOW);
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

describe('the wait before a rerun after a moved check', () => {
  const moved = (): never => { throw Object.assign(new Error('moved'), { code: 'moved' }); };
  /** A recall sample whose reference is refused (moved) on every run made before `quietAt` on a virtual clock that only the waits advance. */
  async function sample(quietAt: number) {
    const t = { clock: 0, waits: [] as number[], written: [] as unknown[] };
    const env = {
      timeoutMs: 1000, now: () => t.clock, curEpoch: () => 'e', random: () => 0.5,
      pause: async (ms: number) => { t.waits.push(ms); t.clock += ms; },
      ask: async (p: Record<string, unknown>) => (p.kind === 'rerun' ? { stamp: 1, epoch_id: 'e', keys: firstTenKeys(rows(ids(0, 10))), attempt: `a${t.waits.length}` } : t.clock < quietAt ? moved() : ref(12)), // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
      exclusive: async (_s: number, fn: () => Promise<unknown>) => fn(),
      callRust: async () => ({ value: rows(ids(0, 10)) }), // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
      write: (score: unknown) => { t.written.push(score); },
    };
    await scoreWithReruns(env as never, { op: 'searchVector', sid: 's', result: [], args: [] } as never, [], rows(ids(0, 10))); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    return t;
  }
  test('a burst that ends within the waits lets a later run score the sample; one that never ends leaves it unscored', async () => {
    const quiet = await sample(1_000);
    expect(quiet.written).toHaveLength(1);
    expect(quiet.waits).toEqual([500, 2_000]); // the run at 0 s and the rerun at 0.5 s were refused; the rerun at 2.5 s was not
    const never = await sample(Infinity);
    expect(never.written).toHaveLength(0);
    expect(never.waits).toEqual([500, 2_000]); // three runs in all, two waits between them
    expect(never.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RERUN_BACKOFF_TOTAL_MS);
  });
  test('the waits grow, are jittered by a quarter at most, and the worst total of one sample is inside the bound', () => {
    expect([1, 2, 3, 9].map((n) => rerunBackoffMs(n, () => 0.5))).toEqual([500, 2_000, 8_000, 8_000]);
    expect(rerunBackoffMs(1, () => 0)).toBe(375);
    expect(rerunBackoffMs(3, () => 0.999999)).toBe(10_000);
    const worst = RERUN_BACKOFF_MS.slice(0, RERUN_ATTEMPTS).reduce((a, _, i) => a + rerunBackoffMs(i + 1, () => 0.999999), 0);
    expect(worst).toBe(13_125);
    expect(worst).toBeLessThanOrEqual(RERUN_BACKOFF_TOTAL_MS);
    expect(RERUN_BACKOFF_JITTER).toBeLessThan(1);
  });
});

describe('the recall record at the shadow directory', () => {
  const score = { vector: 1, primary: 1, overlap: 1, ref_size: 10 };
  test('a late recall score never recreates a deleted shadow directory, and one for another epoch than the directory\'s current one is not written', () => {
    const { dir, epoch } = epochDir();
    appendRecall(dir, { ts, epoch_id: epoch, ...score }, { currentEpochOnly: true });
    expect(readEpochRecall(dir, epoch)).toHaveLength(1); // control: the current epoch's score is written
    appendRecall(dir, { ts, epoch_id: 'an-older-epoch', ...score }, { currentEpochOnly: true });
    expect(readEpochRecall(dir, 'an-older-epoch')).toEqual([]); // another epoch than the one the directory holds
    rmSync(dir, { recursive: true, force: true }); // `engine shadow stop --delete`
    appendRecall(dir, { ts, epoch_id: epoch, ...score }, { currentEpochOnly: true }); // a reference that finished after it
    expect(existsSync(dir)).toBe(false); // the root is not brought back, nor anything under it
  });

  test('a recall directory that cannot be read yields unavailable recall, not a throw out of the status: a file where the directory belongs', () => {
    const { dir, epoch } = epochDir();
    writeFileSync(join(dir, 'recall'), 'not a directory');
    expect(readEpochRecall(dir, epoch)).toBeNull();
    expect(() => status(dir)).not.toThrow();
    expect(status(dir).search).toBeUndefined(); // the recall fields stay absent
    expect(status(dir).evidence).toBeDefined(); // the rest of the evidence document is still returned
  });
});

describe('a privacy check that failed only in the rerun', () => {
  test('a row closed as skipped by a privacy check that was never settled counts as unsettled even when the first check named no reason (rows written before the reason was kept)', () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [row(epoch, 'searchVector', 'inconclusive', { private_read: true, mismatch: 'diff', rerun: 'skipped:privacy_check_unavailable' })]);
    expect(status(dir).evidence?.privacy_checks_unsettled_7d).toBe(1);
    expect(status(dir).privacy_diverged).toBeUndefined();
  });
});

describe('a read made under excludePrivate is unsettled by default', () => {
  const priv = (epoch: string, outcome: ShadowLedgerRow['outcome'], extra: Partial<ShadowLedgerRow> = {}): ShadowLedgerRow => row(epoch, 'searchVector', outcome, { private_read: true, ...extra });
  const unsettled = (rows: (epoch: string) => ShadowLedgerRow[]): { unsettled: number; diverged: number | undefined } => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [row(epoch, 'getPage', 'match'), ...rows(epoch)]); // a match elsewhere: something was compared
    return { unsettled: status(dir).evidence!.privacy_checks_unsettled_7d, diverged: status(dir).privacy_diverged };
  };

  test('every pending, skipped, timed-out, errored or never-completed row of such a read counts, whatever reason it carries or lacks', () => {
    for (const [name, mk] of [
      ['a reasonless inconclusive row closed as skipped', (e: string) => [priv(e, 'inconclusive', { mismatch: 'diff', rerun: 'skipped:moved' })]],
      ['skipped by a timeout', (e: string) => [priv(e, 'inconclusive', { mismatch: 'diff', rerun: 'skipped:timeout' })]],
      ['skipped by a watermark that moved', (e: string) => [priv(e, 'inconclusive', { mismatch: 'diff', rerun: 'skipped:watermark_moved' })]],
      ['skipped because the child closed', (e: string) => [priv(e, 'inconclusive', { mismatch: 'diff', rerun: 'skipped:child_closing' })]],
      ['a pending row whose child crashed (no completion row ever written)', (e: string) => [priv(e, 'inconclusive', { mismatch: 'diff', rerun: 'pending', sid: 'crashed.1' })]],
      ['an inconclusive row with no rerun at all', (e: string) => [priv(e, 'inconclusive', { mismatch: 'diff' })]],
      ['a Rust read that timed out', (e: string) => [priv(e, 'timeout')]],
      ['a Rust read that errored', (e: string) => [priv(e, 'error', { reason: 'internal_error' })]],
    ] as const) {
      const r = unsettled(mk);
      expect([name, r.unsettled, r.diverged]).toEqual([name, 1, undefined]); // counted, and privacy_diverged absent while any is open
    }
  });

  test('only a completed check with an outcome settles it: a match, a diff, a reported ranking difference, a violation, a rerun that matched or differed, a lagged mismatch (stale)', () => {
    const r = unsettled((e) => [
      priv(e, 'match'), priv(e, 'diff', { mismatch: 'diff', reason: 'extra_rows_cleared', rerun: 'differed' }), priv(e, 'diff', { reason: 'rerun_differs', rerun: 'differed' }),
      priv(e, 'inconclusive', { mismatch: 'diff', rerun: 'matched' }), priv(e, 'stale', { mismatch: 'diff' }), priv(e, 'privacy_diverged', { reason: 'row_not_readable_by_caller' }),
      priv(e, 'inconclusive', { mismatch: 'diff', rerun: 'pending', sid: 'done.1' }), priv(e, 'diff', { reason: 'rerun_differs', rerun: 'differed', sid: 'done.1' }), // a pending row replaced by its completion row
    ]);
    expect(r).toEqual({ unsettled: 0, diverged: 1 });
  });

  test('a brain with no excludePrivate reads never reads as unsettled: its skipped, pending and timed-out rows are about other things, and status, report and the readiness verdict stay as they were', async () => {
    const { dir, epoch } = epochDir();
    appendLedgerRows(dir, [
      row(epoch, 'getPage', 'match'), row(epoch, 'listPages', 'match'),
      row(epoch, 'getPage', 'inconclusive', { mismatch: 'diff', rerun: 'skipped:moved' }), row(epoch, 'getPage', 'inconclusive', { mismatch: 'diff', rerun: 'pending', sid: 'p.1' }), row(epoch, 'getTags', 'timeout'),
    ]);
    const s = status(dir);
    expect(s.evidence!.privacy_checks_unsettled_7d).toBe(0);
    expect(s.privacy_diverged).toBe(0); // present, not hidden: something was compared and no privacy check is open
    expect(renderEvidenceStatus(s).join('\n')).not.toContain('could not be settled');
    const doc = await shadowStatusDocument({ key: 'k', dir }, NOW);
    expect(doc.privacy_diverged).toBe(0);
    expect(evaluateReadiness(doc as never, NOW).criteria.find((c) => c.n === 6)).toMatchObject({ state: 'pass' });
  });
});

describe('the fold settles the privacy question of a private read by an allowlist of outcomes', () => {
  // The one place each ledger outcome is classified. A value added to SHADOW_OUTCOMES makes this Record fail to compile, and the test below fail, until someone decides.
  const SETTLES: Record<ShadowOutcome, boolean> = {
    match: true, collation_order: true, diff: true, privacy_diverged: true, stale: true, // stale is the lagged mismatch
    order_diff: true, // order_diff settles only after a completed compare with a clean privacy check: the child's judge (child.ts) makes any non-clean verdict inconclusive or privacy_diverged first
    inconclusive: false, capability_missing: false, error: false, timeout: false, addon_unavailable: false,
  };
  test('every ledger outcome is classified: the table and the outcome list cannot drift apart', () => {
    expect(Object.keys(SETTLES).sort()).toEqual([...SHADOW_OUTCOMES].sort());
  });
  test('each outcome, with no rerun, a pending one, a skipped one, a matched one and a differed one: only the allowlist settles, and a completed rerun settles whatever the outcome', () => {
    for (const outcome of SHADOW_OUTCOMES) {
      for (const rerun of [undefined, 'pending', 'skipped:moved', 'matched', 'differed'] as const) {
        const { dir, epoch } = epochDir();
        appendLedgerRows(dir, [row(epoch, 'getPage', 'match'), row(epoch, 'searchVector', outcome, { private_read: true, ...(rerun ? { rerun, sid: 's.1' } : {}) })]);
        const open = rerun === 'matched' || rerun === 'differed' ? false : rerun === 'pending' || rerun?.startsWith('skipped:') ? true : !SETTLES[outcome];
        const s = status(dir);
        expect([outcome, rerun, s.evidence!.privacy_checks_unsettled_7d > 0, s.privacy_diverged === undefined]).toEqual([outcome, rerun, open, open]);
      }
    }
  });
  test('the same rows without the private-read marker never open the privacy question', () => {
    for (const outcome of SHADOW_OUTCOMES) {
      const { dir, epoch } = epochDir();
      appendLedgerRows(dir, [row(epoch, 'getPage', 'match'), row(epoch, 'getTags', outcome, { rerun: 'skipped:moved' }), row(epoch, 'getTags', outcome, { rerun: 'pending', sid: 'n.1' })]);
      expect([outcome, status(dir).evidence!.privacy_checks_unsettled_7d]).toEqual([outcome, 0]);
    }
  });
});
