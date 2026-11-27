/**
 * `readCommitLog`, `lastCommitPosition` and `listEntityFactsInCommitOrder` on the Rust engine (engine-members/commit-log.ts;
 * the store side is the addon's `Brain#readCommitLog`, `Brain#lastCommitPosition` and `Brain#listEntityFactsInCommitOrder`,
 * rust/crates/gbrain-napi/src/families/commit_log.rs).
 *
 * All three refuse with `engine_capability_missing` (capability `commit_log`) unless the engine reports `commit_log`, which it
 * does only while its store keeps a commit log (multi-user mode with the log on). On the engine a transaction callback
 * received, `lastCommitPosition` answers the position that transaction committed at, kept on its scope, so it still
 * answers after the transaction ended.
 */
import type { CommitLogPage, CommitPosition, EntityFactCommitPosition } from '../../engine-members/commit-log.ts';
import type { EngineCapabilities } from '../../engine-capabilities.ts';
import type { RustTransactionScope } from '../../rust-engine.ts';
import type { RustStore } from '../store.ts';
import { capabilityMissing } from '../errors.ts';
import { storeCall } from './common.ts';

interface CommitLogEngine {
  readonly capabilities: EngineCapabilities;
  readonly _txScope?: RustTransactionScope;
  storeFor(member: string, args: unknown[]): Promise<RustStore>;
  openStoreIfOpen(member: string): RustStore | null;
}

type CommitLogMember = 'readCommitLog' | 'lastCommitPosition' | 'listEntityFactsInCommitOrder';

async function storeOf(engine: CommitLogEngine, member: CommitLogMember, args: unknown[]): Promise<RustStore> {
  if (!engine.capabilities.has('commit_log')) throw capabilityMissing('commit_log', member);
  return engine.openStoreIfOpen(member) ?? await engine.storeFor(member, args);
}

export async function readCommitLog(engine: CommitLogEngine, after: CommitPosition | null, limit: number): Promise<CommitLogPage> {
  const store = await storeOf(engine, 'readCommitLog', [after, limit]);
  return await storeCall({ member: 'readCommitLog' }, () => store.brain.readCommitLog(after, limit)) as CommitLogPage;
}

export async function lastCommitPosition(engine: CommitLogEngine): Promise<CommitPosition | null> {
  if (!engine.capabilities.has('commit_log')) throw capabilityMissing('commit_log', 'lastCommitPosition');
  // A transaction's own engine: the position it committed at (none while open or after a rollback).
  if (engine._txScope) return engine._txScope.committedAt ?? null;
  const store = await storeOf(engine, 'lastCommitPosition', []);
  return await storeCall({ member: 'lastCommitPosition' }, () => store.brain.lastCommitPosition()) as CommitPosition | null;
}

/**
 * The facts of one entity in commit order (conformance C11): the per-entity sequence a multi-user store stamps on each
 * new fact inside the transaction that stores it (rust/crates/gbrain-store/src/facts/entity_order.rs).
 */
function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_argument' });
}

export async function listEntityFactsInCommitOrder(
  engine: CommitLogEngine, sourceId: string, entitySlug: string, opts: { afterSequence?: number; limit: number },
): Promise<EntityFactCommitPosition[]> {
  const member = 'listEntityFactsInCommitOrder';
  const { afterSequence, limit } = opts;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw invalidArgument(`${member}: limit must be an integer from 1 to 10,000, not ${String(limit)}`);
  }
  if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
    throw invalidArgument(`${member}: afterSequence must be a non-negative integer, not ${String(afterSequence)}`);
  }
  const store = await storeOf(engine, member, [sourceId, entitySlug, opts]);
  return await storeCall({ member }, () =>
    store.brain.listEntityFactsInCommitOrder(sourceId, entitySlug, afterSequence ?? null, limit)) as EntityFactCommitPosition[];
}
