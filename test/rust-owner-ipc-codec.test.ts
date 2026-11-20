/**
 * Owner socket codec: the domain values and errors a served BrainEngine method hands back must cross the socket as
 * the owner produced them (src/core/rust-engine/owner-ipc/codec.ts). Pure codec round trips, no owner process.
 *
 * Authoring gate (docs/TESTING.md): these protect what a second gbrain process on a Rust brain sees. A page stored in
 * segments must reach it as metadata whose body fields still refuse (a list holding one must not fail whole), and a
 * typed error must keep its class so the `instanceof` recovery of the callers still fires. A regression is an encoder
 * that reads a guarded body getter, or a class missing from the decoder's table; the in-process engine tests do not
 * cross the socket, and rust-owner-ipc.test.ts covers only plain values. No production seam is added.
 */
import { describe, expect, test } from 'bun:test';
import { decodeValue, encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { guardSegmentedBody } from '../src/core/page-body/page-shape.ts';
import { OperationError } from '../src/core/ops/contract.ts';

/** What the owner sends: through the real JSON wire, as the socket carries it. */
function crossTheSocket<T>(value: T): T {
  return decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as T;
}

function segmentedPage(slug: string): Record<string, unknown> {
  return guardSegmentedBody({
    id: 7, slug, source_id: 'default', type: 'note', title: 'Large page', frontmatter: { tags: ['a'] },
    body_storage: 'segmented', body_bytes: 30_000_000, content_hash: 'abc', created_at: new Date('2026-11-17T15:00:00.000Z'),
  }, 'getPage');
}

function refusal(read: () => unknown): OperationError {
  try { read(); } catch (error) { return error as OperationError; }
  throw new Error('the body field did not refuse');
}

describe('a page stored in segments crosses the owner socket (getPage, readPageSnapshot, listPages)', () => {
  test('keeps its metadata and its body fields still refuse with page_body_segmented', () => {
    const original = segmentedPage('notes/large');
    const back = crossTheSocket(original);
    expect(back.slug).toBe('notes/large');
    expect(back.source_id).toBe('default');
    expect(back.body_storage).toBe('segmented');
    expect(back.body_bytes).toBe(30_000_000);
    expect(back.frontmatter).toEqual({ tags: ['a'] });
    expect(back.created_at).toEqual(new Date('2026-11-17T15:00:00.000Z'));
    expect(Object.keys(back)).toEqual(Object.keys(original));
    for (const field of ['compiled_truth', 'timeline']) {
      const error = refusal(() => back[field]);
      expect(error).toBeInstanceOf(OperationError);
      expect(error.code).toBe('page_body_segmented');
      expect(error.message).toContain('getPage.' + field);
      expect(error.message).toContain('notes/large');
      expect(refusal(() => { back[field] = 'x'; }).code).toBe('page_body_segmented');
    }
    expect(refusal(() => JSON.stringify(back)).code).toBe('page_body_segmented');
  });

  test('one segmented row does not break the list it is in, and the inline pages stay readable', () => {
    const inline = { id: 1, slug: 'notes/small', source_id: 'default', type: 'note', title: 'Small', compiled_truth: 'hello', timeline: '', body_storage: 'inline' };
    const back = crossTheSocket({ snapshot: { page: segmentedPage('notes/large') }, rows: [inline, segmentedPage('notes/large-2')] });
    expect(back.rows[0]).toEqual(inline);
    expect(back.rows[1]!.slug).toBe('notes/large-2');
    expect(refusal(() => back.rows[1]!.compiled_truth).code).toBe('page_body_segmented');
    expect((back.snapshot.page as Record<string, unknown>).slug).toBe('notes/large');
    expect(refusal(() => (back.snapshot.page as Record<string, unknown>).timeline).code).toBe('page_body_segmented');
  });
});
