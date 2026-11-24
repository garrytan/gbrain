/**
 * Parity for a managed sync pass's `I⋈P` read (persistence/sync-pass.ts `readPages`): the pages of a source with a
 * recorded origin and the fields of their sync import provenance records, through readSyncImportPageRows
 * (engine-sql/sync-pass-pages.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    answers the same rows for an id window and a keyset page: only pages of the source with a `source_path`, in page id
 *    order, each record field folded to a flag when it repeats the page's, parsers compared as jsonb, `->>` / `::text`
 *    giving jsonb text for a non-string, and `sync_deleted` false for a deletion no managed sync made. The
 *    whole-source cursor answers the keyset's rows on every arm (on Rust it pages the keyset by id). The expected parser
 *    binds as an object, so a record with that parser reads `rec_parser_expected` true on Postgres too.
 *  - Regression: a wrong flag or field makes the classifier see a page as changed, unchanged or deleted by sync when it
 *    is not, so a pass re-imports, skips or holds the wrong file.
 *  - Why existing coverage misses it: the read ran through `executeRaw`, which the Rust engine refuses, so no case
 *    compared it across engines; the statement texts are pinned by test/engine-sql-caller-raw-sql-pins.test.ts.
 *  - Seam: none. Page ids, revisions and request ids are generated, so rows name pages by slug and compare revisions to
 *    the page's own. A managed sync deletion's tombstone needs the page's exact `deleted_at`, which no typed member
 *    returns at full precision, so the true case is covered by the store's unit test, not here.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { SyncImportPageRow } from '../../src/core/engine-sql/sync-pass-pages.ts';
import { SYNC_IMPORT_PROVENANCE_OP, syncImportParser } from '../../src/core/persistence/sync-holds.ts';
import { refusesInput } from './input-refusal.ts';

const { parityTest } = parityArms(testBackends());

const NOTE: PageInput = { type: 'note', title: 'Synced note', compiled_truth: 'A synced note body.', timeline: '' };
const EXPECTED = syncImportParser(null);
const Q = { sourceId: 'default', incarnation: 'inc-1', expected: EXPECTED };

interface Seeded { ids: Map<string, string>; revisions: Map<string, string> }

/** Pages with and without a recorded origin, one deleted, and their import records of incarnation `inc-1`. */
async function seed(engine: BrainEngine): Promise<Seeded> {
  const files: Array<[string, string | null]> = [['notes/a', 'notes/a.md'], ['notes/b', 'notes/b.md'], ['notes/no-origin', null],
    ['notes/empty', 'notes/empty.md'], ['notes/keys', 'notes/keys.md'], ['notes/gone', 'notes/gone.md'], ['notes/bare', 'notes/bare.md']];
  for (const [slug, path] of files) await engine.putPage(slug, { ...NOTE, ...(path ? { source_path: path } : {}) });
  await engine.softDeletePage('notes/gone');
  const ids = new Map<string, string>(), revisions = new Map<string, string>();
  for (const [slug] of files) {
    const page = await engine.getPage(slug, { includeDeleted: true });
    ids.set(slug, String(page!.id));
    revisions.set(slug, String(page!.knowledge_revision));
  }
  const fp = (slug: string) => `default:inc-1:${ids.get(slug)}`;
  await engine.writeOpCheckpointRecords(SYNC_IMPORT_PROVENANCE_OP, [
    // Every field repeats the page's, and the parser is the expected one with its keys in another order.
    { fingerprint: fp('notes/a'), record: { origin: 'notes/a.md', blob_oid: 'blob-a', disk_blob_oid: 'blob-a', revision: revisions.get('notes/a'),
      parser: { schema_pack: EXPECTED.schema_pack, markdown_chunker: EXPECTED.markdown_chunker, parser_version: EXPECTED.parser_version },
      full_episode: 'episode-1', working: true } },
    // Every field differs: a moved origin, a disk blob of its own, no revision, another parser, non-string scalars.
    { fingerprint: fp('notes/b'), record: { origin: 'old/b.md', blob_oid: 'blob-b', disk_blob_oid: 'disk-b',
      parser: { parser_version: 'code=1', markdown_chunker: 4, schema_pack: null, extra: { z: 1, a: [true, 'x'] } }, full_episode: 7, working: null } },
    { fingerprint: fp('notes/gone'), record: { origin: 'notes/gone.md', blob_oid: null, working: false } },
    { fingerprint: fp('notes/no-origin'), record: { origin: 'notes/no-origin.md' } },
  ]);
  // A record whose completed keys are empty, and one whose first key is a string, not an object.
  await engine.writeOpCheckpointKeys(SYNC_IMPORT_PROVENANCE_OP, fp('notes/empty'), []);
  await engine.writeOpCheckpointKeys(SYNC_IMPORT_PROVENANCE_OP, fp('notes/keys'), ['first-key']);
  // A tombstone that does not match the deletion's time, and one on a live page: neither is a managed sync deletion.
  await engine.writeOpCheckpointRecords('sync-delete-tombstone', [
    { fingerprint: ids.get('notes/gone')!, record: { deleted_at: '2000-01-01T00:00:00+00:00' } },
    { fingerprint: ids.get('notes/a')!, record: { deleted_at: '2000-01-01T00:00:00+00:00' } },
  ]);
  return { ids, revisions };
}

