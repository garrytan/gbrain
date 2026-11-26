/**
 * `readCommitLog` and `lastCommitPosition` on the Rust engine (engine-members/commit-log.ts; the store side is the addon's
 * `Brain#readCommitLog` and `Brain#lastCommitPosition`, rust/crates/gbrain-napi/src/families/commit_log.rs).
 *
 * Both refuse with `engine_capability_missing` (capability `commit_log`) unless the engine reports `commit_log`, which it
 * does only while its store keeps a commit log (multi-user mode with the log on). On the engine a transaction callback
 * received, `lastCommitPosition` answers the position that transaction committed at, kept on its scope, so it still
 * answers after the transaction ended.
 */
import type { CommitLogPage, CommitPosition } from '../../engine-members/commit-log.ts';
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

async function storeOf(engine: CommitLogEngine, member: 'readCommitLog' | 'lastCommitPosition', args: unknown[]): Promise<RustStore> {
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
