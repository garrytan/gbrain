/**
 * The twin-merge moves on the Rust store (engine-sql/twin-merge-moves.ts): `movePageVersions` (the moved-pages fold's
 * version move, repair_versions.rs) is served. `moveTwinRelationships`, `moveTwinPageChildren` and `moveTwinFacts` refuse
 * by name and write nothing: their store side lands with batch 6c, and `mergeTwinInto` stops before them anyway
 * ("repair twin merge"). rust/docs/store/repair-bookkeeping.md.
 */
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const LATER = 'the twin merge store side is not served yet (repair twin merge); nothing was written';

export const movePageVersions: StoreMember<[fromPageId: number, toPageId: number], number[]> = async (brain, fromPageId, toPageId) =>
  ((await storeCall({ member: 'movePageVersions' }, () => brain.movePageVersions(fromPageId, toPageId))) as unknown[]).map(Number);

export const moveTwinRelationships: StoreMember<[ids: unknown], never> = async () => refuseMember('moveTwinRelationships', LATER);
export const moveTwinPageChildren: StoreMember<[move: unknown], never> = async () => refuseMember('moveTwinPageChildren', LATER);
export const moveTwinFacts: StoreMember<[sourceId: string, twinSlug: string, survivorSlug: string], never> = async () => refuseMember('moveTwinFacts', LATER);
