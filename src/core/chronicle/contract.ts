/**
 * Life Chronicle automatic extraction contract (#5876): the ledger columns,
 * the phase bounds and the `chronicle` cycle-phase result. The reason codes
 * and the `chronicle_backstop` receipt live in reasons.ts (the one table);
 * the config keys and defaults live in config.ts.
 *
 * Lifecycle:
 *   1. A coordinated page publication (put_page, capture, edit_page,
 *      restore_page, revert_version, managed sync and connector imports)
 *      records one `chronicle_page_state` row for the published content in
 *      the same transaction (`pending` or `skipped` + reason) and returns the
 *      `chronicle_backstop` receipt hint. Unmanaged brains have no write
 *      decision; the phase scans their pages directly.
 *   2. The global `chronicle` cycle phase claims settled `pending` rows whose
 *      content is still live, takes a rolling daily reservation, runs the
 *      judge under a BudgetTracker scope, publishes events, reconciles the
 *      previous generation and records the outcome on the row.
 *   3. `gbrain chronicle-backfill` records `pending` rows with
 *      trigger='backfill' (exempt from the daily limit and recency rule);
 *      the same phase executes them.
 */
import { CHRONICLE_RUN_NOW_ARGV, type ChronicleReasonCode } from './reasons.ts';
import type { Action } from '../agent-output.ts';
import type { ChronicleDropCounts } from './extract-events.ts';

/**
 * The ledger key includes it, so a bump makes already-extracted content new again: the phase's
 * discovery re-decides pages changed since activation (unmanaged brains judge the recent ones under
 * the daily limit; managed brains record `no_write_decision`) and backfill re-queues the rest on request.
 * 2: same-day event slug disambiguation (event-identity.ts) and ended-invite projection (invite-projection.ts).
 */
export const CHRONICLE_EXTRACTOR_VERSION = 2;

/** Ledger table and its columns (migration `chronicle_page_state`). */
export const CHRONICLE_LEDGER_TABLE = 'chronicle_page_state';
/** Rolling daily reservations: one row per automatic judge call (attempts and retries count). */
export const CHRONICLE_RESERVATION_TABLE = 'chronicle_judge_reservations';

export type ChronicleLedgerState = 'pending' | 'skipped' | 'extracted' | 'failed';
export type ChronicleTrigger = 'auto' | 'backfill';

export interface ChronicleLedgerRow {
  source_id: string;
  page_id: number;
  content_hash: string;
  extractor_version: number;
  slug: string;
  state: ChronicleLedgerState;
  /** A `ChronicleReasonCode` from reasons.ts. An extracted row carries one only when it published no events:
   *  `no_events`, or `future_dated` / `date_imprecise` when every proposed event was dropped. Null on pending
   *  and on extracted-with-events. */
  reason: string | null;
  trigger: ChronicleTrigger;
  /** Writer of the decided revision (`persistence_requests.principal_*`); null on unmanaged scans and backfill. */
  principal_kind: string | null;
  principal_id: string | null;
  request_id: string | null;
  /** `processingOptions.noExtract` of the sync intent at decision time. */
  no_extract: boolean;
  attempts: number;
  /** Earliest next judge attempt for a failed row with backoff; null = not scheduled. */
  next_attempt_at: Date | string | null;
  /** Recorded spend in USD, summed across attempts (null when unpriced or not run). */
  cost_usd: number | null;
  /** #6199: attempts whose spend cost_usd already includes (a replayed completion adds nothing). */
  cost_attempts?: number[];
  /** #6199: the `chronicle-backfill --max-usd` campaign that queued this row; null outside a capped backfill.
   *  Executors run a stamped row under its stamped cap, attempts and pricing policy, never current settings. */
  campaign_id?: string | null;
  /** Per-attempt spend cap stamped at queue time (NUMERIC; a string on Postgres). */
  attempt_cap_usd?: number | string | null;
  /** Maximum judge attempts stamped at queue time; null = CHRONICLE_DEFAULTS.maxAttempts. */
  max_attempts?: number | null;
  /** 'enforced' = the stamped cap applies even if the model loses its price or settings change. */
  pricing_policy?: string | null;
  /** The campaign's --max-usd. */
  campaign_max_usd?: number | string | null;
  /** The judge model had no price, so cost_usd is unknown. */
  unpriced: boolean;
  /** Event page slugs this content produced (the generation reconciliation reads). */
  event_slugs: string[];
  /** content_hash of each event page as the extractor wrote it, parallel to event_slugs. An event whose
   *  live hash is no longer in any row of its depth page was edited by an operator and is never touched. */
  event_hashes: string[];
  decided_at: Date | string;
  updated_at: Date | string;
}

/** Phase bounds. The config knobs and their defaults live in config.ts (`CHRONICLE_NUMERIC_KEYS`). */
export const CHRONICLE_DEFAULTS = {
  /** Items one phase run judges at most (automatic + backfill). */
  maxItemsPerRun: 50,
  /** Wall-time bound of one phase run. */
  maxRunMs: 10 * 60_000,
  /** Judge attempts before a failed row stops retrying on its own. */
  maxAttempts: 5,
} as const;

/** The run-now command line, rendered from the one argv in reasons.ts. */
export const RUN_NOW_COMMAND = CHRONICLE_RUN_NOW_ARGV.join(' ');

/** `chronicle` cycle-phase result details. */
export interface ChronicleRunDetails {
  /** Why the phase made no calls at all, when it did not run. */
  reason?: 'auto_chronicle_off' | 'no_chat_provider' | 'no_pricing' | 'no_database' | 'nothing_pending';
  dry_run: boolean;
  sources: number;
  /** Rows the run looked at (claimed or skipped). */
  candidates: number;
  judged: number;
  extracted: number;
  /** Judged rows that published no events (the judge found none, or every proposal was dropped). */
  no_events: number;
  failed: number;
  /** Count per reason of rows skipped, failed or extracted without events in this run. */
  reasons: Partial<Record<ChronicleReasonCode, number>>;
  events_written: number;
  events_retired: number;
  /** Proposed events refused before publication, by reason (`future_dated`, `date_imprecise`); never written. */
  events_dropped: ChronicleDropCounts;
  /** Pending automatic rows left for the next run because the daily limit is used up. */
  deferred_daily_limit: number;
  daily_limit: number;
  daily_remaining: number;
  spent_usd: number;
  unpriced_calls: number;
  max_items: number;
  per_source: Record<string, { candidates: number; judged: number }>;
  next_command?: string;
  /** The reason table's fix when the phase could not run (no chat provider). */
  fix?: Action;
}
