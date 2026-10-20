/**
 * Lost extraction writes must leave their pages due. These helpers carry the
 * failed pages from a link/timeline write to the watermark stamp, so the
 * pages whose rows were dropped are never marked extracted.
 */
import { describe, test, expect } from 'bun:test';
import { ExtractBatchWriteError, batchFailure, extractionWrite, withoutFailedRefs } from '../src/core/extract-watermark.ts';

describe('extract batch-loss watermark helpers', () => {
  test('withoutFailedRefs drops only refs named by a failed write, scoped by source', () => {
    const refs = [
      { slug: 'a', source_id: 'wiki', extractedAt: '1' },
      { slug: 'b', source_id: 'wiki', extractedAt: '2' },
      { slug: 'a', source_id: 'other', extractedAt: '3' },
    ];
    const failures = [batchFailure('timeline', 3, [{ slug: 'a', source_id: 'wiki' }, { slug: 'a', source_id: 'wiki' }], new Error('lost'))];
    expect(failures[0]!.refs).toEqual([{ slug: 'a', source_id: 'wiki' }]);
    expect(withoutFailedRefs(refs, failures)).toEqual([refs[1], refs[2]]);
    expect(withoutFailedRefs(refs, [])).toBe(refs);
  });

  test('ExtractBatchWriteError is typed and summarizes rows, pages and the first cause', () => {
    const error = new ExtractBatchWriteError([
      batchFailure('links', 2, [{ slug: 'a', source_id: 'wiki' }], new Error('pool exhausted')),
      batchFailure('timeline', 5, [{ slug: 'a', source_id: 'wiki' }, { slug: 'b', source_id: 'wiki' }], 'second'),
    ]);
    expect(error.code).toBe('extract_write_lost');
    expect(error.message).toContain('2 links/timeline write(s) failed (7 row(s)) across 2 page(s)');
    expect(error.message).toContain('first error: pool exhausted');
  });

  test('extractionWrite annotates a failed write once and passes successes through', async () => {
    expect(await extractionWrite('links', 1, [{ slug: 'a', source_id: 'wiki' }], async () => 7)).toBe(7);
    const cause = new Error('storage');
    let first: unknown;
    try { await extractionWrite('timeline', 1, [{ slug: 'a', source_id: 'wiki' }], async () => { throw cause; }); } catch (e) { first = e; }
    expect(first).toBeInstanceOf(ExtractBatchWriteError);
    expect((first as ExtractBatchWriteError).failures[0]).toMatchObject({ kind: 'timeline', rows: 1, error: cause });
    // An already-typed loss is rethrown as-is, not wrapped a second time.
    let second: unknown;
    try { await extractionWrite('links', 1, [{ slug: 'b', source_id: 'wiki' }], async () => { throw first; }); } catch (e) { second = e; }
    expect(second).toBe(first);
  });
});
