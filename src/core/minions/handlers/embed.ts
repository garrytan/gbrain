/**
 * `embed` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { assertEmbedNotStalled } from '../../embed-stall.ts';
import type { PaceKeyOverrides } from '../../pace-mode.ts';

export function makeEmbedHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runEmbedCore } = await import('../../../commands/embed.ts');
    // Primary Minion progress channel is job.updateProgress (DB-backed,
    // readable via `gbrain jobs get <id>`). Stderr from the worker daemon
    // only emits coarse job-start / job-done lines; per-page detail lives
    // in the DB. Per Codex review #20.
    const embedResult = await runEmbedCore(engine, {
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      slugs: Array.isArray(job.data.slugs) ? (job.data.slugs as string[]) : undefined,
      all: !!job.data.all,
      stale: job.data.all ? false : (job.data.stale !== false),
      // `embed --background` serializes dryRun into the payload (embed.ts's
      // job-args builder). Not reading it back here meant a backgrounded
      // preview embedded for real: API spend and NULL->vector writes from an
      // invocation whose whole point was to do neither.
      dryRun: !!job.data.dryRun,
      sourceId: typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined,
      // Background parity (D7): the doc-recommended recovery
      // `embed --stale --catch-up --include-null-signature --background`
      // used to silently DEGRADE — the payload dropped these four, so the
      // job ran as a plain 30-min-budget stale pass with the grandfather
      // clause intact. Serialize + read them like every other embed knob.
      catchUp: !!job.data.catchUp,
      includeNullSignature: !!job.data.includeNullSignature,
      batchSize: typeof job.data.batchSize === 'number' ? job.data.batchSize : undefined,
      priority: job.data.priority === 'recent' ? 'recent' : undefined,
      // CX1+CX5: pace overrides ride in the job payload as explicit overrides
      // only; runEmbedCore re-resolves env > config > bundle at execution so
      // GBRAIN_PACE_* still wins during an incident.
      ...(job.data.pace && typeof job.data.pace === 'object'
        ? {
            pace: job.data.pace as { perCallMode?: string; perCall?: PaceKeyOverrides },
            // Serialized from the queued payload → config tier so GBRAIN_PACE_*
            // on the worker still wins at execution (Codex P2 escape hatch).
            paceFromBackground: true,
          }
        : {}),
      onProgress: (done, total, embedded) => {
        // Fire-and-forget: progress updates are best-effort and must not
        // block the worker loop.
        job.updateProgress({ done, total, embedded, phase: 'embed.pages' }).catch(() => {});
      },
    });
    // #4599 (X6): a stall-watchdog abort is an error RESULT from core; the
    // handler layer converts it to a FAILED JOB (throw) — never process.exit.
    assertEmbedNotStalled(embedResult);
    // Report what happened, not a constant. `embedded: true` claimed a dry run
    // had embedded, which is the same lie in miniature: `gbrain jobs get`
    // showed it. `embedded` stays the key it always was and stays truthy on a
    // real run (it is now the count, 0 on a dry run).
    return {
      embedded: embedResult.embedded,
      dry_run: !!embedResult.dryRun,
      would_embed: embedResult.would_embed,
      failures: embedResult.failures,
    };
  };
}
