import { isThinClient, loadConfig } from '../../core/config.ts';
import { connectMigrationEngine } from './run-engine.ts';
import { runSharedSkillsMigration, type SharedMigrationReport } from '../../core/shared-skills/migration.ts';
import type { Migration } from './types.ts';
import type { OrchestratorOpts } from './types.ts';
import { exportDatabaseContent } from '../../core/shared-skills/migration-export.ts';
import { PgliteBusyError } from '../../core/pglite-lock.ts';
import { shellQuote } from '../../core/agent-output.ts';
import { MIGRATION_OPT_OUT_KEYS } from '../../core/migration-ledger.ts';
import { sharedSkillsHostWork } from '../../core/shared-skills/migration-host-work.ts';

export const SHARED_CONTENT_MIGRATION_VERSION = '0.53.0';
/** #6466: `gbrain config set shared_skills.migration.enabled false` declines this migration (brain-level, every machine). */
export const SHARED_CONTENT_MIGRATION_OPT_OUT_KEY = MIGRATION_OPT_OUT_KEYS[SHARED_CONTENT_MIGRATION_VERSION]!;

/** Read-only: prints every source's remaining stage, its reason and the command for it (`pending_actions`). */
export const SHARED_CONTENT_INSPECT_ARGV = ['gbrain', 'apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--dry-run', '--json'];

export async function inspectSharedContentMigration(dryRun: boolean, exportOptions?: OrchestratorOpts['dbOnlyExport'],
  acceptReviewedInventory?: OrchestratorOpts['acceptReviewedInventory']): Promise<SharedMigrationReport | null> {
  return (await inspectWithHostWork(dryRun, exportOptions, acceptReviewedInventory))?.report ?? null;
}

/**
 * The report plus the sources that owe host work by the ledger's rule (sharedSkillsHostWork, read from the report this
 * run stored), or null on a dry run, which stores nothing.
 */
async function inspectWithHostWork(dryRun: boolean, exportOptions?: OrchestratorOpts['dbOnlyExport'],
  acceptReviewedInventory?: OrchestratorOpts['acceptReviewedInventory']): Promise<{ report: SharedMigrationReport; owing: string[] | null } | null> {
  const config = loadConfig();
  if (!config) return null;
  if (isThinClient(config)) return { owing: null, report: {
    version: 1, brain_id: null, dry_run: dryRun, status: 'action_required', sources: [], permission_changes: [],
    pending_actions: ['Run content migration on the host brain, then reconnect with an upgraded shared-skills adapter. No client-side host repository was created.'],
  } };
  const { engine, close } = await connectMigrationEngine(config);
  try {
    const ctx = { engine, config, sourceId: exportOptions?.sourceId ?? 'default', remote: false, dryRun,
      logger: { info: console.error, warn: console.error, error: console.error } };
    const exported = exportOptions ? await exportDatabaseContent(ctx, { ...exportOptions, dryRun }) : undefined;
    const report = await runSharedSkillsMigration(ctx, { dryRun, acceptReviewedInventory });
    if (exported) {
      report.content_export = exported;
      if (exported.status !== 'complete') report.status = exported.status === 'conflict' ? 'conflict' : 'action_required';
      report.pending_actions.push(...exported.pending_actions);
    }
    return { report, owing: dryRun ? null : (await sharedSkillsHostWork(engine)).sources };
  } finally { await close(); }
}

export const sharedContentMigration: Migration = {
  version: SHARED_CONTENT_MIGRATION_VERSION,
  featurePitch: {
    headline: 'Knowledge and shared skills belong to the same source-scoped content repository.',
    description: 'Inventories and checkpoints existing packs without moving knowledge or changing grants. Existing true publishing remains prose-only, false stays disabled, and DB-only/export, old writers and client activation remain explicit pending actions.',
  },
  preview: options => inspectSharedContentMigration(true, options.dbOnlyExport, options.acceptReviewedInventory),
  reconcile: true,
  optOut: { key: SHARED_CONTENT_MIGRATION_OPT_OUT_KEY },
  sharesRunEngine: true,
  orchestrator: async options => {
    try {
      const inspected = await inspectWithHostWork(options.dryRun, options.dbOnlyExport, options.acceptReviewedInventory);
      if (!inspected) return { version: SHARED_CONTENT_MIGRATION_VERSION, status: 'complete', phases: [{ name: 'inventory', status: 'skipped', detail: 'No brain configured.' }] };
      const { report, owing } = inspected;
      const pending = report.status === 'action_required' || report.status === 'conflict';
      const open = report.sources.filter(source => source.status !== 'complete');
      // The ledger's rule (#6796): an unverified client enrollment (`members`) or a projection the source's own policy
      // keeps out is information, not host work, so it never counts as a source that needs host action.
      const owed = owing === null ? open : open.filter(source => source.status === 'conflict' || owing.includes(source.source_id));
      const inspect = ` Inspect each source's next step: ${shellQuote(SHARED_CONTENT_INSPECT_ARGV)}`;
      console.error(pending && owed.length === 0 && report.pending_actions.length === 0
        ? `[shared-skills] No source needs host action; no grants or bundle consent changed. Not verified here: client enrollment and native activation, and sources whose own policy keeps shared skills out.${inspect}`
        : `[shared-skills] ${report.status}. ${owed.length} source(s) need host action; no grants or bundle consent changed.${pending ? inspect : ''}`);
      for (const source of open) for (const phase of source.stages) {
        if (phase.status === 'action_required' || phase.status === 'conflict') {
          console.error(`[shared-skills] ${source.source_id}${owed.includes(source) ? '' : ' (no host action owed)'}: ${phase.reason}`);
        }
      }
      for (const action of report.pending_actions) console.error(`[shared-skills] ${action}`);
      return { version: SHARED_CONTENT_MIGRATION_VERSION, status: report.status === 'conflict' ? 'partial' : 'complete',
        phases: [{ name: 'content-checkpoints', status: 'complete', ...(pending
          ? { detail: 'Mechanical inventory is durable; publication and enrollment are NOT complete. Per-source actions remain in shared_skills.migration.v1.', argv: SHARED_CONTENT_INSPECT_ARGV }
          : { detail: 'Source checkpoints verified.' }) }],
        pending_host_work: pending ? 1 : 0 };
    } catch (error) {
      if (error instanceof PgliteBusyError) throw error;
      return { version: SHARED_CONTENT_MIGRATION_VERSION, status: 'partial', phases: [{ name: 'content-checkpoints', status: 'failed',
        detail: error instanceof Error ? error.message : 'Content migration failed.' }] };
    }
  },
};
