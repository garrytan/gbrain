/**
 * Parity for the `sync.admission` read (persistence/sync-admission.ts readSyncAdmission): a managed sync pass reads it at
 * pin, inside each group's admission transaction and at publication, through readStoredConfigValue
 * (engine-sql/config.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    answers the same admission: unset is `normal`, a stored value is trimmed, an unknown one fails closed to
 *    `classify_only`; a read inside `transaction()` sees the transaction's own write; and a batch's shared reads
 *    (page-mutations.ts batchSharedReads) answer it once per key.
 *  - Regression: a wrong admission lets a paused pass delete files, or pauses a normal one.
 *  - Why existing coverage misses it: the read ran through `executeRaw`, which the Rust engine refuses, so no case
 *    compared it across engines; the statement text is pinned by test/engine-sql-caller-raw-sql-pins.test.ts.
 *  - Seam: none.
 */
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { readSyncAdmission, SYNC_ADMISSION_KEY } from '../../src/core/persistence/sync-admission.ts';
import { batchSharedReads } from '../../src/core/persistence/page-mutations.ts';

const { parityTest } = parityArms(testBackends());

parityTest('readSyncAdmission reads the stored sync.admission, trimmed, and fails closed on an unknown value', {
  methods: ['setConfig', 'readStoredConfigValue'],
}, async (engine) => {
  const read = async (value: string | null) => {
    if (value !== null) await engine.setConfig(SYNC_ADMISSION_KEY, value);
    return readSyncAdmission(engine);
  };
  return {
    unset: await read(null), imports: await read('imports_only'), padded: await read('  classify_only \n'),
    blank: await read('   '), unknown: await read('paused'), normal: await read('normal'),
    stored: await engine.readStoredConfigValue(SYNC_ADMISSION_KEY), absent: await engine.readStoredConfigValue('parity.absent-key'),
  };
});

parityTest('readSyncAdmission inside a transaction sees the transaction\'s own write', {
  methods: ['transaction', 'setConfig', 'readStoredConfigValue'],
}, async (engine) => {
  await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
  const inside = await engine.transaction(async (tx) => {
    const before = await readSyncAdmission(tx);
    await tx.setConfig(SYNC_ADMISSION_KEY, 'imports_only');
    return { before, after: await readSyncAdmission(tx) };
  });
  return { inside, committed: await readSyncAdmission(engine) };
});

parityTest('a batch\'s shared reads answer sync.admission once per key', {
  methods: ['setConfig', 'readStoredConfigValue'],
}, async (engine) => {
  await engine.setConfig(SYNC_ADMISSION_KEY, 'imports_only');
  const batch = batchSharedReads(engine);
  const first = await readSyncAdmission(batch);
  await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
  return { first, again: await readSyncAdmission(batch), freshBatch: await readSyncAdmission(batchSharedReads(engine)) };
});
