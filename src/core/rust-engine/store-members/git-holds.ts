/**
 * The Git sync hold members (BrainEngine swapGitHold, readGitHoldRecord and requestGitHoldRetry, the statements of
 * engine-sql/git-holds.ts). The store applies each as one write over its op checkpoint records
 * (rust/crates/gbrain-store/src/persistence/git_holds.rs). readRepairBusyRows (engine-sql/repair-busy.ts) reads the
 * requests, cursors and holds a repair's busy set names (rust/crates/gbrain-store/src/repair_plan_scans.rs).
 */
import type { SourceHoldRecordRow } from '../../engine-sql/repair-plan-scans.ts';
import { checkGitHoldSwap, type GitHoldSwap } from '../../engine-sql/git-holds.ts';
import type { RepairBusyRows } from '../../engine-sql/repair-busy.ts';
import { storeCall, type StoreMember } from './common.ts';

export const swapGitHold: StoreMember<[input: GitHoldSwap], boolean> = async (brain, input) => {
  checkGitHoldSwap(input);
  return await storeCall({ member: 'swapGitHold', sourceId: input.sourceId }, () =>
    brain.swapGitHold(input.sourceId, input.incarnation, input.path, input.prior, input.next, input.summary)) as boolean;
};

export const readGitHoldRecord: StoreMember<[sourceId: string, incarnation: string, path: string], SourceHoldRecordRow | null> = async (brain, sourceId, incarnation, path) =>
  await storeCall({ member: 'readGitHoldRecord', sourceId }, () => brain.readGitHoldRecord(sourceId, incarnation, path)) as SourceHoldRecordRow | null;

export const requestGitHoldRetry: StoreMember<[sourceId: string, incarnation: string, paths: readonly string[], requestedAt: string], void> =
  async (brain, sourceId, incarnation, paths, requestedAt) => {
    await storeCall({ member: 'requestGitHoldRetry', sourceId }, () => brain.requestGitHoldRetry(sourceId, incarnation, [...paths], requestedAt));
  };

export const readRepairBusyRows: StoreMember<[sourceId: string, incarnation: string], RepairBusyRows> = async (brain, sourceId, incarnation) =>
  await storeCall({ member: 'readRepairBusyRows', sourceId }, () => brain.readRepairBusyRows(sourceId, incarnation)) as RepairBusyRows;
