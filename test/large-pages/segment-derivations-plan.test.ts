/**
 * Pure helpers of the per-segment derivation interface (page-body/derivations.ts): the work plan from manifest
 * metadata, the context hash and the facts.source_window identity. Engine rows: test/engine-sql-segment-derivations.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { parseSourceWindow, planSegmentDerivations, segmentDerivationContextHash, sourceWindowFor, sourceWindowKey,
  SEGMENT_DERIVATION_KINDS, type LiveSegment, type SegmentDerivationRow } from '../../src/core/page-body/derivations.ts';

const h = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());
const live = (occurrenceId: number, text = `t${occurrenceId}`, context = 'c'): LiveSegment => ({ occurrenceId, sha256: h(text), contextHash: h(context) });
function stored(occurrenceId: number, overrides: Partial<SegmentDerivationRow> = {}): SegmentDerivationRow {
  return { pageId: 1, kind: 'links', occurrenceId, version: 2, segmentSha256: h(`t${occurrenceId}`), contextHash: h('c'), state: 'done',
    output: null, receipt: null, createdAt: '', updatedAt: '', ...overrides };
}

describe('planSegmentDerivations', () => {
  test('settled rows with matching text, context and version are current; new occurrences are todo; gone ones are retired', () => {
    const plan = planSegmentDerivations('links', 2, [live(1), live(2), live(5)], [stored(1), stored(2), stored(3)]);
    expect(plan.current.map(r => r.occurrenceId)).toEqual([1, 2]);
    expect(plan.todo.map(s => s.occurrenceId)).toEqual([5]);
    expect(plan.retired.map(r => r.occurrenceId)).toEqual([3]);
  });

  test('a changed text, a changed context or another version is redone; partial and failed are redone; skipped is settled', () => {
    const rows = [stored(1), stored(2), stored(3, { version: 1 }), stored(4, { state: 'partial' }), stored(5, { state: 'failed' }), stored(6, { state: 'skipped' })];
    const plan = planSegmentDerivations('links', 2, [live(1, 'edited'), live(2, 't2', 'title changed'), live(3), live(4), live(5), live(6)], rows);
    expect(plan.todo.map(s => s.occurrenceId)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.current.map(r => r.occurrenceId)).toEqual([6]);
    expect(plan.retired).toEqual([]);
  });

  test('rows of another pipeline never count', () => {
    const plan = planSegmentDerivations('timeline', 2, [live(1)], [stored(1), stored(9)]);
    expect(plan.todo.map(s => s.occurrenceId)).toEqual([1]);
    expect(plan.current).toEqual([]);
    expect(plan.retired).toEqual([]);
  });
});

describe('segmentDerivationContextHash', () => {
  test('is 32 bytes and ignores key order at every depth, as a JSONB round trip reorders keys', () => {
    const a = segmentDerivationContextHash('links', { entryState: { fence: { depth: 1, open: false }, date: '2026-01-02' }, page: { title: 'T', type: 'note' } });
    const b = segmentDerivationContextHash('links', { entryState: { date: '2026-01-02', fence: { open: false, depth: 1 } }, page: { type: 'note', title: 'T' } });
    expect(a.byteLength).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('moves with the pipeline, the entry state and each page-level input', () => {
    const base = { entryState: { fence: null }, page: { title: 'T', gazetteer_generation: 4 } };
    const hex = (x: Uint8Array) => Buffer.from(x).toString('hex');
    const hashes = new Set([
      hex(segmentDerivationContextHash('links', base)),
      hex(segmentDerivationContextHash('mentions', base)),
      hex(segmentDerivationContextHash('links', { ...base, entryState: { fence: 'open' } })),
      hex(segmentDerivationContextHash('links', { ...base, page: { title: 'T2', gazetteer_generation: 4 } })),
      hex(segmentDerivationContextHash('links', { ...base, page: { title: 'T', gazetteer_generation: 5 } })),
    ]);
    expect(hashes.size).toBe(5);
  });

  test('every kind the table accepts is a distinct hash domain', () => {
    const seen = new Set(SEGMENT_DERIVATION_KINDS.map(k => Buffer.from(segmentDerivationContextHash(k, { entryState: null, page: {} })).toString('hex')));
    expect(seen.size).toBe(SEGMENT_DERIVATION_KINDS.length);
  });
});

describe('source windows', () => {
  test('identity is occurrence, ordinal and the text hash', () => {
    const w = sourceWindowFor(42, 3, 'user: hi\n');
    expect(w).toEqual({ occurrence_id: 42, window_ordinal: 3, window_text_sha: createHash('sha256').update('user: hi\n').digest('hex') });
    expect(sourceWindowKey(w)).toBe(`42:3:${w.window_text_sha}`);
    expect(sourceWindowKey(sourceWindowFor(42, 3, 'user: hi!\n'))).not.toBe(sourceWindowKey(w));
  });

  test('parse accepts a stored anchor and NULL, and throws on what the column CHECK refuses', () => {
    const w = sourceWindowFor(1, 0, 'x');
    expect(parseSourceWindow({ ...w })).toEqual(w);
    expect(parseSourceWindow(null)).toBeNull();
    for (const bad of [JSON.stringify(w), [w], { ...w, occurrence_id: '1' }, { ...w, window_ordinal: 1.5 }, { ...w, window_text_sha: 'ABC' }]) {
      expect(() => parseSourceWindow(bad)).toThrow('malformed facts.source_window');
    }
  });
});
