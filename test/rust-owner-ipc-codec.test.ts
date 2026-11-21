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
import { decodeError, decodeValue, encodeError, encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { PageMissingError } from '../src/core/engine-errors.ts';
import {
  PageProjectionConflictError, PageRevisionConflictError, PageSnapshotAmbiguousError, RevisionBackfillPendingError,
} from '../src/core/page-state/types.ts';
import { PageSourceMissingError } from '../src/core/page-state/guards.ts';
import { RetryAbortError } from '../src/core/retry.ts';
import { EmbeddingColumnNotRegisteredError } from '../src/core/search/embedding-column.ts';
import { GBrainError } from '../src/core/types.ts';
import {
  DerivedLinkEndpointChangedError, DerivedLinkRepairRequiredError, DerivedLinkSettingsChangedError,
} from '../src/core/derived-links.ts';
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

const REVISION = '0a1b2c3d-0000-4000-8000-000000000001';
const OTHER_REVISION = '0a1b2c3d-0000-4000-8000-000000000002';

describe('the domain errors a served method throws keep their class across the owner socket', () => {
  // Each is a class a served engine member or whole operation throws and a caller recovers from with `instanceof`
  // (add_link reclassifies a PageMissingError, revision-conflict handling reads PageRevisionConflictError.code).
  const cases: Array<[string, Error, new (...args: never[]) => Error, Record<string, unknown>]> = [
    ['PageMissingError', new PageMissingError('addLink', 'to', 'people/ada', 'default'), PageMissingError,
      { operation: 'addLink', endpoint: 'to', slug: 'people/ada', sourceId: 'default' }],
    ['PageRevisionConflictError', new PageRevisionConflictError(REVISION, OTHER_REVISION), PageRevisionConflictError,
      { code: 'revision_conflict', expectedRevision: REVISION, currentRevision: OTHER_REVISION }],
    ['PageRevisionConflictError (revision required)', new PageRevisionConflictError(undefined, OTHER_REVISION), PageRevisionConflictError,
      { code: 'revision_required', currentRevision: OTHER_REVISION }],
    ['RevisionBackfillPendingError', new RevisionBackfillPendingError(REVISION), RevisionBackfillPendingError,
      { code: 'revision_backfill_pending', expectedRevision: REVISION }],
    ['PageProjectionConflictError', new PageProjectionConflictError(REVISION, OTHER_REVISION, ['chunk_digest'], 'notes/a', 'default'), PageProjectionConflictError,
      { changed: ['chunk_digest'], slug: 'notes/a', sourceId: 'default' }],
    ['DerivedLinkEndpointChangedError', new DerivedLinkEndpointChangedError('An endpoint moved'), DerivedLinkEndpointChangedError,
      { code: 'revision_conflict' }],
    ['DerivedLinkSettingsChangedError', new DerivedLinkSettingsChangedError(), DerivedLinkSettingsChangedError,
      { code: 'revision_conflict' }],
    ['DerivedLinkRepairRequiredError', new DerivedLinkRepairRequiredError(), DerivedLinkRepairRequiredError,
      { code: 'derived_link_provenance_required' }],
    ['PageSnapshotAmbiguousError', new PageSnapshotAmbiguousError(), PageSnapshotAmbiguousError, {}],
    ['PageSourceMissingError', new PageSourceMissingError('gone'), PageSourceMissingError, { sourceId: 'gone' }],
    ['EmbeddingColumnNotRegisteredError', new EmbeddingColumnNotRegisteredError('embedding_x', ['embedding']), EmbeddingColumnNotRegisteredError,
      { code: 'embedding_column_not_registered', columnName: 'embedding_x', validColumns: ['embedding'] }],
    ['GBrainError', new GBrainError('Bad thing', 'it broke', 'fix it', 'https://example.test/doc'), GBrainError,
      { problem: 'Bad thing', cause_description: 'it broke', fix: 'fix it', docs_url: 'https://example.test/doc' }],
    ['RetryAbortError', new RetryAbortError(), RetryAbortError, { tag: 'RETRY_ABORTED' }],
  ];

  for (const [name, error, cls, props] of cases) {
    test(`${name} decodes as its own class with its properties and message`, () => {
      const back = decodeError(JSON.parse(JSON.stringify(encodeError(error)))) as Error;
      expect(back).toBeInstanceOf(cls);
      expect(back.name).toBe(error.name);
      expect(back.message).toBe(error.message);
      for (const [key, value] of Object.entries(props)) expect((back as unknown as Record<string, unknown>)[key]).toEqual(value);
    });
  }

  test('keeps the inheritance the recovery code relies on', () => {
    const wire = (e: Error) => decodeError(JSON.parse(JSON.stringify(encodeError(e))));
    expect(wire(new RevisionBackfillPendingError(REVISION))).toBeInstanceOf(PageRevisionConflictError);
    expect(wire(new PageProjectionConflictError(REVISION, OTHER_REVISION, [], 'a', 'default'))).toBeInstanceOf(PageRevisionConflictError);
    expect(wire(new DerivedLinkSettingsChangedError())).toBeInstanceOf(DerivedLinkEndpointChangedError);
    expect(wire(new PageMissingError('addTimelineEntry', 'page', 'a', 'default'))).not.toBeInstanceOf(PageRevisionConflictError);
  });
});
