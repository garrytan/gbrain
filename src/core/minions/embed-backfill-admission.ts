/**
 * Engine-aware admission for the embed-backfill queue job.
 *
 * PGLite has no persistent worker process, so a background row cannot drain.
 * Keep this module dependency-light: MinionQueue calls it before schema,
 * config, policy, SQL, or transaction access.
 */
import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';

export const EMBED_BACKFILL_JOB_NAME = 'embed-backfill';

export type EmbedBackfillWorkerSurface =
  | { status: 'worker_backed'; engineKind: 'postgres' }
  | { status: 'no_worker_surface'; engineKind: 'pglite' | 'unknown' };

export interface EmbedBackfillAdmissionTrust {
  /** The caller starts and awaits an inline worker in this same process. */
  allowPgliteInlineWorker?: boolean;
}

export function embedBackfillWorkerSurface(
  engine: Pick<BrainEngine, 'kind'>,
): EmbedBackfillWorkerSurface {
  const kind = engine.kind;
  if (kind === 'postgres') return { status: 'worker_backed', engineKind: 'postgres' };
  if (kind === 'pglite') return { status: 'no_worker_surface', engineKind: 'pglite' };
  kind satisfies never;
  // Runtime defense for untyped plugins/casts whose value is outside the
  // declared union; the compile-time check above forces policy for new kinds.
  return { status: 'no_worker_surface', engineKind: 'unknown' };
}

export function embedBackfillManualDrainCommand(sourceId: string): string {
  const source = sourceId === '' ? '<source-id>' : sourceId;
  if (source !== '<source-id>') assertValidSourceId(source);
  return `gbrain embed --stale --source ${source}`;
}

export class InvalidEmbedBackfillSourceIdError extends Error {
  readonly code = 'invalid_params' as const;
  readonly sourceId: unknown;

  constructor(sourceId: unknown, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'InvalidEmbedBackfillSourceIdError';
    this.sourceId = sourceId;
  }
}

function assertEmbedBackfillSourceId(sourceId: unknown): asserts sourceId is string {
  try {
    assertValidSourceId(sourceId);
  } catch (e) {
    throw new InvalidEmbedBackfillSourceIdError(sourceId, e);
  }
}

export class NoEmbedBackfillWorkerSurfaceError extends Error {
  readonly code = 'no_worker_surface' as const;
  readonly engineKind: 'pglite' | 'unknown';
  readonly sourceId: string;

  constructor(sourceId: string, engineKind: 'pglite' | 'unknown' = 'pglite') {
    const source = sourceId || '<source-id>';
    const direct = embedBackfillManualDrainCommand(source);
    const surface = engineKind === 'pglite'
      ? 'PGLite has no persistent worker surface'
      : 'the runtime engine kind has no recognized persistent worker surface';
    super(
      `embed-backfill job rejected: ${surface}, so a queued row cannot drain. ` +
      `Run \`${direct}\` instead.`,
    );
    this.name = 'NoEmbedBackfillWorkerSurfaceError';
    this.engineKind = engineKind;
    this.sourceId = source;
  }
}

export function assertEmbedBackfillQueueAdmission(
  engine: Pick<BrainEngine, 'kind'>,
  jobName: string,
  data?: Record<string, unknown>,
  trusted?: EmbedBackfillAdmissionTrust,
): void {
  if (jobName.trim() !== EMBED_BACKFILL_JOB_NAME) return;
  const rawSourceId = data?.sourceId;
  if (rawSourceId !== undefined) assertEmbedBackfillSourceId(rawSourceId);
  const surface = embedBackfillWorkerSurface(engine);
  if (surface.status === 'worker_backed') return;
  if (surface.engineKind === 'pglite' && trusted?.allowPgliteInlineWorker) return;
  const sourceId = rawSourceId ?? '<source-id>';
  throw new NoEmbedBackfillWorkerSurfaceError(sourceId, surface.engineKind);
}
