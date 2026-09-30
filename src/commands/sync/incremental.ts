/**
 * Incremental (git-diff) sync: `performSyncInner` (refactor wave 1, W4 sync).
 * The phases run in order — preflight, the un-syncable sweep, deletes,
 * renames, imports, finalize — sharing one `SyncRun`; each drain returns a
 * partial result when the run aborts, which ends the sync.
 */
import { cliOptsToProgressOptions, getCliOptions } from '../../core/cli-options.ts';
import { slog } from '../../core/console-prefix.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { recordCompleted } from '../../core/op-checkpoint.ts';
import { createProgress } from '../../core/progress.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';
import { sweepUnsyncableModified, runDeletesPhase } from './deletes.ts';
import { finishWithoutChanges, finalizeIncrementalSync } from './finalize.ts';
import { runImportsPhase } from './imports.ts';
import { preflightIncrementalSync } from './preflight.ts';
import { runRenamesPhase } from './renames.ts';
import { createSyncRun, abortUnpersistedPin, registerCheckpointCleanup } from './sync-run.ts';

export async function performSyncInner(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  const pre = await preflightIncrementalSync(engine, opts);
  if ('done' in pre) return pre.done;
  const { plan } = pre;
  const { totalChanges, ckpt, pin } = plan;
  opts = plan.opts;

  const swept = await sweepUnsyncableModified(engine, plan);

  const unchanged = await finishWithoutChanges(engine, plan, swept);
  if (unchanged) return unchanged;

  const noEmbed = opts.noEmbed || totalChanges > 100;
  if (totalChanges > 100) {
    slog(`Large sync (${totalChanges} files). Importing text, deferring embeddings.`);
  }

  // v0.42.x (#1794): we have real work — persist the PIN now so a crash before
  // the first path-flush still resumes to THIS target (not re-pin to a newer
  // HEAD). recordCompleted is durable (executeRawDirect + retry); a false return
  // means the pool is genuinely dead. Nothing is imported yet, so we abort
  // cleanly (zero loss) rather than draining work we could never anchor — see
  // the !pinPersisted gate just after the partial() closure below.
  const pinPersisted = await recordCompleted(engine, ckpt.target, [pin]);

  const run = createSyncRun(engine, {
    ckptPaths: ckpt.paths, onProgress: opts.onProgress, completedPaths: plan.completedPaths, checkpointEvery: plan.checkpointEvery, swept,
  });
  const start = Date.now();

  if (!pinPersisted) return await abortUnpersistedPin(run, plan);

  registerCheckpointCleanup(run);

  // Per-file progress on stderr so agents see each step of a big sync.
  // Phases: sync.deletes, sync.renames, sync.imports.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  const typeWarningsEnabled = await readTypeWarningsEnabled(engine);

  // NOTE: none of the phase calls below may run inside engine.transaction().
  // importFromContent opens its own per-file transaction and PGLite
  // transactions are not reentrant (#132 — see imports.ts).
  return (await runDeletesPhase(run, plan, progress))
    ?? (await runRenamesPhase(run, plan, progress, noEmbed))
    ?? (await runImportsPhase(run, plan, progress, noEmbed))
    ?? (await finalizeIncrementalSync(run, plan, { noEmbed, typeWarningsEnabled, start }));
}

async function readTypeWarningsEnabled(engine: BrainEngine): Promise<boolean> {
  let typeWarningsEnabled = true;
  try {
    const v = await engine.getConfig('schema.type_warnings');
    typeWarningsEnabled = !(v === 'false' || v === '0' || v === 'off');
  } catch { /* config unavailable → default on */ }
  return typeWarningsEnabled;
}
