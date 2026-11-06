/**
 * The events gbrain offers Wakeshift (plan D2, D3): `gbrain.job.finished`, a
 * minion job reaching completed, failed, dead or cancelled;
 * `gbrain.write.settled`, a write request reaching committed, failed,
 * conflict or cancelled; `gbrain.cron.finished`, a registered cron's run
 * reported by `gbrain wakeshift emit`. Every event is personal (only the
 * named subscription gets an occurrence) and deleted on delivery. The payload is a pointer: ids, status,
 * kind, times and the exact next call. Never page text, titles or slugs, so a
 * wake cannot widen readable_by, folder rules or private pages; the agent's
 * follow-up read goes through gbrain's own access checks.
 */
import { createHash } from 'node:crypto';

export const JOB_FINISHED = 'gbrain.job.finished';
export const WRITE_SETTLED = 'gbrain.write.settled';
export const CRON_FINISHED = 'gbrain.cron.finished';

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

const TIME = { type: ['string', 'null'] } as const;

const WRITE_PAYLOAD = {
  type: 'object',
  properties: {
    request_id: { type: 'string', maxLength: 64 },
    state: { type: 'string', enum: ['committed', 'failed', 'conflict', 'cancelled', 'gone'] },
    operation: { type: ['string', 'null'], maxLength: 100 },
    source_id: { type: ['string', 'null'], maxLength: 100 },
    accepted_at: TIME,
    settled_at: TIME,
    next: { type: 'string', maxLength: 200 },
  },
  required: ['request_id', 'state', 'next'],
  additionalProperties: false,
} as const;

const CRON_PAYLOAD = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 64 },
    status: { type: 'string', enum: ['ok', 'failed'] },
    finished_at: TIME,
    next: { type: 'string', maxLength: 200 },
  },
  required: ['name', 'status', 'next'],
  additionalProperties: false,
} as const;

/** The manifest `gbrain wakeshift enable` merges (POST /manifest/merge); topic as the SDK would build it. */
export function wakeshiftManifest(): { events: Record<string, unknown>[] } {
  const event = (name: string, description: string, arg: string, argSchema: Record<string, unknown>, payload: unknown) => ({
    name, description,
    arguments: { type: 'object', properties: { [arg]: argSchema }, required: [arg], additionalProperties: false },
    payload, topic: `ev/${name}/{${arg}}`, personal: true, delete_on_delivery: true,
  });
  return {
    events: [
      event(JOB_FINISHED, 'A gbrain background job you are watching reached completed, failed, dead or cancelled. The payload is a pointer: call get_job with the id for the result.',
        'job', { type: 'integer', minimum: 1 }, JOB_PAYLOAD),
      event(WRITE_SETTLED, 'A gbrain write request you are watching reached committed, failed, conflict or cancelled. The payload is a pointer: call get_write_request with the id for the receipt.',
        'request_id', { type: 'string', pattern: '^[0-9a-f-]{36}$' }, WRITE_PAYLOAD),
      event(CRON_FINISHED, 'A scheduled gbrain cron you are watching reported its run as ok or failed. The payload names the cron and the status; read its output where the cron writes it.',
        'name', { type: 'string', pattern: '^[a-z0-9._-]{1,64}$' }, CRON_PAYLOAD),
    ],
  };
}

/** A short hash of the manifest this build publishes; `enable` stores it so status and doctor can tell a stale one. */
export function wakeshiftManifestHash(): string {
  return createHash('sha256').update(JSON.stringify(wakeshiftManifest())).digest('hex').slice(0, 16);
}

/** A cron name as gbrain stores it: lowercased, any run of other characters folded to '-', at most 64 characters; null when nothing is left. */
export function cronName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return name || null;
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

export interface WriteSnapshot {
  state: string | null;
  operation: string | null;
  source_id: string | null;
  created_at: Date | string | null;
  settled_at: Date | string | null;
  /** settled_at in microseconds since the epoch, null when the request row is gone. */
  settled_us: string | null;
}

/** A write request's settled marker `<state>:<settled_us>` (`gone` when the receipt row was removed). */
export function writeMarker(req: WriteSnapshot | null): string {
  return req?.state ? `${req.state}:${req.settled_us ?? '0'}` : 'gone';
}

const WRITE_PHRASE: Record<string, string> = { committed: 'committed', failed: 'failed', conflict: 'ended in a conflict', cancelled: 'was cancelled' };

/** Payload and line for a watched write request: ids, state, operation, source and times, never the slug, title or text. */
export function writeWake(requestId: string, req: WriteSnapshot | null): { payload: Record<string, unknown>; text: string } {
  const state = req?.state ?? 'gone';
  const next = state === 'gone' ? `list_write_requests (request ${requestId} is no longer kept)` : `get_write_request ${requestId}`;
  const op = req?.operation ? ` (${req.operation.slice(0, 100)})` : '';
  return {
    payload: {
      request_id: requestId, state, operation: req?.operation?.slice(0, 100) ?? null, source_id: req?.source_id?.slice(0, 100) ?? null,
      accepted_at: iso(req?.created_at ?? null), settled_at: iso(req?.settled_at ?? null), next,
    },
    text: state === 'gone'
      ? `gbrain: write request ${requestId} settled; its receipt is no longer kept. Call list_write_requests to see recent ones.`
      : `gbrain: write request ${requestId}${op} ${WRITE_PHRASE[state] ?? state}. Call get_write_request ${requestId} for the receipt.`,
  };
}

export interface CronRun { id: number | string; status: string; finished_at: Date | string | null }

/** A cron run's marker `<run id>:<status>`. */
export function cronMarker(run: CronRun): string {
  return `${run.id}:${run.status}`;
}

/** Payload and line for a watched cron's run. No report slug: the agent reads the output where the cron writes it. */
export function cronWake(name: string, run: CronRun): { payload: Record<string, unknown>; text: string } {
  const next = `watch_cron ${name} to hear about its next run`;
  return {
    payload: { name, status: run.status, finished_at: iso(run.finished_at), next },
    text: `gbrain: cron ${name} finished ${run.status === 'ok' ? 'ok' : 'with a failure'}. Read its output where it writes it; call watch_cron ${name} to hear about the next run.`,
  };
}
