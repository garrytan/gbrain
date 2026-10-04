/**
 * `gbrain sync`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 *
 * A refusal that carries an agent-contract `fix` (e.g. `sync_not_applicable`,
 * `writer_coordinator_required`) renders through `renderCliError` so the
 * operator sees the code, the exact next command and why (`--json`: the v1
 * envelope on stdout).
 */
import type { BrainEngine } from '../../core/engine.ts';
import { OperationError, opError } from '../../core/ops/contract.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { writeCliError } from '../cli-error.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runSync, SyncLockBusyError } = await import('../../commands/sync.ts');
  try {
    await runSync(engine, args);
  } catch (err) {
    // D1/D2: a busy sync lock is a retryable sync_in_progress refusal (its
    // message names the holder and the --break-lock recovery), not an
    // unclassified internal error.
    if (err instanceof SyncLockBusyError) {
      throw opError('sync_in_progress', err.message,
        `Wait for the running sync to finish and retry. If its holder is dead, run \`gbrain sync --break-lock\` (with the same --source).`,
        { reason: 'lock_busy', detail: err.lockKey });
    }
    if (!(err instanceof OperationError) || !err.fix) throw err;
    setCliExitVerdict(writeCliError(err, 'sync', { json: args.includes('--json') }));
  }
}
