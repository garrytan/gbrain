/**
 * Parity for the sync import provenance records (persistence/sync-holds.ts): the git-gap census, the rows-behind scan,
 * the discovery prescreen and the waivers read them through readOpCheckpointRecords, and the import writes them
 * through writeOpCheckpointRecords (engine-sql/op-checkpoint.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: recordSyncImportProvenance(s) and readSyncImportProvenance(s) give the same records on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the last value for a page
 *    wins, a page with no record is absent, and a read inside `transaction()` sees the transaction's own record.
 *  - Regression: a missing or stale record makes the census count a page behind its file, and a parser regression
 *    check compares bytes against the wrong import.
 *  - Why existing coverage misses it: the records were read and written through `executeRaw`, which the Rust engine
 *    refuses, so no case compared them across engines; the statement text is pinned by
 *    test/engine-sql-caller-raw-sql-pins.test.ts.
 *  - Seam: none. `recorded_at` is the clock's, so it compares by shape.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import {
  readSyncImportProvenance, readSyncImportProvenances, recordSyncImportProvenance, recordSyncImportProvenances,
  SYNC_IMPORT_PROVENANCE_OP, type SyncImportProvenance,
} from '../../src/core/persistence/sync-holds.ts';

const { parityTest } = parityArms(testBackends());

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function provenance(pageId: number, rawSha: string): Omit<SyncImportProvenance, 'recorded_at' | 'validated'> {
  return { source_id: 'default', incarnation: 'inc-1', page_id: pageId, origin: `notes/page-${pageId}.md`, raw_sha256: rawSha,
    gbrain_version: '0.0.0-parity', recovery: [{ kind: 'quote', key: 'title', line: 2, recovery_version: 1 }] };
}

/** A record with its clock stamp replaced by its shape. */
function view(record: SyncImportProvenance | null | undefined) {
  if (!record) return record ?? null;
  expect(record.recorded_at).toMatch(ISO);
  return { ...record, recorded_at: 'iso' };
}

/** The map's entries in page order. */
function entries(map: Map<number, SyncImportProvenance>) {
  return [...map].sort(([a], [b]) => a - b).map(([pageId, record]) => [pageId, view(record)]);
}

parityTest('recordSyncImportProvenances keeps the last value per page and the read leaves out pages without a record',
  { methods: ['writeOpCheckpointRecords', 'readOpCheckpointRecords'] }, async (engine) => {
    await recordSyncImportProvenances(engine, [provenance(1, 'a1'), provenance(2, 'b1'), provenance(1, 'a2')]);
    await recordSyncImportProvenances(engine, []);
    const many = await readSyncImportProvenances(engine, 'default', 'inc-1', [1, 2, 3, 2]);
    const other = await readSyncImportProvenances(engine, 'default', 'inc-2', [1, 2]);
    const none = await readSyncImportProvenances(engine, 'default', 'inc-1', []);
    return {
      many: entries(many), other: entries(other), none: entries(none),
      one: view(await readSyncImportProvenance(engine, 'default', 'inc-1', 2)),
      missing: await readSyncImportProvenance(engine, 'default', 'inc-1', 3),
    };
  });

parityTest('recordSyncImportProvenance replaces the record a page had', { methods: ['writeOpCheckpointRecords', 'readOpCheckpointRecords'] }, async (engine) => {
  await recordSyncImportProvenance(engine, provenance(7, 'first'));
  const before = view(await readSyncImportProvenance(engine, 'default', 'inc-1', 7));
  await recordSyncImportProvenance(engine, { ...provenance(7, 'second'), working: true, disk_sha256: null, disk_blob_oid: null });
  return { before, after: view(await readSyncImportProvenance(engine, 'default', 'inc-1', 7)) };
});

parityTest('a provenance record written inside a transaction is read in it and after it',
  { methods: ['transaction', 'readOpCheckpointRecords'] }, async (engine) => {
    const inside = await engine.transaction(async (tx) => {
      await recordSyncImportProvenance(tx, provenance(4, 'tx'));
      return entries(await readSyncImportProvenances(tx, 'default', 'inc-1', [4]));
    });
    return { inside, after: entries(await readSyncImportProvenances(engine, 'default', 'inc-1', [4])) };
  });

parityTest('readOpCheckpointRecords answers a checkpoint parent\'s first key, null for an empty one', {
  methods: ['writeOpCheckpointKeys', 'readOpCheckpointRecords', 'writeOpCheckpointRecords'],
}, async (engine) => {
  await engine.writeOpCheckpointKeys('parity-records', 'empty', []);
  await engine.writeOpCheckpointKeys('parity-records', 'keys', ['b', 'a']);
  await engine.writeOpCheckpointRecords('parity-records', [{ fingerprint: 'object', record: { nested: { list: [1, 'two', null] }, n: 2.5 } }]);
  const records = await engine.readOpCheckpointRecords('parity-records', ['empty', 'keys', 'object', 'absent']);
  // A provenance op never reads another op's parents.
  const otherOp = await engine.readOpCheckpointRecords(SYNC_IMPORT_PROVENANCE_OP, ['empty', 'keys', 'object']);
  return { records: records.map(r => JSON.stringify(r)).sort(), otherOp };
});
