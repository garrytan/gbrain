/** Applied-capture bookkeeping on the Rust store. Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS. */
import type { StoreMember } from './common.ts';

/**
 * `purgeStaleAppliedCaptures`: the store keeps no applied captures (every writer, ingestion/applied-captures.ts, goes
 * through `executeRaw`, which this engine refuses), so none is stale.
 */
export const purgeStaleAppliedCaptures: StoreMember<[ttlDays: number], number> = async () => 0;
