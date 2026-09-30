import { createEngine } from '../../core/engine-factory.ts';
import { isThinClient, loadConfig, toEngineConfig } from '../../core/config.ts';
import { runSharedSkillsMigration, type SharedMigrationReport } from '../../core/shared-skills/migration.ts';
import type { Migration } from './types.ts';
import type { OrchestratorOpts } from './types.ts';
import { exportDatabaseContent } from '../../core/shared-skills/migration-export.ts';
import { PgliteBusyError } from '../../core/pglite-lock.ts';

export const SHARED_CONTENT_MIGRATION_VERSION = '0.53.0';

export async function inspectSharedContentMigration(dryRun: boolean, exportOptions?: OrchestratorOpts['dbOnlyExport']): Promise<SharedMigrationReport | null> {
  const config = loadConfig();
  if (!config) return null;
  if (isThinClient(config)) return {
    version: 1, brain_id: null, dry_run: dryRun, status: 'action_required', sources: [], permission_changes: [],
    pending_actions: ['Run content migration on the host brain, then reconnect with an upgraded shared-skills adapter. No client-side host repository was created.'],
  };
  const engine = await createEngine(toEngineConfig(config));
  try {
    await engine.connect(toEngineConfig(config));
    const ctx = { engine, config, sourceId: exportOptions?.sourceId ?? 'default', remote: false, dryRun,
      logger: { info: console.error, warn: console.error, error: console.error } };
    const exported = exportOptions ? await exportDatabaseContent(ctx, { ...exportOptions, dryRun }) : undefined;
    const report = await runSharedSkillsMigration(ctx, { dryRun });
    if (exported) {
      report.content_export = exported;
      if (exported.status !== 'complete') report.status = exported.status === 'conflict' ? 'conflict' : 'action_required';
      report.pending_actions.push(...exported.pending_actions);
    }
    return report;
  } finally { await engine.disconnect(); }
}

export const sharedContentMigration: Migration = {
  version: SHARED_CONTENT_MIGRATION_VERSION,
  featurePitch: {
    headline: 'Knowledge and shared skills belong to the same source-scoped content repository.',
    description: 'Inventories and checkpoints existing packs without moving knowledge or changing grants. Existing true publishing remains prose-only, false stays disabled, and DB-only/export, old writers and client activation remain explicit pending actions.',
  },
  preview: options => inspectSharedContentMigration(true, options.dbOnlyExport),
  reconcile: true,
  orchestrator: async options => {
    try {
      const report = await inspectSharedContentMigration(options.dryRun, options.dbOnlyExport);
      if (!report) return { version: SHARED_CONTENT_MIGRATION_VERSION, status: 'complete', phases: [{ name: 'inventory', status: 'skipped', detail: 'No brain configured.' }] };
      const pending = report.status === 'action_required' || report.status === 'conflict';
      console.error(`[shared-skills] ${report.status}. ${report.sources.filter(source => source.status !== 'complete').length} source(s) need host action; no grants or bundle consent changed.`);
      for (const source of report.sources) for (const phase of source.stages) {
        if (phase.status === 'action_required' || phase.status === 'conflict') console.error(`[shared-skills] ${source.source_id}: ${phase.reason}`);
      }
      for (const action of report.pending_actions) console.error(`[shared-skills] ${action}`);
      return { version: SHARED_CONTENT_MIGRATION_VERSION, status: report.status === 'conflict' ? 'partial' : 'complete',
        phases: [{ name: 'content-checkpoints', status: 'complete', detail: pending ? 'Mechanical inventory is durable; publication and enrollment are NOT complete. Per-source actions remain in shared_skills.migration.v1.' : 'Source checkpoints verified.' }],
        pending_host_work: pending ? 1 : 0 };
    } catch (error) {
      if (error instanceof PgliteBusyError) throw error;
      return { version: SHARED_CONTENT_MIGRATION_VERSION, status: 'partial', phases: [{ name: 'content-checkpoints', status: 'failed',
        detail: error instanceof Error ? error.message : 'Content migration failed.' }] };
    }
  },
};
