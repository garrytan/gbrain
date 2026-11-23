/**
 * Doctor terminal reads (src/core/engine-sql/doctor-terminal.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_terminal.rs, rust/docs/store/cli-reads-doctor-terminal.md).
 *
 * Served from the store: the grouped aggregate and the drill-down batch, which read the request journal. The classification
 * rules the SQL splices from TypeScript constants (`terminalRules`) go in with each call, so the store tests the same
 * strings the PGLite and Postgres statements do.
 *
 * Empty, no writer: the open-pass blocker reads need `persistence_source_bindings` rows and the managed-sync pass row,
 * which only `executeRaw` writes and a Rust brain refuses. They answer `[]` in TypeScript without a store call, which is
 * what the same read finds on a PGLite brain nothing has written to.
 */
import type { BrainEngine } from '../../engine.ts';
import { PAGE_REMOVAL_OPERATIONS, CONNECTOR_RETRY_LINEAGE_MAX_DEPTH, CONNECTOR_WRITE_KIND_LIST, LEGACY_PUBLICATION_PREFIX, TERMINAL_FIXED_IN } from '../../persistence/terminal-constants.ts';
import { EARLIER_PAGE_REFUSAL_MESSAGE, LEGACY_KNOCK_ON_CANCEL_MESSAGES, LEGACY_KNOCK_ON_CANCEL_PATTERNS, SYNC_KNOCK_ON_ORIGIN } from '../../persistence/sync-knock-on.ts';
import { SYNC_PASS_SUPERSEDED } from '../../persistence/sync-checkpoint-replaced.ts';
import { GRANDFATHER_RETIRED } from '../../persistence/publication-failure.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The strings and numbers the terminal SQL splices from the TypeScript constants, for the store's port of its classification columns. */
function terminalRules() {
  return {
    syncKnockOnOrigin: SYNC_KNOCK_ON_ORIGIN, legacyCancelMessages: [...LEGACY_KNOCK_ON_CANCEL_MESSAGES], legacyCancelPatterns: [...LEGACY_KNOCK_ON_CANCEL_PATTERNS],
    earlierPageRefusal: EARLIER_PAGE_REFUSAL_MESSAGE, syncPassSuperseded: SYNC_PASS_SUPERSEDED, legacyPublicationPrefix: LEGACY_PUBLICATION_PREFIX,
    grandfatherRetired: GRANDFATHER_RETIRED, fixedKnockOn: TERMINAL_FIXED_IN.knock_on, fixedFenceUnrenderable: TERMINAL_FIXED_IN.fence_unrenderable,
    connectorKinds: [...CONNECTOR_WRITE_KIND_LIST], pageRemovalOperations: [...PAGE_REMOVAL_OPERATIONS], connectorLineageMaxDepth: CONNECTOR_RETRY_LINEAGE_MAX_DEPTH,
  };
}

export const listOpenPassCheckpointBlockers: Member<'listOpenPassCheckpointBlockers'> = async () => [];
export const listWorktreeBlockerRequests: Member<'listWorktreeBlockerRequests'> = async () => [];

export const readTerminalFailureGroups: Member<'readTerminalFailureGroups'> = (brain, query) =>
  storeCall({ member: 'readTerminalFailureGroups' }, () => brain.readTerminalFailureGroups({ ...query, sourceIds: query.sourceIds ? [...query.sourceIds] : null, rules: terminalRules() }));

export const listTerminalFailureBatch: Member<'listTerminalFailureBatch'> = (brain, query) =>
  storeCall({ member: 'listTerminalFailureBatch' }, () => brain.listTerminalFailureBatch({ ...query, rules: terminalRules() }));
