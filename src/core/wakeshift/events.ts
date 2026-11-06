/**
 * The events gbrain offers Wakeshift (plan D2, D3). PR 1 ships one:
 * `gbrain.job.finished`, a minion job reaching completed, failed, dead or
 * cancelled. Every event is personal (only the named subscription gets an
 * occurrence) and deleted on delivery. The payload is a pointer: ids, status,
 * kind, times and the exact next call. Never page text, titles or slugs, so a
 * wake cannot widen readable_by, folder rules or private pages; the agent's
 * follow-up read goes through gbrain's own access checks.
 */
export const JOB_FINISHED = 'gbrain.job.finished';

const JOB_PAYLOAD = {
  type: 'object',
  properties: {
    job: { type: 'integer', minimum: 1 },
    name: { type: 'string', maxLength: 100 },
    status: { type: 'string', enum: ['completed', 'failed', 'dead', 'cancelled', 'gone'] },
    started_at: { type: ['string', 'null'] },
    finished_at: { type: ['string', 'null'] },
    duration_ms: { type: ['integer', 'null'], minimum: 0 },
    next: { type: 'string', maxLength: 200 },
  },
  required: ['job', 'status', 'next'],
  additionalProperties: false,
} as const;

/** The manifest `gbrain wakeshift enable` merges (POST /manifest/merge); topic as the SDK would build it. */
export function wakeshiftManifest(): { events: Record<string, unknown>[] } {
  return {
    events: [{
      name: JOB_FINISHED,
      description: 'A gbrain background job you are watching reached completed, failed, dead or cancelled. The payload is a pointer: call get_job with the id for the result.',
      arguments: { type: 'object', properties: { job: { type: 'integer', minimum: 1 } }, required: ['job'], additionalProperties: false },
      payload: JOB_PAYLOAD,
      topic: `ev/${JOB_FINISHED}/{job}`,
      personal: true,
      delete_on_delivery: true,
    }],
  };
}

export interface JobSnapshot {
  id: number;
  name: string | null;
  status: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  /** finished_at in microseconds since the epoch (terminal-events.ts ordering), null when the row is gone. */
  finished_us: string | null;
}

const PHRASE: Record<string, string> = {
  completed: 'finished ok', failed: 'failed', dead: 'is dead (out of attempts)', cancelled: 'was cancelled', gone: 'finished; its details are gone',
};

function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** The job's terminal marker `<finished_us>:<status>` (`gone` when the row was removed). */
export function jobMarker(job: JobSnapshot | null): string {
  return job?.status ? `${job.finished_us ?? '0'}:${job.status}` : 'gone';
}

/**
 * Emit id: `<event>:<target>:<marker>:<watch row id>:<namespace>`, so two watchers and a re-run job never collide,
 * and neither do two brains (or a re-initialized one) on one Wakeshift key, whose job and row ids restart at 1.
 */
export function wakeEmitId(event: string, target: string, marker: string, rowId: number | string, namespace: string): string {
  return `${event}:${target}:${marker}:${rowId}:${namespace}`;
}

/** Payload and the line the agent reads first, for a watched job (or its removed row). */
export function jobWake(jobId: number, job: JobSnapshot | null): { payload: Record<string, unknown>; text: string } {
  const status = job?.status ?? 'gone';
  const started = iso(job?.started_at ?? null);
  const finished = iso(job?.finished_at ?? null);
  const duration = started && finished ? Math.max(0, Date.parse(finished) - Date.parse(started)) : null;
  const next = status === 'gone' ? `list_jobs (job ${jobId} was removed after it finished)` : `get_job ${jobId}`;
  const kind = job?.name ? ` (${job.name.slice(0, 100)})` : '';
  const took = duration != null ? ` in ${formatDuration(duration)}` : '';
  return {
    payload: { job: jobId, ...(job?.name ? { name: job.name.slice(0, 100) } : {}), status, started_at: started, finished_at: finished, duration_ms: duration, next },
    text: status === 'gone'
      ? `gbrain: job ${jobId} ${PHRASE.gone}. Call list_jobs to see recent jobs.`
      : `gbrain: job ${jobId}${kind} ${PHRASE[status] ?? status}${took}. Call get_job ${jobId} for the result.`,
  };
}
