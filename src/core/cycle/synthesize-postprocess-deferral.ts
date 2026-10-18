/**
 * #6757: dream synthesis postprocessing reads the request journal twice: the
 * committed-outputs join (`loadCommittedSynthesisOutputs`) and each output's
 * own postprocess request (`getWriteRequest`). When either read hits the
 * statement timeout the children have already run and been paid for, so the
 * pass is deferred, never failed: the outputs it could not finish are recorded
 * here, with everything their postprocess request id is derived from (the
 * child's request id, revision and job key, the transcript path and the content
 * hash it was synthesized from), so a later pass finishes them without
 * re-running a child, even after the transcript grows or `jobs prune` removes
 * the child's rows. State lives in one config row keyed by source; a pass that
 * defers increments the source's consecutive count and a pass that does not
 * resets it, so doctor `persistence_request_indexes` can name a repeating
 * deferral.
 */
import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';

export const POSTPROCESS_PENDING_KEY = 'dream.synthesize.postprocess_pending';
/** Consecutive deferred passes after which doctor names the deferral. */
export const POSTPROCESS_DEFERRAL_WARN_PASSES = 3;

export type DeferredRead = 'committed_outputs' | 'postprocess_request';

/** One child output whose postprocessing has not finished. */
export interface PendingOutput {
  request_id: string;
  slug: string;
  input_slug: string;
  revision: string;
  job_key: string;
  raw_source: string;
  transcript_hash: string;
  seat?: string;
  first_write_at?: string;
}

export interface SourceDeferral {
  source_incarnation: string;
  consecutive: number;
  last_attempt_at: string;
  last_deferred_at?: string;
  last_read?: DeferredRead;
  last_elapsed_ms?: number;
  pending: PendingOutput[];
}

/** What a deferred pass reports in its phase result. */
export interface PostprocessDeferral { read: DeferredRead; elapsed_ms: number; outputs: number; consecutive: number }

/**
 * A statement timeout from one of the two deferrable reads. A cancelled cycle
 * unwinds first (an explicit cancel also raises SQLSTATE 57014), and only the
 * server's statement-timeout message counts, so a user cancel is never
 * deferred.
 */
export function isPostprocessReadTimeout(error: unknown, signal: AbortSignal | undefined): boolean {
  throwIfAborted(signal, '[dream] synthesis postprocessing');
  const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return code === '57014' && /statement timeout/i.test(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`);
}

export async function readPostprocessDeferrals(engine: Pick<BrainEngine, 'getConfig'>): Promise<Record<string, SourceDeferral>> {
  try {
    const parsed = JSON.parse(await engine.getConfig(POSTPROCESS_PENDING_KEY) ?? '{}') as Record<string, SourceDeferral>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** The outputs still pending for one source incarnation (another incarnation's are moot). */
export async function pendingOutputsFor(engine: Pick<BrainEngine, 'getConfig'>, sourceId: string, incarnation: string): Promise<PendingOutput[]> {
  const entry = (await readPostprocessDeferrals(engine))[sourceId];
  return entry?.source_incarnation === incarnation && Array.isArray(entry.pending) ? entry.pending : [];
}

/**
 * Record one postprocess pass for a source: drop the outputs it finished or
 * left alone for good, add the ones it deferred or could not publish yet
 * (`carry`), and count consecutive deferred passes. Returns the deferral to
 * report, or null when the pass deferred no read.
 */
export async function recordPostprocessPass(engine: Pick<BrainEngine, 'getConfig' | 'setConfig'>, sourceId: string, incarnation: string,
  pass: { settled: string[]; carry?: PendingOutput[]; deferred?: { read: DeferredRead; elapsed_ms: number; pending: PendingOutput[] } }): Promise<PostprocessDeferral | null> {
  const state = await readPostprocessDeferrals(engine);
  const prior = state[sourceId]?.source_incarnation === incarnation ? state[sourceId] : undefined;
  const settled = new Set(pass.settled);
  const pending = new Map((prior?.pending ?? []).filter(p => !settled.has(p.request_id)).map(p => [p.request_id, p]));
  for (const p of [...pass.deferred?.pending ?? [], ...pass.carry ?? []]) pending.set(p.request_id, p);
  const now = new Date().toISOString();
  const consecutive = pass.deferred ? (prior?.consecutive ?? 0) + 1 : 0;
  if (!pending.size && !consecutive) {
    if (!state[sourceId]) return null;
    delete state[sourceId];
  } else {
    state[sourceId] = { source_incarnation: incarnation, consecutive, last_attempt_at: now, pending: [...pending.values()],
      ...(pass.deferred ? { last_deferred_at: now, last_read: pass.deferred.read, last_elapsed_ms: pass.deferred.elapsed_ms } : {}) };
  }
  await engine.setConfig(POSTPROCESS_PENDING_KEY, JSON.stringify(state));
  return pass.deferred ? { read: pass.deferred.read, elapsed_ms: pass.deferred.elapsed_ms, outputs: pending.size, consecutive } : null;
}

/** Sources whose postprocessing deferred at least `POSTPROCESS_DEFERRAL_WARN_PASSES` passes in a row (doctor). */
export async function repeatedPostprocessDeferrals(engine: Pick<BrainEngine, 'getConfig'>): Promise<Array<{ source_id: string } & SourceDeferral>> {
  return Object.entries(await readPostprocessDeferrals(engine))
    .filter(([, entry]) => Number(entry?.consecutive) >= POSTPROCESS_DEFERRAL_WARN_PASSES)
    .map(([source_id, entry]) => ({ source_id, ...entry }));
}

export const DEFERRED_READ_LABEL: Record<DeferredRead, string> = {
  committed_outputs: 'the committed-outputs read',
  postprocess_request: 'a postprocess request read',
};
