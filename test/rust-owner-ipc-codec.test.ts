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
import { createHash } from 'node:crypto';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { FACT_SPACE_CLASS, normalizeLoweredClaim } from '../src/core/facts/withdrawal-schema.ts';
import { overlayCanonicalBodiesTyped } from '../src/core/page-state/snapshot.ts';
import type { PageSnapshot } from '../src/core/page-state/types.ts';
import { overlayStoreSnapshot, type StoreSnapshot } from '../src/core/rust-engine/snapshot-overlay.ts';

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

describe('a segmented page read with a subject-* purge crosses the owner socket (readPageSnapshot, readPageSnapshotsBatch)', () => {
  const claimHash = (claim: string) => createHash('sha256').update(normalizeLoweredClaim(claim.toLowerCase())).digest('hex');
  const rows = (text: string) => text.split('\n').filter(line => /^\| \d+ \|/.test(line));
  // An engine with no SQL, as the Rust client is: the fence normalization is typed, and nothing else answers.
  const fold = (text: string) => text.split('\n').map(line => line.toLowerCase().replace(new RegExp(`${FACT_SPACE_CLASS}+`, 'g'), ' ')).join('\n');
  const noSql = {
    normalizeFenceLines: async (bodies: string[], timelines: string[]) => bodies.map((body, i) => ({ i: i + 1, body: fold(body), timeline: fold(timelines[i]!) })),
    executeRaw: () => { throw new Error('the engine has no SQL'); },
    capabilities: new Set(),
    // The '*' tombstones by fence hash, as the Rust store's listGlobalPurgeWithdrawals answers them.
    listGlobalPurgeWithdrawals: async (_sourceId: string, hashes: string[]) =>
      hashes.includes(claimHash('Drinks green tea')) ? [{ visibility: 'private', fact_hash: claimHash('Drinks green tea'), withdrawn_at: '2026-11-23T20:00:00.000Z', purged: true }] : [],
  } as unknown as Parameters<typeof overlayCanonicalBodiesTyped>[0];
  const lead = `Lead.\n\n${renderFactsTable(['Drinks green tea', 'Prefers the aisle seat'].map((claim, i) => ({
    rowNum: i + 1, claim, kind: 'fact' as const, confidence: 1, visibility: 'private' as const, notability: 'medium' as const, active: true, context: '' })))}\n`;

  test('the lead overlay drops the purged claim after the snapshot went through the wire, through the typed purge lookup', async () => {
    const stored: StoreSnapshot = { page: segmentedPage('notes/large') as never, tags: [], revision: REVISION, sourceIncarnation: '1', withdrawals: [],
      globalPurges: { count: 1, latest: '2026-11-23T20:00:00.000Z', world_only: false },
      globalPurgeRows: [{ visibility: 'private', fact_hash: claimHash('Drinks green tea'), withdrawn_at: '2026-11-23T20:00:00.000Z', purged: true }] };
    const snapshot: PageSnapshot = crossTheSocket(await overlayStoreSnapshot(noSql.normalizeFenceLines as never, stored));
    expect(snapshot.globalPurges?.count).toBe(1);
    const out = await overlayCanonicalBodiesTyped(noSql, lead, '', snapshot.withdrawals, { sourceId: 'default', marker: snapshot.globalPurges });
    expect(rows(out.compiled_truth)).toHaveLength(1);
    expect(out.compiled_truth).toContain('Prefers the aisle seat');
    expect(out.compiled_truth).not.toContain('Drinks green tea');
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
