/**
 * Group 5 facts members, the fact purge receipt's derivation probe (src/core/engine-sql/facts-purge.ts), served from the
 * facts store (rust/crates/gbrain-store/src/facts/purge_probe.rs).
 *
 * `setPurgeProbeTimeout` bounds the statements of the caller's transaction in Postgres; a store read is one call with no
 * statement timer, so it has nothing to set. It refuses what `statement_timeout` refuses (a negative or non-finite value)
 * and otherwise resolves with nothing. `probePurgeDerivations` passes the cursor as its three parts.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const setPurgeProbeTimeout: Member<'setPurgeProbeTimeout'> = async (_brain, ms) => {
  if (!Number.isFinite(ms) || ms < 0) refuseMember('setPurgeProbeTimeout', 'a statement timeout that is negative or not finite');
};

export const probePurgeDerivations: Member<'probePurgeDerivations'> = (brain, sourceId, needles, pageIds, patterns, cursor, rows) => {
  if (!pageIds.every(Number.isInteger) || (cursor !== null && !Number.isInteger(cursor[0])) || !Number.isInteger(rows)) {
    refuseMember('probePurgeDerivations', 'a page id or batch size that is not an integer');
  }
  return storeCall({ member: 'probePurgeDerivations' }, () => brain.probePurgeDerivations({
    sourceId, needles, pageIds, patterns, rows,
    cursorPage: cursor?.[0] ?? null, cursorPipeline: cursor?.[1] ?? null, cursorOccurrence: cursor?.[2] ?? null,
  }));
};
