/**
 * Recording answers for use-attributed feedback.
 *
 * An answer by a caller that may teach the brain mints an `ans_<ULID>` id,
 * returns it at once, and enqueues the event on a bounded write-behind queue
 * so reads never wait on the write. The citation signal rides the same queue
 * after its event. Callers that may not teach (read-only grants, fenced
 * clients, federated readers, delegated subagents) record nothing.
 */
import { randomBytes } from 'node:crypto';
import type { OperationContext } from '../ops/contract.ts';
import type { BrainEngine } from '../engine.ts';
import { hasScope } from '../scope.ts';
import { registerBackgroundWorkDrainer } from '../background-work.ts';
import { loadFeedbackSettings } from './settings.ts';
import {
  applyRatings, insertRetrievalEvents,
  type EventLink, type EventPage, type FeedbackOp, type RetrievalEventInput,
} from './store.ts';

export const ANSWER_ID_RE = /^ans_[0-9A-HJKMNP-TV-Z]{26}$/;
export const QUEUE_CAP = 1000;
export const PENDING_GRACE_MS = 60_000;
export const CITED_RATING = 4;
export const HINT_EVERY = 50;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function mintAnswerId(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return `ans_${time}${rand}`;
}

/** Milliseconds encoded in an answer id, or null when it is not one. */
export function answerIdTime(id: string): number | null {
  if (!ANSWER_ID_RE.test(id)) return null;
  let t = 0;
  for (const ch of id.slice(4, 14)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

export function feedbackClientId(ctx: Pick<OperationContext, 'auth'>): string {
  return ctx.auth?.clientId ?? 'local';
}

/**
 * May this caller change the shared ranking of `sourceId`? Fail-closed:
 * the owner's CLI and stdio pipe may; a remote caller needs an unrestricted
 * write grant on that source (write scope, no slug fence, no operation
 * allowlist excluding rate_answer, not a delegated subagent).
 */
export function canTeachSource(
  ctx: Pick<OperationContext, 'remote' | 'auth' | 'transport' | 'sourceId' | 'viaSubagent'>,
  sourceId: string,
): boolean {
  if (ctx.remote === false) return true;
  if (ctx.viaSubagent === true) return false;
  const auth = ctx.auth;
  if (!auth) return ctx.transport === 'stdio';
  if (!hasScope(auth.scopes ?? [], 'write')) return false;
  if (auth.boundSlugPrefixes) return false;
  if (auth.fenceProjectionDegraded) return false;
  if (auth.allowedOperations && !auth.allowedOperations.includes('rate_answer')) return false;
  return (ctx.sourceId ?? 'default') === sourceId;
}

export interface AnswerFeedbackMeta {
  answer_id?: string;
  feedback: { rateable: boolean; reason?: 'not_authorized' | 'disabled' | 'empty'; how_to_rate?: string };
}

type Job =
  | { kind: 'event'; event: RetrievalEventInput }
  | { kind: 'cited'; eventId: string; clientId: string; alpha: number; pages: EventPage[] };

interface QueueState {
  engine: BrainEngine;
  jobs: Job[];
  inFlight: number;
  running: Promise<void> | null;
}

const queues = new Map<BrainEngine, QueueState>();
const pendingEventIds = new Map<string, number>();
let dropped = 0;
/**
 * The `how_to_rate` cadence counter, per client and PROCESS-LOCAL: it resets
 * when the process restarts, so a restarted server coaches again on its first
 * answer. The visible MCP rate line (dispatch `rateLine`) does not depend on it.
 */
let answersSinceHint = new Map<string, number>();

function enqueue(engine: BrainEngine, job: Job): void {
  let q = queues.get(engine);
  if (!q) {
    q = { engine, jobs: [], inFlight: 0, running: null };
    queues.set(engine, q);
  }
  q.jobs.push(job);
  if (job.kind === 'event') pendingEventIds.set(job.event.id, Date.now());
  while (q.jobs.length > QUEUE_CAP) {
    const lost = q.jobs.shift()!;
    if (lost.kind === 'event') pendingEventIds.delete(lost.event.id);
    dropped++;
  }
  if (!q.running) q.running = runQueue(q);
}

async function runQueue(q: QueueState): Promise<void> {
  try {
    while (q.jobs.length > 0) {
      const batch: Job[] = [];
      while (q.jobs.length > 0 && batch.length < 50 && q.jobs[0]!.kind === 'event') batch.push(q.jobs.shift()!);
      try {
        if (batch.length > 0) {
          q.inFlight = batch.length;
          await insertRetrievalEvents(q.engine, batch.map(j => (j as Extract<Job, { kind: 'event' }>).event));
        } else {
          const job = q.jobs.shift() as Extract<Job, { kind: 'cited' }>;
          q.inFlight = 1;
          await applyRatings(q.engine, {
            eventId: job.eventId,
            clientId: job.clientId,
            signal: 'cited',
            alpha: job.alpha / 2,
            targets: job.pages.map(p => ({
              kind: 'page' as const, source_id: p.source_id, key: p.slug, rating: CITED_RATING, content_hash: p.content_hash,
            })),
          });
        }
      } catch {
        dropped += Math.max(1, batch.length);
      } finally {
        q.inFlight = 0;
        for (const j of batch) pendingEventIds.delete((j as Extract<Job, { kind: 'event' }>).event.id);
      }
    }
  } finally {
    q.running = null;
  }
}

/** True while an event with this id is still waiting in this process's queue. */
export function isAnswerPending(id: string): boolean {
  return pendingEventIds.has(id);
}

export function droppedFeedbackEvents(): number {
  return dropped;
}

export async function drainFeedbackQueue(timeoutMs: number): Promise<{ unfinished: number }> {
  const running = [...queues.values()].map(q => q.running).filter((p): p is Promise<void> => p !== null);
  if (running.length === 0) return { unfinished: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const outcome = await Promise.race([Promise.allSettled(running).then(() => 'done' as const), timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'done') return { unfinished: 0 };
  return { unfinished: [...queues.values()].reduce((n, q) => n + q.inFlight + q.jobs.length, 0) };
}

registerBackgroundWorkDrainer({
  name: 'retrieval-feedback',
  order: 3,
  drain: (ms) => drainFeedbackQueue(ms),
});

export interface RecordAnswerInput {
  op: FeedbackOp;
  pages: Array<{ source_id?: string | null; slug: string; content_hash?: string | null; cited?: boolean }>;
  links?: EventLink[];
}

/**
 * Record one answer and return the additive response meta. Never throws and
 * never waits on the database write.
 */
export async function recordAnswer(ctx: OperationContext, input: RecordAnswerInput): Promise<AnswerFeedbackMeta | null> {
  try {
    const settings = await loadFeedbackSettings(ctx.engine);
    if (!settings.enabled) return null;
    const seen = new Set<string>();
    const pages: EventPage[] = [];
    for (const p of input.pages) {
      const source_id = p.source_id ?? 'default';
      const id = `${source_id}:${p.slug}`;
      if (!p.slug || seen.has(id)) continue;
      seen.add(id);
      pages.push({ source_id, slug: p.slug, content_hash: p.content_hash ?? null, rank: pages.length, cited: p.cited === true });
    }
    if (pages.length === 0) return { feedback: { rateable: false, reason: 'empty' } };
    const teachable = pages.filter(p => canTeachSource(ctx, p.source_id));
    if (teachable.length === 0) return { feedback: { rateable: false, reason: 'not_authorized' } };
    const clientId = feedbackClientId(ctx);
    const id = mintAnswerId();
    enqueue(ctx.engine, {
      kind: 'event',
      event: {
        id, client_id: clientId, op: input.op, pages,
        links: (input.links ?? []).filter(l => canTeachSource(ctx, l.source_id)),
      },
    });
    const cited = teachable.filter(p => p.cited && p.content_hash);
    if (settings.learn && settings.implicit && cited.length > 0) {
      enqueue(ctx.engine, { kind: 'cited', eventId: id, clientId, alpha: settings.alpha, pages: cited });
    }
    const meta: AnswerFeedbackMeta = { answer_id: id, feedback: { rateable: true } };
    if (settings.ratingPrompt) {
      const n = answersSinceHint.get(clientId) ?? 0;
      if (n % HINT_EVERY === 0) {
        meta.feedback.how_to_rate = `Rate this answer after you use it: rate_answer { answer_id: "${id}", rating: 1-5 } (or pages: [{ ref, rating }] for single pages). Ratings tune this brain's ranking.`;
      }
      answersSinceHint.set(clientId, n + 1);
    }
    return meta;
  } catch {
    return null;
  }
}

export function _resetFeedbackRecordingForTests(): void {
  queues.clear();
  pendingEventIds.clear();
  dropped = 0;
  answersSinceHint = new Map();
}

/** Additive response-meta fields: present only on a rateable answer, so readers see no change. */
export function feedbackMetaFields(meta: AnswerFeedbackMeta | null): Record<string, unknown> {
  if (!meta?.answer_id) return {};
  return { answer_id: meta.answer_id, feedback: meta.feedback };
}

/** Typed edges on the representative relational path of each returned relational-arm row. */
export function relationalPathLinks(
  rows: Array<{ slug: string; source_id?: string; relational_path_edges?: string[] }>,
): EventLink[] {
  const out: EventLink[] = [];
  for (const r of rows) {
    for (const edge of r.relational_path_edges ?? []) {
      out.push({ source_id: r.source_id ?? 'default', edge_key: edge, to_slug: r.slug });
    }
  }
  return out;
}

/**
 * Record a think/synthesize answer: gathered pages are the used set; a page is
 * cited only when synthesis succeeded and its bare cited slug is unambiguous
 * among the gathered sources.
 */
export async function recordThinkAnswer(
  ctx: OperationContext,
  op: 'think' | 'synthesize',
  result: {
    synthesis_status?: string;
    citations: Array<{ page_slug: string }>;
    feedback_evidence?: Array<{ source_id: string; slug: string; content_hash: string | null }>;
  },
): Promise<AnswerFeedbackMeta | null> {
  const evidence = result.feedback_evidence ?? [];
  const citedSlugs = new Set(result.synthesis_status === 'ok' ? result.citations.map(c => c.page_slug) : []);
  const sourcesBySlug = new Map<string, number>();
  for (const e of evidence) sourcesBySlug.set(e.slug, (sourcesBySlug.get(e.slug) ?? 0) + 1);
  return recordAnswer(ctx, {
    op,
    pages: evidence.map(e => ({ ...e, cited: citedSlugs.has(e.slug) && sourcesBySlug.get(e.slug) === 1 })),
  });
}

/** Record a search-shaped answer (rows as returned) and return its additive meta fields. */
export async function searchAnswerFeedback(
  ctx: OperationContext,
  op: 'query' | 'search' | 'recall',
  rows: Array<{ slug: string; source_id?: string; content_hash?: string | null; relational_path_edges?: string[] }>,
): Promise<Record<string, unknown>> {
  const meta = feedbackMetaFields(await recordAnswer(ctx, {
    op,
    pages: rows.map(r => ({ source_id: r.source_id, slug: r.slug, content_hash: r.content_hash })),
    links: relationalPathLinks(rows),
  }));
  for (const r of rows) delete r.content_hash;
  return meta;
}
