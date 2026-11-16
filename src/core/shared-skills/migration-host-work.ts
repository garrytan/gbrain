/**
 * #6796: whether the v0.53.0 shared-skills migration still has host work a
 * person must do, read from its stored report (`shared_skills.migration.v1`).
 * The orchestrator records every run `apply_migrations_pending` because member
 * enrollment and native activation are never verified (a fresh brain reports
 * "No installation has enrolled"), so the `members` stage alone is not host
 * work, and neither is a projection the source's own policy blocks (opted out
 * with `sources shared-skills <id> off`, or a remote clone that needs an
 * explicit pack). Read-only.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OwedConflict } from '../migration-ledger.ts';
import type { SharedMigrationReport } from './migration.ts';
import { sharedSkillSourcePolicyOrPreserve } from './setup-source-policy.ts';

export const SHARED_SKILLS_HOST_WORK_VERSION = '0.53.0';

/** Sources whose stored migration stages still need host work, and the count of brain-level pending actions. */
export async function sharedSkillsHostWork(engine: BrainEngine): Promise<{ sources: string[]; pending_actions: number }> {
  let report: SharedMigrationReport;
  try {
    report = JSON.parse((await engine.getConfig('shared_skills.migration.v1')) ?? 'null');
  } catch {
    return { sources: [], pending_actions: 0 };
  }
  const sources: string[] = [];
  for (const row of report?.sources ?? []) {
    const open = row.stages.filter(s => s.stage !== 'members' && (s.status === 'action_required' || s.status === 'conflict'));
    if (open.length === 0) continue;
    const policyBlocked = open.every(s => s.stage === 'projection' && s.status === 'action_required')
      && (await sharedSkillSourcePolicyOrPreserve(engine, row.source_id)).mode !== 'content';
    if (!policyBlocked) sources.push(row.source_id);
  }
  return { sources, pending_actions: report?.pending_actions?.length ?? 0 };
}

/** The applied migrations whose recorded host work is still open (today only v0.53.0). */
export async function hostWorkMigrations(engine: BrainEngine): Promise<Set<string>> {
  const work = await sharedSkillsHostWork(engine);
  return new Set(work.sources.length || work.pending_actions ? [SHARED_SKILLS_HOST_WORK_VERSION] : []);
}

/** Every source stage a migration report marks `conflict`, with its code and reason. */
export function owedConflicts(report: Pick<SharedMigrationReport, 'sources'> | null | undefined): OwedConflict[] {
  return (report?.sources ?? []).flatMap(row => row.stages.filter(stage => stage.status === 'conflict')
    .map(stage => ({ source_id: row.source_id, code: stage.code ?? 'local_conflict', reason: stage.reason ?? '' })));
}

/**
 * The sources in conflict now, from the migration's read-only preview on this brain (the per-source inspect, run in
 * process: it inventories each registered pack and writes nothing). Null when the preview cannot run here.
 */
export async function readOwedConflicts(engine: BrainEngine, config: GBrainConfig): Promise<OwedConflict[] | null> {
  try {
    const { runSharedSkillsMigration } = await import('./migration.ts');
    return owedConflicts(await runSharedSkillsMigration({ engine, config, sourceId: 'default', remote: false, dryRun: true,
      logger: { info() {}, warn() {}, error() {} } }, { dryRun: true }));
  } catch { return null; }
}
