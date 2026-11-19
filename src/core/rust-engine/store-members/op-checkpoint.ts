/**
 * A resumable op's checkpoint (op-checkpoint.ts; SQL in engine-sql/op-checkpoint.ts and engine-sql/write-misc.ts),
 * served by gbrain-store `persistence::op_checkpoint`: the parent row's completed keys and the op's child paths. An op
 * stopped midway on this engine resumes with the keys it banked. What the store keeps and how it differs:
 * rust/docs/store/persistence.md, "Op checkpoints".
 */
import { storeCall, type StoreMember } from './common.ts';

/**
 * The op's completed keys: the child paths in path order, then the parent's array, each key once. `corruptParent` is
 * true when the parent's keys are not an array (the store never writes one; a SQL brain's CHECK refuses one).
 */
export const readOpCheckpointKeys: StoreMember<[op: string, fingerprint: string], { keys: string[]; corruptParent: boolean }> =
  (brain, op, fingerprint) => storeCall({ member: 'readOpCheckpointKeys' }, () => brain.readOpCheckpointKeys(op, fingerprint));

/** The parent's keys replaced with `keys`, stamped now; the child paths stay. */
export const writeOpCheckpointKeys: StoreMember<[op: string, fingerprint: string, keys: string[]], void> = async (brain, op, fingerprint, keys) => {
  await storeCall({ member: 'writeOpCheckpointKeys' }, () => brain.writeOpCheckpointKeys(op, fingerprint, keys));
};

/** The parent created with no keys or stamped now, then each path not yet banked added. */
export const appendOpCheckpointPaths: StoreMember<[op: string, fingerprint: string, paths: string[]], void> = async (brain, op, fingerprint, paths) => {
  await storeCall({ member: 'appendOpCheckpointPaths' }, () => brain.appendOpCheckpointPaths(op, fingerprint, paths));
};

/** The parent and its paths deleted; a missing parent is a no-op. */
export const deleteOpCheckpoint: StoreMember<[op: string, fingerprint: string], void> = async (brain, op, fingerprint) => {
  await storeCall({ member: 'deleteOpCheckpoint' }, () => brain.deleteOpCheckpoint(op, fingerprint));
};

/** The paths deleted, the parent kept. */
export const deleteOpCheckpointPaths: StoreMember<[op: string, fingerprint: string], void> = async (brain, op, fingerprint) => {
  await storeCall({ member: 'deleteOpCheckpointPaths' }, () => brain.deleteOpCheckpointPaths(op, fingerprint));
};