/** Rows with generated values replaced: the page by its slug, a revision by whether it is the page's own. */
function view(rows: SyncImportPageRow[], seeded: Seeded) {
  const slugOf = new Map([...seeded.ids].map(([slug, id]) => [id, slug]));
  return rows.map(row => {
    const slug = slugOf.get(String(row.id));
    expect(row.slug).toBe(slug!);
    const own = seeded.revisions.get(row.slug);
    return { ...row, id: slug, revision: row.revision === own ? 'own' : row.revision,
      rec_revision: row.rec_revision === own ? 'own' : row.rec_revision, request_id: row.request_id === null ? null : typeof row.request_id };
  });
}

parityTest('readSyncImportPageRows reads a source\'s pages with their import records by id window and by keyset', {
  methods: ['putPage', 'softDeletePage', 'getPage', 'writeOpCheckpointRecords', 'writeOpCheckpointKeys', 'readSyncImportPageRows'],
}, async (engine) => {
  const seeded = await seed(engine);
  const id = (slug: string) => seeded.ids.get(slug)!;
  const all = await engine.readSyncImportPageRows(Q, { after: 0, limit: 100 });
  const first = await engine.readSyncImportPageRows(Q, { after: 0, limit: 2 });
  const rest = await engine.readSyncImportPageRows(Q, { after: Number(first[first.length - 1]!.id), limit: 100 });
  // An id without a recorded origin, an id with no page, and a repeated id add no row.
  const window = await engine.readSyncImportPageRows(Q, { ids: [id('notes/gone'), id('notes/no-origin'), '999999', id('notes/b'), id('notes/b'), id('notes/a')] });
  const otherIncarnation = await engine.readSyncImportPageRows({ ...Q, incarnation: 'inc-2' }, { ids: [id('notes/a'), id('notes/b')] });
  const otherSource = await engine.readSyncImportPageRows({ ...Q, sourceId: 'other' }, { after: 0, limit: 100 });
  const none = await engine.readSyncImportPageRows(Q, { ids: [] });
  expect(view([...first, ...rest], seeded)).toEqual(view(all, seeded));
  return { all: view(all, seeded), first: view(first, seeded).map(r => r.id), window: view(window, seeded),
    otherIncarnation: view(otherIncarnation, seeded), otherSource, none };
});

parityTest('readSyncImportPageRows inside a transaction reads the record the transaction wrote', {
  methods: ['transaction', 'writeOpCheckpointRecords', 'readSyncImportPageRows'],
}, async (engine) => {
  await engine.putPage('notes/tx', { ...NOTE, source_path: 'notes/tx.md' });
  const page = await engine.getPage('notes/tx');
  const seeded: Seeded = { ids: new Map([['notes/tx', String(page!.id)]]), revisions: new Map([['notes/tx', String(page!.knowledge_revision)]]) };
  const inside = await engine.transaction(async (tx) => {
    await tx.writeOpCheckpointRecords(SYNC_IMPORT_PROVENANCE_OP, [{ fingerprint: `default:inc-1:${page!.id}`, record: { origin: 'notes/tx.md', parser: EXPECTED } }]);
    return view(await tx.readSyncImportPageRows(Q, { ids: [String(page!.id)] }), seeded);
  });
  return { inside, after: view(await engine.readSyncImportPageRows(Q, { after: 0, limit: 10 }), seeded) };
});

parityTest('the whole-source sync pass cursor answers the keyset\'s rows on every engine', {
  methods: ['transaction', 'declareSyncImportPageCursor', 'fetchSyncImportPageCursor', 'readSyncImportPageRows'],
}, async (engine) => {
  const seeded = await seed(engine);
  const keyset = await engine.readSyncImportPageRows(Q, { after: 0, limit: 100 });
  const pages = await engine.transaction(async (tx) => {
    await tx.declareSyncImportPageCursor(Q);
    const read: SyncImportPageRow[][] = [];
    for (;;) {
      const page = await tx.fetchSyncImportPageCursor(2);
      read.push(page);
      if (page.length < 2) return read;
    }
  });
  // The cursor's statement has no ORDER BY; the pass takes its rows in the order they come.
  const rows = view(pages.flat(), seeded).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  expect(rows).toEqual(view(keyset, seeded).sort((a, b) => String(a.id).localeCompare(String(b.id))));
  return { sizes: pages.map(p => p.length), rows };
});

parityTest('readSyncImportPageRows refuses a keyset page size that is not a positive safe integer, as SQL does', {
  methods: ['putPage', 'readSyncImportPageRows'],
}, async (engine) => {
  await engine.putPage('notes/limit', { ...NOTE, source_path: 'notes/limit.md' });
  const sizes = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2];
  const refused: Record<string, boolean> = {};
  for (const limit of sizes) {
    refused[String(limit)] = await refusesInput(engine.readSyncImportPageRows(Q, { after: 0, limit }));
  }
  // Control: the smallest valid size still answers the page.
  const one = (await engine.readSyncImportPageRows(Q, { after: 0, limit: 1 })).map(row => row.slug);
  return { refused, one };
});
