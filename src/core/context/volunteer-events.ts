/**
 * v0.43 (#2095) — context_volunteer_events: the feedback-loop log behind
 * push-based context. One row per page the brain VOLUNTEERED, written
 * fire-and-forget by the volunteer_context op, the retrieval-reflex pointer
 * path (channel 'reflex'), and `gbrain watch` (channel 'watch').
 *
 * "Used" is DERIVED, never written: a volunteered page counts as used when
 * pages.last_retrieved_at > volunteered_at (the existing bumpLastRetrievedAt
 * write-back on get_page/search/query is the open/cite signal). The join is
 * approximate by design — last-retrieved is 5-min throttled (false negatives)
 * and unrelated reads match too (false positives); stats output carries the
 * caveat.
 *
 * Retention: rows older than VOLUNTEER_EVENTS_TTL_DAYS are pruned by the
 * dream cycle's purge phase so conversation-adjacent telemetry never grows
 * unbounded. rationale is a deterministic template that may embed the matched
 * entity's surface form (which by construction resolved to an existing
 * alias/title/slug) — never free conversation text.
 */

import type { BrainEngine } from './../engine.ts';
import { registerBackgroundWorkDrainer } from '../background-work.ts';
import { reflexPointerRationale } from './retrieval-reflex.ts';

export const VOLUNTEER_EVENTS_TTL_DAYS = 90;

/** Single source of truth for channel values — type + guards derive from it. */
export const VOLUNTEER_CHANNELS = ['op', 'reflex', 'watch', 'claude-code', 'codex'] as const;
export type VolunteerChannel = (typeof VOLUNTEER_CHANNELS)[number];

/** The harness subset — the ONLY channels a wire caller may claim. */
export const HARNESS_CHANNELS = ['claude-code', 'codex'] as const;
export type HarnessChannel = (typeof HARNESS_CHANNELS)[number];

/** Wire fallback: the only harness bootstrap registers hooks for today. */
export const DEFAULT_HOOK_CHANNEL: HarnessChannel = 'claude-code';

/** session_id trust-boundary clamp — shared with the volunteer_context op. */
export const SESSION_ID_MAX_LEN = 256;

export function isVolunteerChannel(v: unknown): v is VolunteerChannel {
  return (VOLUNTEER_CHANNELS as readonly string[]).includes(v as string);
}

/**
 * Wire-facing guard: a secret-holding IPC client may attribute deliveries to
 * a HARNESS channel only — accepting internal channels ('op'/'reflex'/'watch')
 * from the wire would let a hook client pollute the internal channels'
 * precision stats (the same corruption class the delivery-point rule guards).
 */
export function isHarnessChannel(v: unknown): v is HarnessChannel {
  return (HARNESS_CHANNELS as readonly string[]).includes(v as string);
}

/**
 * The hook lane's feedback loop (#2095 closed over turn_context): log a
 * DELIVERED turn-context block's post-trim volunteered pages + reflex
 * pointers to context_volunteer_events under the request's channel, so
 * `volunteer-context --stats` and the volunteer_channels doctor check see
 * per-harness firing. Serve wires this as resolve-ipc's onTurnContextDelivered
 * callback — which fires ONLY after the response write succeeded (an
 * abandoned block was never injected and must not be counted). Channel is
 * validated; absent/unknown → 'claude-code' (the only harness bootstrap
 * registers hooks for today). sessionId is clamped like the op path's
 * trust-boundary clamp. Fire-and-forget: never throws into the server.
 */
export function logTurnContextDeliveryFireAndForget(
  engine: BrainEngine,
  result: {
    volunteered?: Array<Parameters<typeof volunteerEventRowsFrom>[0][number]>;
    pointers?: import('./retrieval-reflex.ts').ReflexPointer[];
  },
  req: { channel?: string; sessionId?: string },
): void {
  try {
    // Harness channels ONLY from the wire — see isHarnessChannel. A present-
    // but-unknown value ALSO maps to the default: ACCEPTED misattribution
    // (a typo'd local registration is the operator's own config; a dedicated
    // 'unknown' bucket was considered and declined to keep the channel value
    // set closed while bootstrap registers exactly one harness).
    const channel: VolunteerChannel = isHarnessChannel(req.channel) ? req.channel : DEFAULT_HOOK_CHANNEL;
    const sessionId = typeof req.sessionId === 'string' ? req.sessionId.slice(0, SESSION_ID_MAX_LEN) : null;
    // Pointer rows use the shared reflex rationale template; mapped inline
    // (not via logDeliveredReflexPointers) so the pending write registers
    // synchronously (a late registration can be dropped at process exit).
    const rows = [
      ...(result.volunteered?.length
        ? volunteerEventRowsFrom(result.volunteered, { channel, session_id: sessionId })
        : []),
      ...(result.pointers?.length
        ? volunteerEventRowsFrom(
            result.pointers.map((p) => ({ ...p, rationale: reflexPointerRationale(p) })),
            { channel, session_id: sessionId },
          )
        : []),
    ];
    if (rows.length) logVolunteerEventsFireAndForget(engine, rows);
  } catch {
    /* telemetry only — a logging bug must never surface into the IPC server */
  }
}

