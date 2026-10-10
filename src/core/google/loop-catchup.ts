/**
 * loop-catchup — recovery passes for the open-loop engine that the Gmail
 * sweep runs besides its normal per-thread detection.
 *
 * Grace holds (#5868). `detectThreadLoop` withholds a loop while its grace
 * window (inbound 24h, outbound 72h) runs, and Gmail history never re-lists a
 * quiet thread, so a held thread used to stay unevaluated forever. The sweep
 * now records each grace hold in connector state (`loop_grace_holds`, capped
 * at GRACE_HOLDS_CAP, oldest pruned and logged) with the loop spec the
 * detection produced. Once due, an unchanged thread (the page still carries
 * the newest message id the spec was computed from) opens its loop from the
 * stored spec with no Gmail call; a changed or missing page, or a backfill
 * seed with no spec, is re-fetched (at most GRACE_REFETCH_PER_SWEEP per
 * sweep). Grace holds are not connector item holds: they never count as
 * failures, `connector_held_items` or `waiting` coverage. A one-shot backfill
 * seeds holds for email pages active in the last GRACE_BACKFILL_DAYS that
 * have no open deterministic loop, from stored pages only.
 *
 * Catch-up (#5867). Managed connector syncs never enqueued `loops_extract`
 * before this wave, so a managed source's recent threads were never analyzed.
 * A one-shot, managed-only pass re-candidates the source's email pages whose
 * newest message falls in the last LOOPS_EXTRACT_WINDOW_DAYS. Evidence that a
 * thread is done is a revision-bound outcome, not a completed job: the
 * `loops_extract` handler records `extracted` or `skipped:<reason>` per page
 * revision (`recordLoopsExtractOutcome`). A candidate is settled when its
 * current revision was `extracted`, when the catch-up itself produced an
 * outcome for it, or when it is not eligible. Dead-lettered catch-up jobs get
 * one retry, then are logged and settled. The done marker is written only
 * when every candidate is settled; the enqueue ceiling defers the rest to the
 * next sweep.
 */

import type { BrainEngine } from '../engine.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import { connectorStateKey } from '../persistence/connector-state.ts';
import { LOOPS_EXTRACT_ENQUEUE_CEILING, LOOPS_EXTRACT_JOB, LOOPS_EXTRACT_WINDOW_DAYS, isLoopsExtractionEnabled, loopExtractionEligibility } from './loops-extract.ts';
import { openDueGraceHold, type ThreadLoopVerdict } from './loop-detect.ts';
import { NO_EXCLUSION, type LoopsExclusionPolicy } from './loops-exclusion.ts';
import type { GmailThreadData, GoogleSourceState, LoopGraceHold } from './types.ts';

export const GRACE_HOLDS_CAP = 2_000;
export const GRACE_BACKFILL_DAYS = 14;
export const GRACE_REFETCH_PER_SWEEP = 100;
export const LOOPS_OUTCOMES_OP = 'loops-extract-outcomes';
const DAY_MS = 86_400_000;

type Log = (msg: string) => void;

// ── Grace holds (#5868) ──────────────────────────────────────────────────────

/** Records or clears one thread's grace hold from its fresh detection verdict. */
export function recordGraceVerdict(state: GoogleSourceState, thread: GmailThreadData, verdict: ThreadLoopVerdict,
  slug: string | null, myAddresses: Set<string>, log: Log, exclusion: LoopsExclusionPolicy = NO_EXCLUSION): void {
  const holds = state.loop_grace_holds ??= {};
  if (verdict.held && loopExtractionEligibility(thread, myAddresses, exclusion).eligible) {
    // Message prose reaches the connector checkpoint's jsonb: sanitize it as the page render does.
    const spec = verdict.held.spec;
    holds[thread.threadId] = { due_ms: verdict.held.untilMs, slug, rev: thread.messages[thread.messages.length - 1]?.id ?? null,
      spec: { ...spec, summary: sanitizeForJsonb(spec.summary), counterpartyEmail: sanitizeForJsonb(spec.counterpartyEmail),
        evidence: spec.evidence.map(e => ({ ...e, ...(e.quote !== undefined ? { quote: sanitizeForJsonb(e.quote) } : {}) })) } };
    pruneGraceHolds(holds, log);
  } else {
    delete holds[thread.threadId];
  }
}

