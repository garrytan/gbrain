import { jsonBytes } from './digest.ts';

/** The smallest terminal reservation an admission takes; the receipt is sized down once it settles (true-up). */
export const RECEIPT_RESERVATION_FLOOR = 16_384;
/** Slack a trued-up receipt keeps while it can still change (effect re-arms, redaction markers). */
export const RECEIPT_HEADROOM_BYTES = 4096;
/** Slack a compacted receipt keeps: the 1 KiB compaction always kept (a compacted put_page measures about 3.9 KB). */
export const COMPACTED_HEADROOM_BYTES = 1024;
/** Space an admission reserves beyond its intent and authority: the outcome, error, effect rows and headroom a completion may add. */
export const RECEIPT_COMPLETION_BYTES = 12_288;
/** Bytes one effect row holds on its receipt; the SQL twin of `effectBytes`. */
export const EFFECT_BYTES_SQL = 'octet_length(data::text)+octet_length(kind)+1024';

/**
 * What an admission reserves: the serialized intent and authority the receipt
 * retains until compaction, plus RECEIPT_COMPLETION_BYTES, never below the
 * floor, plus a caller's `extra` (edit_page's diff). A 100 KB page body
 * reserves its 100 KB, so the counters never hold less than the row keeps.
 */
export function receiptReservation(fields: { intent?: unknown; authority?: unknown }, extra = 0): number {
  const json = (value: unknown) => value === null || value === undefined ? 0 : jsonBytes(value);
  return reservationForRetained(json(fields.intent) + json(fields.authority), extra);
}
/** The same reservation from the retained bytes alone (a sync preflight estimates them from file sizes before it builds intents). */
export function reservationForRetained(retained: number, extra = 0): number {
  return Math.max(RECEIPT_RESERVATION_FLOOR, retained + RECEIPT_COMPLETION_BYTES) + extra;
}

/** The receipt fields that stay on the row, by name. */
export interface ReceiptBytesFields {
  intent?: unknown;
  authority?: unknown;
  outcome?: unknown;
  error_message?: string | null;
  error_detail?: unknown;
  client_request_id?: string | null;
}

/**
 * The bytes a finished receipt really keeps, from an explicit field list. At
 * `terminal` it counts the intent, authority, outcome, error message, error
 * detail, client request id and `effects` (already summed with
 * `EFFECT_BYTES_SQL`), plus `RECEIPT_HEADROOM_BYTES`; at `compacted` the
 * intent and error message are gone and the slack is `COMPACTED_HEADROOM_BYTES`.
 */
export function retainedReceiptBytes(row: ReceiptBytesFields, opts: { stage: 'terminal' | 'compacted'; effects?: number }): number {
  const json = (value: unknown) => value === null || value === undefined ? 0 : jsonBytes(value);
  const kept = json(row.authority) + json(row.outcome) + json(row.error_detail) + Buffer.byteLength(row.client_request_id ?? '');
  const dropped = opts.stage === 'terminal' ? json(row.intent) + Buffer.byteLength(row.error_message ?? '') : 0;
  return kept + dropped + (opts.effects ?? 0) + (opts.stage === 'terminal' ? RECEIPT_HEADROOM_BYTES : COMPACTED_HEADROOM_BYTES);
}

/** Config row counting true-up decrements clamped at a counter below the delta (counter drift); doctor reports it. */
export const TRUE_UP_CLAMPED_KEY = 'persistence.true_up.clamped';
/** A `clamped` CTE adding the clamp count `countSql` selects to `TRUE_UP_CLAMPED_KEY`; it writes nothing when no decrement was clamped. */
export function TRUE_UP_CLAMP_SQL(countSql: string): string {
  return `clamped AS (INSERT INTO config(key,value) SELECT '${TRUE_UP_CLAMPED_KEY}',k.n::text FROM (${countSql}) AS k(n) WHERE k.n>0
      ON CONFLICT (key) DO UPDATE SET value=(CASE WHEN config.value ~ '^[0-9]+$' THEN config.value::bigint ELSE 0 END+EXCLUDED.value::bigint)::text)`;
}
