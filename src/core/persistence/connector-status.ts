/**
 * `gbrain sources status` view of each managed connector source's state row:
 * upgrade recovery, account pin continuity, pending receipts and the last
 * run's counts. Never includes the pinned account or installation id.
 */
import type { BrainEngine } from '../engine.ts';
import { readManagedConnectorState, type ConnectorRunCounts, type UpgradeRecovery } from './connector-state.ts';

export interface ConnectorSourceStatus {
  upgrade_recovery: UpgradeRecovery;
  resumed_from: string | null;
  account_pinned: boolean;
  continuity_unverified: boolean;
  pending: number;
  last_run: ConnectorRunCounts | null;
}

export async function readConnectorSourceStatuses(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Map<string, ConnectorSourceStatus>> {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    "SELECT id,incarnation::text FROM sources WHERE NOT archived AND config->>'kind' IN ('google','github')");
  const statuses = new Map<string, ConnectorSourceStatus>();
  for (const source of sources) {
    const state = await readManagedConnectorState(engine, source.id, source.incarnation);
    statuses.set(source.id, { upgrade_recovery: state.upgrade_recovery, resumed_from: state.resumed_from, account_pinned: state.account !== null,
      continuity_unverified: state.continuity_unverified, pending: state.pending.length, last_run: state.last_run });
  }
  return statuses;
}

export function connectorStatusLines(sourceId: string, status: ConnectorSourceStatus): string[] {
  const lines: string[] = [];
  const run = status.last_run;
  lines.push(`  ${sourceId}: connector ${run ? `last run ${run.finished_at.slice(0, 19).replace('T', ' ')}: ${run.page_admissions} page admission(s), `
    + `${run.skipped_unchanged} skipped unchanged, ${run.pending} pending, ${run.checkpoint_admissions} checkpoint admission(s)`
    + `${run.stopped_on_wait_budget ? ', stopped on wait budget' : ''}${run.dropped_upstream ? `, ${run.dropped_upstream} dropped (deleted upstream)` : ''}` : 'has not run since the upgrade'}`);
  if (status.upgrade_recovery === 'resumed') {
    lines.push(`    resumed from pre-upgrade checkpoint of ${status.resumed_from}; content selection since then is unverified; to re-walk: gbrain sync --source ${sourceId} --reset-checkpoint`);
  } else if (status.upgrade_recovery === 'rewalking_once') {
    lines.push('    re-walking its window once after the upgrade (an expected admission spike, not #5470 churn)');
  }
  if (status.continuity_unverified) lines.push('    account pinned on its first post-upgrade run; continuity before the upgrade is unverified');
  return lines;
}