/**
 * Map volunteered pages to event rows for one channel — the ONE place the
 * VolunteerEventRow shape is assembled (op / reflex / watch all call this,
 * so adding a column is a one-site change).
 */
export function volunteerEventRowsFrom(
  pages: Array<{ source_id: string; slug: string; confidence: number; arm: string; rationale: string }>,
  opts: { channel: VolunteerChannel; session_id?: string | null; turn?: number | null },
): VolunteerEventRow[] {
  return pages.map((p) => ({
    source_id: p.source_id,
    slug: p.slug,
    confidence: p.confidence,
    match_arm: p.arm,
    rationale: p.rationale,
    channel: opts.channel,
    session_id: opts.session_id ?? null,
    turn: opts.turn ?? null,
  }));
}

export interface VolunteerEventRow {
  source_id: string;
  slug: string;
  confidence: number;
  match_arm: string;
  rationale: string;
  channel: VolunteerChannel;
  session_id?: string | null;
  turn?: number | null;
}

/**
 * ONE multi-row parameterized INSERT for a batch of volunteered pages (max 5
 * per call by the volunteer cap) — never per-row awaited INSERTs (up to 5
 * RTTs ≈ 355ms on a cross-region deployment; eng-review D4). Throws on
 * failure; callers run it through the volunteer-events background-work sink
 * with try/catch so logging can never fail the op.
 */
export async function insertVolunteerEvents(
  engine: BrainEngine,
  rows: VolunteerEventRow[],
): Promise<void> {
  if (!rows.length) return;
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const base = params.length;
    params.push(
      r.source_id,
      r.slug,
      r.confidence,
      r.match_arm,
      r.rationale,
      r.channel,
      r.session_id ?? null,
      r.turn ?? null,
    );
    const ph = Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`);
    return `(${ph.join(', ')})`;
  });
  await engine.executeRaw(
    `INSERT INTO context_volunteer_events
       (source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}

// ── Fire-and-forget sink (eng-review D4) ─────────────────────────────────
// Mirrors src/core/last-retrieved.ts: track every dangling INSERT promise in
// a module Set, register a drainer so finishCliTeardown settles them
// against a live engine before teardown on EVERY CLI exit path (the commit-1
// drain hoist). Logging failure never fails the caller.

const pendingVolunteerEventWrites = new Set<Promise<unknown>>();

/**
 * Log volunteered pages without blocking the hot path. The batched INSERT
 * runs as a tracked dangling promise; errors are swallowed (pre-v117 brains,
 * transient DB failures — the volunteer result is unaffected).
 */
export function logVolunteerEventsFireAndForget(
  engine: BrainEngine,
  rows: VolunteerEventRow[],
): void {
  if (!rows.length) return;
  const p = insertVolunteerEvents(engine, rows).catch(() => {
    /* best-effort telemetry — never surfaces */
  });
  pendingVolunteerEventWrites.add(p);
  void p.finally(() => pendingVolunteerEventWrites.delete(p));
}

/** Drain pending event writes (bounded). Same snapshot semantics as last-retrieved. */
export async function awaitPendingVolunteerEventWrites(
  timeoutMs = 5_000,
): Promise<{ unfinished: number }> {
  if (pendingVolunteerEventWrites.size === 0) return { unfinished: 0 };
  const snapshot = Array.from(pendingVolunteerEventWrites);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const drain = Promise.allSettled(snapshot).then(() => 'drained' as const);
  const outcome = await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    const unfinished = pendingVolunteerEventWrites.size;
    // Drop the snapshot so a long-lived process (`gbrain watch`) doesn't
    // accumulate references to forever-pending work (last-retrieved C1).
    for (const p of snapshot) pendingVolunteerEventWrites.delete(p);
    return { unfinished };
  }
  return { unfinished: 0 };
}

// Registered in the enqueue-owning module (background-work contract): module
// not imported ⇒ nothing enqueued ⇒ nothing to drain. Order 4 — after facts /
// last-retrieved / search-cache / eval-capture; bare INSERTs, no abort.
registerBackgroundWorkDrainer({
  name: 'volunteer-events',
  order: 4,
  drain: (ms) => awaitPendingVolunteerEventWrites(ms),
});

/** Test seam — clears the pending set so each test starts clean. */
export function _resetPendingVolunteerEventWritesForTests(): void {
  pendingVolunteerEventWrites.clear();
}

/** Test seam — peek the current pending count. */
export function _peekPendingVolunteerEventWritesForTests(): number {
  return pendingVolunteerEventWrites.size;
}

/**
 * 90-day GC, called from the dream cycle's purge phase (mirrors
 * purgeStaleCheckpoints). Best-effort: returns 0 on any failure (pre-v117
 * brains have no table yet).
 */
export async function purgeStaleVolunteerEvents(
  engine: BrainEngine,
  ttlDays = VOLUNTEER_EVENTS_TTL_DAYS,
): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ count: string | number }>(
      `WITH deleted AS (
         DELETE FROM context_volunteer_events
         WHERE volunteered_at < now() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(ttlDays)],
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