function pruneGraceHolds(holds: Record<string, LoopGraceHold>, log: Log): void {
  const ids = Object.keys(holds);
  if (ids.length <= GRACE_HOLDS_CAP) return;
  const excess = ids.sort((a, b) => holds[a].due_ms - holds[b].due_ms).slice(0, ids.length - GRACE_HOLDS_CAP);
  for (const id of excess) delete holds[id];
  log(`[google] loop grace holds over the ${GRACE_HOLDS_CAP} cap: pruned ${excess.length} oldest hold(s); those threads are re-evaluated when they change`);
}

/**
 * One-shot backfill: seeds a due hold (no spec, so it is re-fetched) for every
 * email page with activity in the last 14 days and no open deterministic
 * loop. Reads stored pages only. The caller sets `loop_grace_backfill_done`
 * after a non-aborted sweep.
 */
export async function seedGraceBackfill(engine: BrainEngine, sourceId: string, state: GoogleSourceState, log: Log, now = Date.now()): Promise<number> {
  if (state.loop_grace_backfill_done) return 0;
  const rows = await engine.executeRaw<{ slug: string; thread_id: string }>(
    `SELECT p.slug, p.frontmatter->>'thread_id' AS thread_id FROM pages p
      WHERE p.source_id=$1 AND p.type='email' AND p.deleted_at IS NULL
        AND p.frontmatter->>'thread_id' IS NOT NULL AND p.frontmatter->>'date' >= $2
        AND NOT EXISTS (SELECT 1 FROM open_loops l WHERE l.source_id=p.source_id AND l.thread_id=p.frontmatter->>'thread_id'
          AND l.status='open' AND l.loop_type IN ('unanswered_inbound','unanswered_outbound'))`,
    [sourceId, new Date(now - GRACE_BACKFILL_DAYS * DAY_MS).toISOString()]);
  const holds = state.loop_grace_holds ??= {};
  let seeded = 0;
  for (const row of rows) {
    if (holds[row.thread_id]) continue;
    holds[row.thread_id] = { due_ms: now, slug: row.slug, rev: null, spec: null };
    seeded++;
  }
  pruneGraceHolds(holds, log);
  log(`[google] loop grace backfill: ${seeded} thread(s) from the last ${GRACE_BACKFILL_DAYS} days held for re-evaluation`);
  return seeded;
}

export type GraceRefetch = (threadId: string) => Promise<'ok' | 'gone' | 'failed'>;

/**
 * Settles due grace holds. Threads the sweep already processed this run were
 * re-detected there. An unchanged thread opens from its stored spec; others
 * are re-fetched through `refetch` (which re-records or clears the hold). A
 * failed re-fetch keeps the hold due for the next sweep.
 */
