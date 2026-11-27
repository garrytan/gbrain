/**
 * Doctor checkpoint reads (src/core/engine-sql/doctor-checkpoints.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_checkpoints.rs, rust/docs/store/cli-reads-doctor-checkpoints.md).
 *
 * Served from the store: the doctor last-known pair, the latest connector receipt and the facts-absorb failure groups
 * (`ingest_log`), the sync-admission setting's config value, the fence census candidate rows (written by the census,
 * rust/docs/store/cli-reads-doctor-fence.md), and the derived-origin parks whose page is a tombstone (the checkpoint and
 * page records, persistence/diagnostic_checkpoints.rs; any typed `writeOpCheckpointRecord(s)` writes a park), and the
 * soak counter rows (`readSoakCounterRows`, written by the typed `addSoakCounterEvent`).
 *
 * Empty, no writer: every other `op_checkpoints` operation is written only through `executeRaw`, which a Rust brain
 * refuses, so no row of it exists there. Those members answer the empty value without a store call: what the same read
 * finds on a PGLite brain nothing has written to.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The parks whose page is still a tombstone, oldest first (rust/crates/gbrain-store/src/persistence/diagnostic_checkpoints.rs). */
export const listDerivedOriginParks: Member<'listDerivedOriginParks'> = async (brain, op) =>
  ((await storeCall({ member: 'listDerivedOriginParks' }, () => brain.listDerivedOriginParks(op))) as Array<{ park: unknown }>)
    .map(row => row.park) as Awaited<ReturnType<BrainEngine['listDerivedOriginParks']>>;
export const listPurgeParks: Member<'listPurgeParks'> = async () => [];
/** The soak counter record of each named day (`completed_keys->0` of each found row; a day with none is absent), from the checkpoint records `addSoakCounterEvent` writes. */
export const readSoakCounterRows: Member<'readSoakCounterRows'> = async (brain, op, days) =>
  await storeCall({ member: 'readSoakCounterRows' }, () => brain.readOpCheckpointRecords(op, [...days])) as Array<Record<string, unknown>>;
export const listUnfinishedManagedSyncCursors: Member<'listUnfinishedManagedSyncCursors'> = async () => [];
export const listManagedSyncPassStops: Member<'listManagedSyncPassStops'> = async () => [];
export const listManagedSyncBacklogHeaders: Member<'listManagedSyncBacklogHeaders'> = async () => [];
export const readManagedSyncPassRow: Member<'readManagedSyncPassRow'> = async () => null;
export const listLiveManagedSyncPassRows: Member<'listLiveManagedSyncPassRows'> = async () => [];
export const listCheckpointBlockedSources: Member<'listCheckpointBlockedSources'> = async () => [];
export const listOpenIdentityDowngrades: Member<'listOpenIdentityDowngrades'> = async () => [];
export const listHeldManagedAtomRows: Member<'listHeldManagedAtomRows'> = async () => [];
export const listCredentialResealHoldRows: Member<'listCredentialResealHoldRows'> = async () => [];

/** The candidate parts the census wrote (`upsertFenceCandidatePart`), of live source incarnations, by fingerprint. */
export const listFenceCandidateRecords: Member<'listFenceCandidateRecords'> = (brain, op, sourceIds) =>
  storeCall({ member: 'listFenceCandidateRecords' }, () => brain.listFenceCandidateRecords({ op, sourceIds: sourceIds ? [...sourceIds] : null }));

export const readDoctorLastKnown: Member<'readDoctorLastKnown'> = (brain, op) =>
  storeCall({ member: 'readDoctorLastKnown' }, () => brain.readDoctorLastKnown(op));

export const writeDoctorLastKnown: Member<'writeDoctorLastKnown'> = async (brain, op, rows) => {
  if (!rows.length) return;
  await storeCall({ member: 'writeDoctorLastKnown' }, () => brain.writeDoctorLastKnown({ op, rows }));
};

/** The store keeps the config value; the dating row is an `op_checkpoints` row only `writeSyncAdmission` writes (through `executeRaw`), so none exists. */
export const readSyncAdmissionSettingRow: Member<'readSyncAdmissionSettingRow'> = async (brain, key) =>
  ({ stored: (await storeCall({ member: 'getConfig' }, () => brain.getConfig(key))) ?? null, row_value: null, set_at: null });

export const readLatestConnectorReceipt: Member<'readLatestConnectorReceipt'> = async (brain) =>
  (await storeCall({ member: 'readLatestConnectorReceipt' }, () => brain.readLatestConnectorReceipt())) ?? null;

export const listFactsAbsorbFailureGroups: Member<'listFactsAbsorbFailureGroups'> = (brain) =>
  storeCall({ member: 'listFactsAbsorbFailureGroups' }, () => brain.listFactsAbsorbFailureGroups());
