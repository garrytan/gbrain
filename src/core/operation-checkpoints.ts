/**
 * Supported consumer surface for gbrain's DB-backed operation checkpoints.
 *
 * Keep this barrel deliberately smaller than `op-checkpoint.ts`: downstream
 * orchestrators need generic resume primitives, not gbrain's operation-specific
 * fingerprint helpers, maintenance purge, or SIGTERM-only flush path.
 */
export {
  appendCompleted,
  clearOpCheckpoint,
  fingerprint,
  loadOpCheckpoint,
  recordCompleted,
  resumeFilter,
} from './op-checkpoint.ts';

export type { OpCheckpointKey } from './op-checkpoint.ts';