export async function settleDueGraceHolds(ctx: {
  engine: BrainEngine; sourceId: string; state: GoogleSourceState; log: Log; signal?: AbortSignal;
  processed: Set<string>; refetch: GraceRefetch; now?: number; exclusion?: LoopsExclusionPolicy;
}): Promise<{ opened: number; refetched: number; deferred: number } | 'aborted'> {
  const holds = ctx.state.loop_grace_holds ?? {};
  const now = ctx.now ?? Date.now();
  const due = Object.entries(holds).filter(([tid, h]) => h.due_ms <= now && !ctx.processed.has(tid)).sort((a, b) => a[1].due_ms - b[1].due_ms);
  const result = { opened: 0, refetched: 0, deferred: 0 };
  for (const [tid, hold] of due) {
    if (ctx.signal?.aborted) return 'aborted';
    if (hold.spec && hold.slug && await pageRevision(ctx.engine, ctx.sourceId, hold.slug) === hold.rev) {
      // #5445: an unresolved exclusion keeps the hold (and its spec) for the next sweep; nothing is published.
      const outcome = await openDueGraceHold(ctx.engine, ctx.sourceId, tid, hold.spec, hold.slug, ctx.exclusion ?? NO_EXCLUSION);
      if (outcome === 'deferred') { result.deferred++; continue; }
      if (outcome === 'opened') result.opened++;
      delete holds[tid];
      continue;
    }
    if (result.refetched >= GRACE_REFETCH_PER_SWEEP) { result.deferred++; continue; }
    result.refetched++;
    const outcome = await ctx.refetch(tid);
    if (outcome === 'gone') delete holds[tid];
    else if (outcome === 'ok' && holds[tid] === hold) delete holds[tid];
  }
  if (due.length > 0) {
    ctx.log(`[google] loop grace holds: ${due.length} due — ${result.opened} opened from stored data, ${result.refetched} re-fetched`
      + (result.deferred > 0 ? `, ${result.deferred} deferred to the next sweep` : ''));
  }
  return result;
}

async function pageRevision(engine: BrainEngine, sourceId: string, slug: string): Promise<string | null | undefined> {
  const page = await engine.getPage(slug, { sourceId });
  if (!page) return undefined;
  const id = (page.frontmatter as Record<string, unknown> | undefined)?.message_id;
  return typeof id === 'string' ? id : null;
}

// ── Revision-bound loops_extract outcomes (#5867, E9) ────────────────────────

export interface LoopsExtractOutcome {
  rev: number;
  outcome: string;
  catchup: boolean;
  at: string;
}

async function outcomesKey(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  return row ? connectorStateKey(sourceId, row.incarnation) : null;
}

/**
 * Records one page revision's extraction outcome in one statement (no race
 * with the sync lease holder), pruning entries older than the extraction
 * window so the row stays bounded.
 */
