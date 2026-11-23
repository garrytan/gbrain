/**
 * Doctor sync reads (src/core/engine-sql/doctor-sync.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_sync.rs, rust/docs/store/cli-reads-doctor-sync.md).
 *
 * Empty, no writer: managed-sync cursors, failure rows and pass rows are written only through `executeRaw`, which a
 * Rust brain refuses, so no row of them exists there. Those members answer the empty value without a store call: what
 * the same read finds on a PGLite brain nothing has written to.
 */
import type { BrainEngine } from '../../engine.ts';
import type { StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listManagedSyncCursorFailureRows: Member<'listManagedSyncCursorFailureRows'> = async () => [];
export const listManagedSyncOrphanRowsets: Member<'listManagedSyncOrphanRowsets'> = async () => ({
  cursors: [], failures: [], passes: [], retiredCursors: [], retiredFailures: [],
});
export const listDurableManagedSyncFailureKeys: Member<'listDurableManagedSyncFailureKeys'> = async () => [];
