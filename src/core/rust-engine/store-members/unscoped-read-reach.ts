/**
 * The `sources_not_readable` probe (src/core/engine-sql/unscoped-read-reach.ts), served from the store
 * (rust/crates/gbrain-store/src/cli_reads/remote_reads.rs). Under the remote read floor the store judges each page by
 * the floor rendered for the current caller (reflexPolicy 'floor'), as the SQL adds `remoteReadFloorSql('p')`; a
 * caller the store page policy cannot represent refuses with engine_capability_missing, never a guess. See
 * rust/docs/store/cli-reads-ops.md.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type { UnscopedReachQuery } from '../../engine-sql/unscoped-read-reach.ts';
import { reflexPolicy } from './private-provenance.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readUnscopedReadRefusal: StoreMember<[query: UnscopedReachQuery], boolean> = async (brain, q) => {
  const policy = q.floor ? reflexPolicy('readUnscopedReadRefusal', 'floor') : null;
  return storeCall({ member: 'readUnscopedReadRefusal' }, () =>
    brain.readUnscopedReadRefusal({ readable: [...q.readable], withFacts: q.withFacts }, policy)) as Promise<boolean>;
};
