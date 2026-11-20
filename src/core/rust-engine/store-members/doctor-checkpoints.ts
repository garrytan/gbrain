/**
 * Doctor checkpoint reads (src/core/engine-sql/doctor-checkpoints.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_checkpoints.rs, rust/docs/store/cli-reads-doctor-checkpoints.md).
 *
 * Served from the store: the doctor last-known pair, the latest connector receipt and the facts-absorb failure groups
 * (`ingest_log`), and the sync-admission setting's config value.
 *
 * Empty, no writer: every other `op_checkpoints` operation is written only through `executeRaw`, which a Rust brain
 * refuses, so no row of it exists there. Those members answer the empty value without a store call: what the same read
 * finds on a PGLite brain nothing has written to.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listFenceCandidateRecords: Member<'listFenceCandidateRecords'> = async () => [];
export const listDerivedOriginParks: Member<'listDerivedOriginParks'> = async () => [];
export const listPurgeParks: Member<'listPurgeParks'> = async () => [];
export const readSoakCounterRows: Member<'readSoakCounterRows'> = async () => [];
export const listUnfinishedManagedSyncCursors: Member<'listUnfinishedManagedSyncCursors'> = async () => [];
export const listManagedSyncPassStops: Member<'listManagedSyncPassStops'> = async () => [];
export const listManagedSyncBacklogHeaders: Member<'listManagedSyncBacklogHeaders'> = async () => [];
export const readManagedSyncPassRow: Member<'readManagedSyncPassRow'> = async () => null;
export const listLiveManagedSyncPassRows: Member<'listLiveManagedSyncPassRows'> = async () => [];
export const listCheckpointBlockedSources: Member<'listCheckpointBlockedSources'> = async () => [];
export const listOpenIdentityDowngrades: Member<'listOpenIdentityDowngrades'> = async () => [];
export const listHeldManagedAtomRows: Member<'listHeldManagedAtomRows'> = async () => [];

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
