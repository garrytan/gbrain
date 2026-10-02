/**
 * `import` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makeImportHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    // import.ts Core extraction deferred (import has parallel workers +
    // checkpointing; the typed-API split lands in W7 of the fix-wave).
    // W0 (Tier-1 #5): runImport no longer contains ANY process.exit — all
    // five preflight sites throw typed ImportAbortError, which this
    // handler's catch converts to a normal failJob. No worker-kill risk.
    const { runImport } = await import('../../../commands/import.ts');
    const importArgs: string[] = [];
    if (job.data.dir) importArgs.push(String(job.data.dir));
    if (job.data.noEmbed) importArgs.push('--no-embed');
    const result = await runImport(engine, importArgs, { signal: job.signal, sourceId: typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined });
    if (result.errors > 0) {
      throw new Error(`Import failed for ${result.errors} file(s); fix rejected documents and retry the job.`);
    }
    return { imported: true };
  };
}
