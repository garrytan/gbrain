import type { BrainEngine } from '../core/engine.ts';
import { reconcileStructure } from '../core/structure-reconcile.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export async function runReconcileStructureCli(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain reconcile-structure [options]

Build a deterministic, provenance-tagged source-path containment graph.

Options:
  --source <id>  Reconcile one source (default: all live sources)
  --dry-run      Preview counts without writing pages or edges
  --json         Emit structured JSON
  --help, -h     Show this help`);
    return;
  }
  const sourceIndex = args.indexOf('--source');
  const sourceId = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
  if (sourceIndex >= 0 && !sourceId) throw new Error('--source requires an id');
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('reconcile_structure.scan');
  const stop = startHeartbeat(progress, 'deriving structural hierarchy');
  try {
    const result = await reconcileStructure(engine, {
      sourceId,
      dryRun: args.includes('--dry-run'),
    });
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `${result.dry_run ? 'Would reconcile' : 'Reconciled'} ${result.sources.length} source(s): ` +
        `${result.structural_pages_planned} structural pages, ${result.edges_planned} derived edges, ` +
        `max degree ${result.max_degree}.`,
      );
    }
  } finally {
    stop();
    progress.finish();
  }
}
