/**
 * `gbrain projections drain`: pre-connect dispatch that opens its own engine,
 * so the PGLite resident-owner refusal (#5401, exit 2) happens before any
 * engine opens. The record lives in src/cli/command-table.ts.
 */
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const projections = await import('../../commands/projections.ts');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(projections.PROJECTIONS_HELP);
    return;
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const { OperationError } = await import('../../core/ops/contract.ts');
  const { reportPersistenceCliError } = await import('../../commands/persistence-delegate.ts');
  const refuse = async (error: InstanceType<typeof OperationError>) => {
    await reportPersistenceCliError(error, json);
    setCliExitVerdict(2);
  };
  const limitAt = args.indexOf('--limit');
  const limitValue = limitAt === -1 ? undefined : args[limitAt + 1];
  const known = new Set(['drain', '--json', '--dry-run', '--limit', ...(limitValue === undefined ? [] : [limitValue])]);
  const unknown = args.find(arg => !known.has(arg));
  if (args[0] !== 'drain' || unknown !== undefined) {
    await refuse(new OperationError('invalid_params', `Unknown projections argument '${unknown ?? args[0]}'.`,
      'Run `gbrain projections drain [--limit <n>] [--json]`.', projections.PROJECTION_DRAIN_DOCS));
    return;
  }
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (limitAt !== -1 && (!Number.isSafeInteger(limit) || limit! < 1)) {
    await refuse(new OperationError('invalid_params', `--limit needs a positive whole number of pages, not '${limitValue ?? ''}'.`,
      'Run `gbrain projections drain --limit 1000`, or omit --limit to drain everything queued.', projections.PROJECTION_DRAIN_DOCS));
    return;
  }

  const { loadConfig } = await import('../../core/config.ts');
  const { getCliOptions } = await import('../../core/cli-options.ts');
  const { resolveBrainId } = await import('../../core/brain-resolver.ts');
  const { loadMounts } = await import('../../core/brain-registry.ts');
  const { persistenceConfigForBrain } = await import('../../core/persistence/local-client.ts');
  const { inspectLockHolder } = await import('../../core/pglite-lock.ts');
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(loadConfig(), brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine === 'pglite' && config.database_path && !config.database_url) {
    const holder = inspectLockHolder(config.database_path);
    if (holder.held) {
      // #6803: the preview counts come from the resident's own projection_status (null: an older resident, or none listening).
      const { persistenceSocketPathForConfig, requestPersistenceProjectionStatus } = await import('../../core/persistence/ipc.ts');
      const socketPath = persistenceSocketPathForConfig(config);
      const status = socketPath ? await requestPersistenceProjectionStatus(socketPath).catch(() => null) : null;
      await refuse(projections.projectionOwnerResidentError(holder, config.database_path, brainId, status));
      return;
    }
  }

  const { createProgress } = await import('../../core/progress.ts');
  const { cliOptsToProgressOptions } = await import('../../core/cli-options.ts');
  const engine = await ctx.connectEngine();
  if (dryRun) {
    // #6803: the preview reads the queue and rebuilds nothing.
    try {
      const preview = await projections.previewProjectionDrain(engine, limit ?? 50);
      await writeStdoutFinal((json ? JSON.stringify(preview) : projections.formatDrainPreview(preview)) + '\n');
    } finally {
      await finishCliTeardown({ engine });
    }
    return;
  }
  try {
    const result = await projections.drainProjections(engine, { limit, media: true, progress: createProgress(cliOptsToProgressOptions(getCliOptions())) });
    if (json) {
      await writeStdoutFinal(JSON.stringify(result) + '\n');
    } else {
      for (const failure of result.failed) {
        console.error(`failed: ${failure.source_id}/${failure.slug}: ${failure.reason}\n  next: ${projections.projectionFailureNextAction(failure)}`);
      }
      await writeStdoutFinal(projections.formatDrainResult(result, limit) + '\n');
    }
    if (result.failed.length) setCliExitVerdict(1);
  } finally {
    await finishCliTeardown({ engine });
  }
}