export async function recordLoopsExtractOutcome(engine: BrainEngine, sourceId: string, slug: string,
  entry: { rev: number; outcome: string; catchup: boolean }): Promise<void> {
  const key = await outcomesKey(engine, sourceId);
  if (!key) return;
  const value = JSON.stringify({ ...entry, at: new Date().toISOString() });
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('version',1,'outcomes',jsonb_build_object($3::text,$4::text::jsonb))))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'outcomes',
      COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(op_checkpoints.completed_keys->0->'outcomes') e
        WHERE e.key<>$3::text AND (e.value->>'at')::timestamptz > now() - ($5::text || ' days')::interval),'{}'::jsonb)
      || jsonb_build_object($3::text,$4::text::jsonb))), updated_at=now()`,
  [LOOPS_OUTCOMES_OP, key, slug, value, String(LOOPS_EXTRACT_WINDOW_DAYS + 1)]);
}

export async function readLoopsExtractOutcomes(engine: BrainEngine, sourceId: string): Promise<Record<string, LoopsExtractOutcome>> {
  const key = await outcomesKey(engine, sourceId);
  if (!key) return {};
  const [row] = await engine.executeRaw<{ outcomes: Record<string, LoopsExtractOutcome> | null }>(
    `SELECT completed_keys->0->'outcomes' AS outcomes FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`, [LOOPS_OUTCOMES_OP, key]);
  return row?.outcomes ?? {};
}

/** The page revision a loops_extract job analyzed: its payload, else the page's newest message date. */
export async function loopsExtractRevision(engine: BrainEngine, sourceId: string, slug: string, payloadRev: unknown): Promise<number | null> {
  if (typeof payloadRev === 'number' && Number.isFinite(payloadRev)) return payloadRev;
  const page = await engine.getPage(slug, { sourceId });
  const date = (page?.frontmatter as Record<string, unknown> | undefined)?.date;
  const ms = typeof date === 'string' ? Date.parse(date) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// ── Managed 30-day catch-up (#5867) ──────────────────────────────────────────

export interface LoopsEnqueueReport {
  enqueued: number;
  deferred: number;
  skipped_reason: string | null;
}

/** The pending loops_extract depth for one source (waiting, delayed, active). */
export async function pendingLoopsExtractDepth(engine: BrainEngine, sourceId: string): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs
        WHERE name = $1 AND status IN ('waiting', 'delayed', 'active') AND data->>'sourceId' = $2`, [LOOPS_EXTRACT_JOB, sourceId]);
    return parseInt(rows[0]?.n ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * One catch-up pass for a managed source. Returns null when the catch-up is
 * already done. Never throws for an individual candidate: a failed Gmail read
 * leaves the candidate for the next sweep.
 */
export async function runLoopsCatchup(ctx: {
  engine: BrainEngine; sourceId: string; state: GoogleSourceState; log: Log; signal?: AbortSignal;
  myAddresses: Set<string>; fetchThread: (threadId: string) => Promise<GmailThreadData | null>; now?: number;
  /** Pages this sweep already queues through the normal enqueue. */
  inFlight: Set<string>;
  /** #5445: the sweep's resolved label exclusion; unresolved fails closed for every candidate. */
  exclusion?: LoopsExclusionPolicy;
}): Promise<LoopsEnqueueReport | null> {
  if (ctx.state.loops_catchup?.done) return null;
  const now = ctx.now ?? Date.now();
  const skip = (reason: string, message: string): LoopsEnqueueReport => {
    ctx.log(`[google] loops catch-up skipped (${reason}): ${message}; nothing queued, it runs on a later sweep`);
    return { enqueued: 0, deferred: 0, skipped_reason: reason };
  };
  if (!(await isLoopsExtractionEnabled(ctx.engine))) return skip('extraction_disabled', 'loops.extraction_enabled is off');
  const exclusion = ctx.exclusion ?? NO_EXCLUSION;
  if (exclusion.unresolved.length > 0) {
    return skip('excluded_label_unresolved', `loop exclusion labels ${exclusion.unresolved.map((t) => JSON.stringify(t)).join(', ')} did not resolve`);
  }
  const { isAvailable } = await import('../ai/gateway.ts');
  if (!isAvailable('chat')) return skip('chat_unavailable', 'no configured chat model / API key');

  const cu = ctx.state.loops_catchup ??= { version: 1, floor_ms: now - LOOPS_EXTRACT_WINDOW_DAYS * DAY_MS, retried: [], done: false };
  const pages = await ctx.engine.executeRaw<{ slug: string; thread_id: string; date: string }>(
    `SELECT slug, frontmatter->>'thread_id' AS thread_id, frontmatter->>'date' AS date FROM pages
      WHERE source_id=$1 AND type='email' AND deleted_at IS NULL AND frontmatter->>'thread_id' IS NOT NULL AND frontmatter->>'date' >= $2
      ORDER BY frontmatter->>'date' DESC`, [ctx.sourceId, new Date(cu.floor_ms).toISOString()]);
  const outcomes = await readLoopsExtractOutcomes(ctx.engine, ctx.sourceId);
  const keyOf = (slug: string, rev: number) => `loops-catchup:${ctx.sourceId}:${slug}:${rev}`;
  const candidates = pages.map(p => ({ ...p, rev: Date.parse(p.date) })).filter(p => Number.isFinite(p.rev));
  const jobRows = candidates.length === 0 ? [] : await ctx.engine.executeRaw<{ idempotency_key: string; status: string }>(
    'SELECT idempotency_key, status FROM minion_jobs WHERE idempotency_key = ANY($1::text[])',
    [candidates.flatMap(c => [keyOf(c.slug, c.rev), `${keyOf(c.slug, c.rev)}:retry`, `loops:${ctx.sourceId}:${c.slug}:${c.rev}`])]);
  const jobs = new Map(jobRows.map(r => [r.idempotency_key, r.status]));
  const { MinionQueue } = await import('../minions/queue.ts');
  const queue = new MinionQueue(ctx.engine);
  let budget = Math.max(0, LOOPS_EXTRACT_ENQUEUE_CEILING - await pendingLoopsExtractDepth(ctx.engine, ctx.sourceId));
  const report: LoopsEnqueueReport = { enqueued: 0, deferred: 0, skipped_reason: null };
  let unsettled = 0;
  const settle = (slug: string, rev: number, outcome: string) => recordLoopsExtractOutcome(ctx.engine, ctx.sourceId, slug, { rev, outcome, catchup: true });
  const enqueue = async (c: { slug: string; thread_id: string; rev: number }, key: string) => {
    await queue.add(LOOPS_EXTRACT_JOB, { slug: c.slug, sourceId: ctx.sourceId, threadId: c.thread_id, newestMs: c.rev, catchup: true },
      { priority: 6, idempotency_key: key });
    budget--;
    report.enqueued++;
  };
  for (const c of candidates) {
    if (ctx.signal?.aborted) { unsettled++; break; }
    const prior = outcomes[c.slug];
    if (prior && prior.rev === c.rev && (prior.outcome === 'extracted' || (prior.catchup && prior.outcome !== 'skipped:extraction_disabled'))) continue;
    const sweepStatus = jobs.get(`loops:${ctx.sourceId}:${c.slug}:${c.rev}`);
    if (ctx.inFlight.has(c.slug) || sweepStatus === 'waiting' || sweepStatus === 'delayed' || sweepStatus === 'active') { unsettled++; continue; }
    const key = keyOf(c.slug, c.rev);
    const status = jobs.get(`${key}:retry`) ?? jobs.get(key);
    if (status === 'completed') continue;
    if (status === 'dead' || status === 'failed' || status === 'cancelled') {
      if (cu.retried.includes(c.slug) || jobs.has(`${key}:retry`)) {
        ctx.log(`[google] loops catch-up: ${c.slug} dead-lettered after its retry; giving up on this revision`);
        await settle(c.slug, c.rev, 'skipped:dead_letter');
        continue;
      }
      if (budget <= 0) { report.deferred++; unsettled++; continue; }
      cu.retried.push(c.slug);
      await enqueue(c, `${key}:retry`);
      unsettled++;
      continue;
    }
    if (status !== undefined) { unsettled++; continue; }
    if (budget <= 0) { report.deferred++; unsettled++; continue; }
    let thread: GmailThreadData | null;
    try {
      thread = await ctx.fetchThread(c.thread_id);
    } catch (e) {
      ctx.log(`[google] loops catch-up: could not read thread for ${c.slug} (${e instanceof Error ? e.message : String(e)}); retried next sweep`);
      unsettled++;
      continue;
    }
    if (!thread) { await settle(c.slug, c.rev, 'skipped:thread_not_found'); continue; }
    const verdict = loopExtractionEligibility(thread, ctx.myAddresses, exclusion);
    if (!verdict.eligible) { await settle(c.slug, c.rev, `skipped:ineligible_${verdict.reason}`); continue; }
    await enqueue(c, key);
    unsettled++;
  }
  if (unsettled === 0) cu.done = true;
  ctx.log(`[google] loops catch-up (last ${LOOPS_EXTRACT_WINDOW_DAYS} days): enqueued ${report.enqueued} thread(s)`
    + (report.deferred > 0 ? `, deferred ${report.deferred} to a later sweep (enqueue ceiling ${LOOPS_EXTRACT_ENQUEUE_CEILING})` : '')
    + (cu.done ? '; catch-up complete' : `; ${unsettled} thread(s) not settled yet`));
  return report;
}
