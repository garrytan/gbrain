/**
 * The held fence results read (`listFenceHoldRows`, engine-sql/fence-holds.ts) on a Rust brain.
 *
 * A fence result is held only by a facts or takes fence publish (generations/publish.ts), which writes
 * `derived_generations` through `executeRaw`, and this engine refuses `executeRaw`. The store holds no
 * `derived_generations` rows, so no fence result is held. A family that lets the store publish fence generations must
 * read its held rows here.
 */
import type { FenceHoldRow } from '../../engine-sql/fence-holds.ts';
import type { StoreMember } from './common.ts';

/** No fence result is held on this engine (see the module comment). */
export const listFenceHoldRows: StoreMember<[sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string], FenceHoldRow[]> = async () => [];
