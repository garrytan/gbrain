/**
 * The notification outbox (table `notification_outbox`, migration v333): durable, retried, at-most-once-queued
 * deliveries. A row is unique per (sink, event, subject), so emitting the same event twice queues it once. A
 * dispatcher claims due rows with a lease (a crashed dispatcher's rows come back when the lease lapses), hands each
 * to its sink, and records the outcome: delivered (with what the sink returned), skipped (nothing to do), or a
 * retry with exponential backoff until MAX_ATTEMPTS, then failed.
 */
import type { BrainEngine } from '../engine.ts';

export const MAX_ATTEMPTS = 10;
const LEASE_SECONDS = 120;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 3600;
const ERROR_MAX_CHARS = 500;

export type OutboxStatus = 'pending' | 'delivered' | 'skipped' | 'failed';


export interface OutboxRow {
  id: number;
  sink: string;
  event: string;
  subject: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  delivery: Record<string, unknown> | null;
  created_at: string | Date;
}

const jsonObject = (value: unknown): Record<string, unknown> | null => {
  if (value == null) return null;
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }
  return typeof value === 'object' ? value as Record<string, unknown> : null;
};

function normalize(row: OutboxRow): OutboxRow {
  return { ...row, id: Number(row.id), attempts: Number(row.attempts), payload: jsonObject(row.payload) ?? {}, delivery: jsonObject(row.delivery) };
}

/** Queue one delivery; false when the same (sink, event, subject) is already queued or done. */
export async function enqueue(engine: BrainEngine, row: { sink: string; event: string; subject: string; payload: Record<string, unknown> }): Promise<boolean> {
  const inserted = await engine.executeRaw<{ id: number }>(
    `INSERT INTO notification_outbox (sink, event, subject, payload)
     VALUES ($1, $2, $3, $4::text::jsonb)
     ON CONFLICT (sink, event, subject) DO NOTHING
     RETURNING id`,
    [row.sink, row.event, row.subject, JSON.stringify(row.payload)],
  );
  return inserted.length > 0;
}

/**
 * Claim up to `limit` due rows (oldest first) under a lease. Rows of a sink not in `sinks` are left alone, so a host
 * that cannot deliver a sink (no credential there) never burns its attempts.
 */
export async function claimDue(engine: BrainEngine, sinks: string[], limit = 20): Promise<OutboxRow[]> {
  if (sinks.length === 0) return [];
  const rows = await engine.executeRaw<OutboxRow>(
    `UPDATE notification_outbox SET lease_until = now() + make_interval(secs => $3), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_outbox
         WHERE status = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
           AND sink = ANY($1::text[])
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING id, sink, event, subject, payload, status, attempts, last_error, delivery, created_at`,
    [sinks, limit, LEASE_SECONDS],
  );
  return rows.map(normalize).sort((a, b) => a.id - b.id);
}

export async function markDelivered(engine: BrainEngine, id: number, delivery: Record<string, unknown> | null): Promise<void> {
  await engine.executeRaw(
    `UPDATE notification_outbox SET status = 'delivered', delivered_at = now(), lease_until = NULL, last_error = NULL,
            delivery = COALESCE($2::text::jsonb, delivery)
      WHERE id = $1`,
    [id, delivery ? JSON.stringify(delivery) : null],
  );
}

export async function markSkipped(engine: BrainEngine, id: number, reason: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE notification_outbox SET status = 'skipped', lease_until = NULL, last_error = $2 WHERE id = $1`,
    [id, reason.slice(0, ERROR_MAX_CHARS)],
  );
}

/** Record a failed attempt: retry after backoff, or give up (status failed) at MAX_ATTEMPTS or when not retryable. */
export async function markFailed(engine: BrainEngine, row: Pick<OutboxRow, 'id' | 'attempts'>, error: string, retryable = true): Promise<OutboxStatus> {
  const give_up = !retryable || row.attempts >= MAX_ATTEMPTS;
  const delay = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, row.attempts - 1));
  await engine.executeRaw(
    `UPDATE notification_outbox
        SET status = $2, lease_until = NULL, last_error = $3, next_attempt_at = now() + make_interval(secs => $4)
      WHERE id = $1`,
    [row.id, give_up ? 'failed' : 'pending', error.slice(0, ERROR_MAX_CHARS), delay],
  );
  return give_up ? 'failed' : 'pending';
}

/** What a sink recorded for an earlier event on the same subject (e.g. the Slack message a decision edits). */
export async function deliveryOf(engine: BrainEngine, sink: string, event: string, subject: string): Promise<{ status: OutboxStatus; delivery: Record<string, unknown> | null } | null> {
  const rows = await engine.executeRaw<{ status: OutboxStatus; delivery: unknown }>(
    'SELECT status, delivery FROM notification_outbox WHERE sink = $1 AND event = $2 AND subject = $3', [sink, event, subject]);
  return rows[0] ? { status: rows[0].status, delivery: jsonObject(rows[0].delivery) } : null;
}

/** Store a sink's delivery record on a row it did not just claim (e.g. after a later update). */
export async function setDelivery(engine: BrainEngine, sink: string, event: string, subject: string, delivery: Record<string, unknown>): Promise<void> {
  await engine.executeRaw('UPDATE notification_outbox SET delivery = $4::text::jsonb WHERE sink = $1 AND event = $2 AND subject = $3',
    [sink, event, subject, JSON.stringify(delivery)]);
}

export interface OutboxCounts { sink: string; event: string; status: OutboxStatus; n: number }

export async function outboxCounts(engine: BrainEngine): Promise<OutboxCounts[]> {
  const rows = await engine.executeRaw<OutboxCounts>(
    'SELECT sink, event, status, count(*)::int AS n FROM notification_outbox GROUP BY sink, event, status ORDER BY sink, event, status');
  return rows.map(r => ({ ...r, n: Number(r.n) }));
}

/** Most recent failures, for `notify status`. */
export async function recentFailures(engine: BrainEngine, limit = 10): Promise<Array<Pick<OutboxRow, 'id' | 'sink' | 'event' | 'subject' | 'attempts' | 'last_error' | 'status'>>> {
  const rows = await engine.executeRaw<OutboxRow>(
    `SELECT id, sink, event, subject, attempts, last_error, status FROM notification_outbox
      WHERE last_error IS NOT NULL AND status IN ('pending', 'failed') ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(r => ({ ...r, id: Number(r.id), attempts: Number(r.attempts) }));
}

/** Put failed rows back in the queue (`notify retry`). */
export async function requeueFailed(engine: BrainEngine, sink?: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE notification_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), lease_until = NULL
      WHERE status = 'failed' AND ($1::text IS NULL OR sink = $1) RETURNING id`, [sink ?? null]);
  return rows.length;
}
