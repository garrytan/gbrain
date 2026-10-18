/**
 * #6803 part 2: the resident's `projection_status` answer, kept off the tick
 * path. Counting every class of a 93K-row queue takes hundreds of
 * milliseconds, more than a doctor read should wait on and nothing a consumer
 * tick should pay for, so the resident refreshes the counts on a timer: at
 * most every 60 s when the queue's row count or `max(updated_at)` or a source's
 * archive flag changed, and at least every 10 minutes otherwise. The IPC reply
 * reads the cache (host-local, within the 2 s budget); before the first count
 * finishes it waits for that count.
 */
import type { BrainEngine } from '../engine.ts';
import { projectionBacklog, type ProjectionBacklog } from './projections.ts';

export const PROJECTION_STATUS_CHECK_MS = 60_000;
export const PROJECTION_STATUS_MAX_AGE_MS = 10 * 60_000;

export interface ProjectionStatusCache {
  /** The latest class counts (the first call waits for the first count). */
  read(): Promise<Required<ProjectionBacklog>>;
  /** Recount when the queue or a source's lifecycle changed, or the count is older than 10 minutes. */
  refresh(): Promise<void>;
  stop(): void;
}

export function startProjectionStatusCache(engine: Pick<BrainEngine, 'executeRaw'>, opts: { now?: () => number; checkMs?: number } = {}): ProjectionStatusCache {
  const now = opts.now ?? Date.now;
  let counted: { at: number; signal: string; value: Required<ProjectionBacklog> } | null = null;
  let inflight: Promise<void> | null = null;
  const refresh = (): Promise<void> => inflight ??= (async () => {
    const [row] = await engine.executeRaw<{ signal: string }>(`SELECT (SELECT count(*) FROM page_projection_jobs)::text || '/'
      || COALESCE((SELECT max(updated_at) FROM page_projection_jobs)::text,'') || '/'
      || md5(COALESCE((SELECT string_agg(id || ':' || archived::text, ',' ORDER BY id) FROM sources),'')) AS signal`);
    const signal = String(row?.signal ?? '');
    if (counted && counted.signal === signal && now() - counted.at < PROJECTION_STATUS_MAX_AGE_MS) return;
    counted = { at: now(), signal, value: await projectionBacklog(engine) };
  })().finally(() => { inflight = null; });
  const timer = setInterval(() => { refresh().catch(() => undefined); }, opts.checkMs ?? PROJECTION_STATUS_CHECK_MS);
  timer.unref?.();
  refresh().catch(() => undefined);
  return {
    async read() {
      if (!counted) await refresh();
      return counted!.value;
    },
    refresh,
    stop: () => clearInterval(timer),
  };
}
