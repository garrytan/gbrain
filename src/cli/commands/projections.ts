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
  const { OperationError } = await import('../../core/ops/contract.ts');
  const { reportPersistenceCliError } = await import('../../commands/persistence-delegate.ts');
  const refuse = async (error: InstanceType<typeof OperationError>) => {
    await reportPersistenceCliError(error, json);
    setCliExitVerdict(2);
  };
  const limitAt = args.indexOf('--limit');
  const limitValue = limitAt === -1 ? undefined : args[limitAt + 1];
  const known = new Set(['drain', '--json', '--limit', ...(limitValue === undefined ? [] : [limitValue])]);
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
    if (holder.held) { await refuse(projections.projectionOwnerResidentError(holder, config.database_path, brainId)); return; }
  }

  const { createProgress } = await import('../../core/progress.ts');
  const { cliOptsToProgressOptions } = await import('../../core/cli-options.ts');
  const engine = await ctx.connectEngine();
  try {
    const result = await projections.drainProjections(engine, { limit, progress: createProgress(cliOptsToProgressOptions(getCliOptions())) });
    if (json) {
      const { limited: _limited, ...payload } = result;
      await writeStdoutFinal(JSON.stringify(payload) + '\n');
    } else {
      for (const failure of result.failed) {
        console.error(`failed: ${failure.source_id}/${failure.slug}: ${failure.reason}\n  next: ${projections.projectionFailureNextAction(failure)}`);
      }
      const summary = `projections drain: ${result.rebuilt} rebuilt, ${result.superseded} superseded, ${result.failed.length} failed, ${result.remaining} remaining.`;
      const tail = result.remaining === 0 ? ' The projection backlog is empty.'
        : result.limited ? ` Stopped at --limit ${limit}; run \`gbrain projections drain\` again to continue.`
          : result.failed.length ? ' Failed pages stay queued; fix them as shown above, then run `gbrain projections drain` again.'
            : ' Rows queued during this run are left for the next run or the resident owner.';
      await writeStdoutFinal(summary + tail + '\n');
    }
    if (result.failed.length) setCliExitVerdict(1);
  } finally {
    await finishCliTeardown({ engine });
  }
}
