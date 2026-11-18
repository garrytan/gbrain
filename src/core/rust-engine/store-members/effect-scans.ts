/**
 * The effect scans the Rust store answers (engine-sql/persistence-effect-scans.ts): the reads the effect worker's pass
 * runs before it claims effects (listGatedMirrorRequests).
 *
 * Each scan joins persistence effects to the worktrees a host owns. The store keeps no worktree and records no effect,
 * so each one answers no row; it still refuses the arguments the Postgres casts refuse (a host id that is not a uuid).
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Effect scans").
 */
import type { GatedMirrorRequest } from '../../engine-sql/persistence-effect-scans.ts';
import { storeCall, type StoreMember } from './common.ts';

/** No request has a parked withdrawal mirror here, so none is requeued; the codes change nothing. */
export const listGatedMirrorRequests: StoreMember<[hostId: string, gateCode: string, allowedCodes: readonly string[]], GatedMirrorRequest[]> =
  (brain, hostId) => storeCall({ member: 'listGatedMirrorRequests' }, () => brain.listGatedMirrorRequests(hostId));
