/**
 * The operation checkpoint statements (BrainEngine readOpCheckpoint, writeOpCheckpointKeys, appendOpCheckpointPaths,
 * deleteOpCheckpoint; engine-sql/op-checkpoint.ts on the SQL engines). The store keeps the parent op_checkpoints rows
 * the housekeeping turn keeps, and one key per banked path. It returns the paths in byte order, then the legacy
 * completed_keys. Doc: rust/docs/store/persistence.md, "Operation checkpoints".
 */
import type { OpCheckpointRead } from '../../engine-sql/op-checkpoint.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readOpCheckpoint: StoreMember<[op: string, fingerprint: string], OpCheckpointRead> = (brain, op, fingerprint) =>
  storeCall({ member: 'readOpCheckpoint' }, () => brain.readOpCheckpoint(op, fingerprint));

export const writeOpCheckpointKeys: StoreMember<[op: string, fingerprint: string, keys: readonly string[]], void> = async (brain, op, fingerprint, keys) => {
  await storeCall({ member: 'writeOpCheckpointKeys' }, () => brain.writeOpCheckpointKeys(op, fingerprint, [...keys]));
};

export const appendOpCheckpointPaths: StoreMember<[op: string, fingerprint: string, paths: readonly string[]], void> = async (brain, op, fingerprint, paths) => {
  await storeCall({ member: 'appendOpCheckpointPaths' }, () => brain.appendOpCheckpointPaths(op, fingerprint, [...paths]));
};

export const deleteOpCheckpoint: StoreMember<[op: string, fingerprint: string], void> = async (brain, op, fingerprint) => {
  await storeCall({ member: 'deleteOpCheckpoint' }, () => brain.deleteOpCheckpoint(op, fingerprint));
};
