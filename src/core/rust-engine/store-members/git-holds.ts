/**
 * The Git sync hold retry member (BrainEngine requestGitHoldRetry, the statement of engine-sql/git-holds.ts). The store
 * applies it as one write over its op checkpoint records
 * (rust/crates/gbrain-store/src/persistence/git_holds.rs). readRepairBusyRows (engine-sql/repair-busy.ts) reads the
 * requests, cursors and holds a repair's busy set names (rust/crates/gbrain-store/src/repair_plan_scans.rs).
 */
import type { RepairBusyRows } from '../../engine-sql/repair-busy.ts';
import { storeCall, type StoreMember } from './common.ts';

export const requestGitHoldRetry: StoreMember<[sourceId: string, incarnation: string, paths: readonly string[], requestedAt: string], void> =
  async (brain, sourceId, incarnation, paths, requestedAt) => {
    await storeCall({ member: 'requestGitHoldRetry', sourceId }, () => brain.requestGitHoldRetry(sourceId, incarnation, [...paths], requestedAt));
  };

export const readRepairBusyRows: StoreMember<[sourceId: string, incarnation: string], RepairBusyRows> = async (brain, sourceId, incarnation) =>
  await storeCall({ member: 'readRepairBusyRows', sourceId }, () => brain.readRepairBusyRows(sourceId, incarnation)) as RepairBusyRows;
