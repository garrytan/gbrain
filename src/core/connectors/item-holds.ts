/**
 * Connector item holds (fix wave 4, #5752 and #5740): one shared helper for
 * the Gmail and GitHub connectors, on managed and unmanaged brains alike.
 *
 * A connector item that fails with an item-scoped error on 3 consecutive
 * attempted runs is held: it is recorded in the connector's cursor state
 * (`item_holds`) and the sweep's cursor or floor may advance past it. A held
 * item is never skipped silently; `gbrain sources status`, the doctor check
 * `connector_held_items`, the sync summary and `gbrain waiting` all show it,
 * and `gbrain sources retry-held <id>` re-attempts it.
 *
 * The thresholds are fixed and documented (docs/guides/google-connect.md and
 * docs/guides/github-source.md): 3 runs, the circuit breaker below, a
 * transient backoff of 1 h, 6 h, 24 h and then daily, reconsidered for 7 days,
 * and at most 100 holds per source.
 *
 * Counting rules:
 *  - every connector error is normalized by `classifyConnectorError`; only
 *    item-scoped errors count, never source-scoped errors or rate limits;
 *  - each item counts at most once per run;
 *  - "consecutive" means consecutive runs that attempted the item at the same
 *    upstream version; a run that skips the item for backoff neither counts
 *    nor resets it;
 *  - a run with at least 5 distinct attempted items is a source outage, and
 *    counts no item failure, when at least half of the attempted items failed
 *    transiently, or when at least 5 items and at least half of the attempted
 *    items failed with the same error code.
 *
 * A run's failures and successes are merged into the stored holds only by
 * `finish()`; checkpoints saved during the run carry the holds the run began
 * with, so a cursor never passes an item that is not already held.
 */
import { OperationError } from '../ops/contract.ts';
import { isCredentialError } from '../creds/errors.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';

/** Hold records are stored in jsonb: keys and values are well-formed, NUL-free text (#5752). */
const clean = (value: string): string => sanitizeForJsonb(value);
const cleanOrNull = (value: string | null | undefined): string | null => (typeof value === 'string' ? clean(value) : value ?? null);

export const HOLD_THRESHOLD_RUNS = 3;
export const HOLD_BREAKER_MIN_ITEMS = 5;
export const HOLD_BACKOFF_MS: readonly number[] = [3_600_000, 6 * 3_600_000, 24 * 3_600_000];
export const HOLD_DAILY_MS = 24 * 3_600_000;
export const HOLD_TRANSIENT_WINDOW_MS = 7 * 24 * 3_600_000;
export const HOLD_CAP = 100;

export type HoldErrorScope = 'source' | 'item' | 'rate_limit';
export type HoldClass = 'content' | 'transient';

export interface ClassifiedConnectorError {
  code: string;
  scope: HoldErrorScope;
  class: HoldClass;
  message: string;
}

export interface ItemHoldMeta {
  /** Gmail sender and subject, GitHub title; null when the failing run did not have it. */
  sender: string | null;
  subject: string | null;
  title: string | null;
  /** Gmail newest internal date or GitHub `updated_at` (ISO); null = unknown. */
  upstream_at: string | null;
}

export interface ItemHoldRecord {
  key: string;
  state: 'failing' | 'held';
  code: string;
  class: HoldClass;
  message: string;
  upstream_version: string | null;
  first_failed_at: string;
  last_failed_at: string;
  attempts: number;
  held_at: string | null;
  /** Transient holds only: when the item is next re-attempted automatically. */
  next_attempt_at: string | null;
  reconsiderations: number;
  meta: ItemHoldMeta;
  /** Managed brains: the page slug and the failed receipt kept for audit and `retry-held`. */
  slug: string | null;
  request_id: string | null;
  /** A connector-specific locator for re-attempting an item the listing no longer returns (GitHub: `issue` or `pr`). */
  ref: string | null;
  /** Carried from the pre-wave-4 Gmail poison ledger (`gmail_fail_counts`). */
  legacy: boolean;
}

export interface ItemHoldsState {
  version: 1;
  items: Record<string, ItemHoldRecord>;
}

const SOURCE_CODES = new Set([
  'writer_coordinator_required', 'owner_unavailable', 'database_contention', 'writer_lock_unavailable', 'writer_pool_capacity',
  'queue_capacity', 'recovery_required', 'write_pending', 'source_changed', 'permission_denied', 'scope_denied',
  'writer_registration_required', 'writer_identity_invalid', 'writer_not_initialized', 'writer_upgrade_required',
  'writer_not_quiesced', 'writer_admin_locked', 'connector_account_changed', 'connector_intent_outdated',
  'unsupported_mutation_protocol', 'cancelled', 'write_claim_lost', 'lock_stolen', 'statement_timeout', 'lock_timeout',
  'connector_holds_exhausted', 'config', 'auth',
]);
const CONTENT_CODES = new Set([
  'invalid_params', 'invalid_connector_text', 'request_too_large', 'page_identity_changed', 'take_row_collision',
  'connector_fence_below_timeline', 'malformed', 'http_4xx',
]);
const POSTGRES_SOURCE_CODES: Record<string, string> = {
  '57014': 'statement_timeout', '55P03': 'lock_timeout', '40001': 'database_contention', '40P01': 'database_contention',
  '53300': 'database_contention', '57P01': 'database_contention', '08006': 'database_contention', '08003': 'database_contention',
};

/**
 * The one classification table: normalizes an error raised while processing a
 * single connector item into a code, a scope and a class. Callers classify
 * only inside item processing; an error raised before an item is selected is
 * source-scoped by construction and never reaches the holds.
 */
export function classifyConnectorError(error: unknown): ClassifiedConnectorError {
  const message = error instanceof Error ? error.message : String(error);
  const named = (error as { name?: string } | null)?.name;
  if (named === 'LockStolenError') return { code: 'lock_stolen', scope: 'source', class: 'transient', message };
  if (named === 'ConnectorWaitBudgetStop') return { code: 'write_pending', scope: 'source', class: 'transient', message };
  if (isCredentialError(error)) {
    if (error.code === 'rate_limited') return { code: 'rate_limited', scope: 'rate_limit', class: 'transient', message };
    if (error.code !== 'upstream') return { code: error.code, scope: 'source', class: 'transient', message };
    const status = Number(message.match(/HTTP (\d{3})/)?.[1] ?? NaN);
    if (status === 401 || status === 403) return { code: 'auth', scope: 'source', class: 'transient', message };
    if (status >= 400 && status < 500) return { code: 'http_4xx', scope: 'item', class: 'content', message };
    return { code: Number.isFinite(status) ? 'http_5xx' : 'network', scope: 'item', class: 'transient', message };
  }
  if (error instanceof OperationError) {
    const code = String(error.writeError && error.code === 'storage_error' ? error.writeError : error.code);
    if (code === 'rate_limited') return { code, scope: 'rate_limit', class: 'transient', message };
    if (SOURCE_CODES.has(code)) return { code, scope: 'source', class: 'transient', message };
    return { code, scope: 'item', class: CONTENT_CODES.has(code) ? 'content' : 'transient', message };
  }
  const pgCode = (error as { code?: unknown } | null)?.code;
  if (typeof pgCode === 'string' && POSTGRES_SOURCE_CODES[pgCode]) return { code: POSTGRES_SOURCE_CODES[pgCode], scope: 'source', class: 'transient', message };
  const http = message.match(/API HTTP (\d{3})/);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || /not rate-limited/.test(message)) return { code: 'auth', scope: 'source', class: 'transient', message };
    if (status === 429 || status === 403) return { code: 'rate_limited', scope: 'rate_limit', class: 'transient', message };
    if (status >= 400 && status < 500) return { code: 'http_4xx', scope: 'item', class: 'content', message };
    return { code: 'http_5xx', scope: 'item', class: 'transient', message };
  }
  if (/unreachable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket/i.test(message)) return { code: 'network', scope: 'item', class: 'transient', message };
  if (/malformed/i.test(message)) return { code: 'malformed', scope: 'item', class: 'content', message };
  return { code: 'unknown', scope: 'item', class: 'transient', message };
}

export const emptyItemHolds = (): ItemHoldsState => ({ version: 1, items: {} });

function normalizeHolds(value: unknown): ItemHoldsState {
  const stored = value as Partial<ItemHoldsState> | null | undefined;
  if (!stored || stored.version !== 1 || typeof stored.items !== 'object' || stored.items === null) return emptyItemHolds();
  return { version: 1, items: structuredClone(stored.items) };
}

/** Held records only (not items still counting toward the threshold). */
export function heldItems(state: unknown): ItemHoldRecord[] {
  return Object.values(normalizeHolds(state).items).filter(record => record.state === 'held')
    .sort((a, b) => a.first_failed_at.localeCompare(b.first_failed_at) || a.key.localeCompare(b.key));
}

const unknownMeta = (): ItemHoldMeta => ({ sender: null, subject: null, title: null, upstream_at: null });

/**
 * Carries the pre-wave-4 Gmail ledger (`thread id -> consecutive failures`)
 * into hold records: 3 or more becomes a hold labeled as legacy with unknown
 * metadata; fewer keeps counting from where it stopped.
 */
export function carryLegacyFailCounts(stored: unknown, legacy: Record<string, number> | undefined, keyOf: (id: string) => string, nowIso: string): ItemHoldsState {
  const state = normalizeHolds(stored);
  if (!legacy) return state;
  for (const [id, count] of Object.entries(legacy)) {
    const key = keyOf(id);
    if (state.items[key] || !Number.isFinite(count) || count <= 0) continue;
    const held = count >= HOLD_THRESHOLD_RUNS;
    state.items[key] = { key, state: held ? 'held' : 'failing', code: 'legacy_poison', class: 'content',
      message: 'Carried from the pre-upgrade Gmail poison ledger; the failure reason was not recorded.', upstream_version: null,
      first_failed_at: nowIso, last_failed_at: nowIso, attempts: Math.min(count, HOLD_THRESHOLD_RUNS), held_at: held ? nowIso : null,
      next_attempt_at: null, reconsiderations: 0, meta: unknownMeta(), slug: null, request_id: null, ref: null, legacy: true };
  }
  return state;
}

interface RunFailure { classified: ClassifiedConnectorError; version: string | null; meta: Partial<ItemHoldMeta>; slug: string | null; requestId: string | null; ref: string | null }

export interface ItemHoldsFinish {
  state: ItemHoldsState;
  /** True when the run tripped the circuit breaker and counted no item failure. */
  outage: boolean;
  /** Keys held by this run (newly held). */
  newlyHeld: string[];
  /** Set when holding more items would exceed HOLD_CAP; the caller must not advance its cursor. */
  exhausted: boolean;
}

/**
 * One connector run's view of the holds. Construct with the holds the cursor
 * state carries; `full` (`sync --full`) starts from an empty set.
 */
export class ItemHoldsRun {
  private readonly state: ItemHoldsState;
  private readonly attempted = new Set<string>();
  private readonly failures = new Map<string, RunFailure>();
  private readonly succeeded = new Set<string>();
  private readonly retryKeys: ReadonlySet<string>;

  constructor(stored: unknown, private readonly opts: { now?: () => number; full?: boolean; retryKeys?: Iterable<string> } = {}) {
    this.state = normalizeHolds(stored);
    // `sync --full` resets the holds by re-attempting every held item once: a success clears it; a
    // failure keeps it held (the cursor may already be past it, so demoting or forgetting the record
    // would leave the item unimported and invisible).
    this.retryKeys = new Set([...(opts.retryKeys ?? []), ...(opts.full ? this.heldKeys() : [])]);
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  /** The holds this run started with (what mid-run checkpoints carry). */
  initial(): ItemHoldsState { return structuredClone(this.state); }

  record(key: string): ItemHoldRecord | undefined { return this.state.items[clean(key)]; }

  /** True when the item is currently held (whatever this run decides). */
  isHeld(key: string): boolean { return this.state.items[clean(key)]?.state === 'held'; }

  /**
   * False when the item is held and nothing re-admits it this run: no
   * `retry-held` request, no upstream change, and no transient
   * reconsideration due. A false answer is a skip that neither counts nor
   * resets the item's count.
   */
  shouldAttempt(key: string, upstreamVersion: string | null = null): boolean {
    key = clean(key);
    upstreamVersion = cleanOrNull(upstreamVersion);
    const record = this.state.items[key];
    if (!record || record.state !== 'held') return true;
    if (this.retryKeys.has(key)) return true;
    if (upstreamVersion !== null && record.upstream_version !== null && upstreamVersion !== record.upstream_version) return true;
    if (record.class === 'transient' && record.next_attempt_at && this.now() >= Date.parse(record.next_attempt_at)) return true;
    return false;
  }

  /** Every held key this run will skip, for connectors that must remove held items from a work list. */
  heldKeys(): string[] { return Object.values(this.state.items).filter(record => record.state === 'held').map(record => record.key); }

  succeed(key: string): void {
    key = clean(key);
    this.attempted.add(key);
    this.failures.delete(key);
    this.succeeded.add(key);
  }

  /** An item deleted upstream drops its count or hold. */
  drop(key: string): void {
    key = clean(key);
    this.failures.delete(key);
    this.succeeded.add(key);
  }

  /**
   * Records one failure of an item. Returns the classification so the caller
   * can rethrow source-scoped errors; rate limits and source-scoped errors are
   * never recorded.
   */
  fail(key: string, error: unknown, detail: { version?: string | null; meta?: Partial<ItemHoldMeta>; slug?: string | null; requestId?: string | null; ref?: string | null } = {}): ClassifiedConnectorError {
    const classified = classifyConnectorError(error);
    if (classified.scope !== 'item') return classified;
    key = clean(key);
    this.attempted.add(key);
    this.succeeded.delete(key);
    const requestId = detail.requestId ?? (error instanceof OperationError ? error.writeRequest?.request_id ?? null : null);
    const meta = Object.fromEntries(Object.entries(detail.meta ?? {}).map(([k, v]) => [k, cleanOrNull(v)])) as Partial<ItemHoldMeta>;
    if (!this.failures.has(key)) this.failures.set(key, { classified: { ...classified, message: clean(classified.message) }, version: cleanOrNull(detail.version),
      meta, slug: cleanOrNull(detail.slug), requestId, ref: cleanOrNull(detail.ref) });
    return classified;
  }

  /** The run's pending hold changes merged into the stored holds, with the circuit breaker applied. */
  finish(): ItemHoldsFinish {
    const state = structuredClone(this.state);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    for (const key of this.succeeded) delete state.items[key];
    const attempted = this.attempted.size;
    const failures = [...this.failures.entries()];
    const transient = failures.filter(([, failure]) => failure.classified.class === 'transient').length;
    const byCode = new Map<string, number>();
    for (const [, failure] of failures) byCode.set(failure.classified.code, (byCode.get(failure.classified.code) ?? 0) + 1);
    const sameCode = Math.max(0, ...byCode.values());
    const outage = attempted >= HOLD_BREAKER_MIN_ITEMS && (transient * 2 >= attempted || sameCode >= HOLD_BREAKER_MIN_ITEMS && sameCode * 2 >= attempted);
    if (outage) return { state, outage, newlyHeld: [], exhausted: false };
    const newlyHeld: string[] = [];
    let heldCount = Object.values(state.items).filter(record => record.state === 'held').length;
    let exhausted = false;
    for (const [key, failure] of failures) {
      const previous = state.items[key];
      const sameVersion = !previous || previous.upstream_version === null || failure.version === null || previous.upstream_version === failure.version;
      const meta: ItemHoldMeta = { ...unknownMeta(), ...(previous?.meta ?? {}), ...Object.fromEntries(Object.entries(failure.meta).filter(([, v]) => v !== undefined && v !== null)) };
      const base = { key, code: failure.classified.code, class: failure.classified.class, message: failure.classified.message.slice(0, 500),
        upstream_version: failure.version ?? previous?.upstream_version ?? null, last_failed_at: nowIso, meta,
        slug: failure.slug ?? previous?.slug ?? null, request_id: failure.requestId ?? previous?.request_id ?? null, ref: failure.ref ?? previous?.ref ?? null, legacy: false };
      if (previous?.state === 'held') {
        const reconsiderations = previous.reconsiderations + 1;
        const heldAt = Date.parse(previous.held_at ?? nowIso);
        const backoff = HOLD_BACKOFF_MS[reconsiderations] ?? HOLD_DAILY_MS;
        const next = base.class === 'transient' && nowMs + backoff <= heldAt + HOLD_TRANSIENT_WINDOW_MS ? new Date(nowMs + backoff).toISOString() : null;
        state.items[key] = { ...previous, ...base, attempts: previous.attempts + 1, next_attempt_at: next, reconsiderations };
        continue;
      }
      const attempts = previous && sameVersion ? previous.attempts + 1 : 1;
      if (attempts < HOLD_THRESHOLD_RUNS) {
        state.items[key] = { ...base, state: 'failing', first_failed_at: previous && sameVersion ? previous.first_failed_at : nowIso,
          attempts, held_at: null, next_attempt_at: null, reconsiderations: 0 };
        continue;
      }
      if (heldCount >= HOLD_CAP) { exhausted = true; continue; }
      heldCount++;
      newlyHeld.push(key);
      state.items[key] = { ...base, state: 'held', first_failed_at: previous?.first_failed_at ?? nowIso, attempts, held_at: nowIso,
        next_attempt_at: base.class === 'transient' ? new Date(nowMs + HOLD_BACKOFF_MS[0]).toISOString() : null, reconsiderations: 0 };
    }
    return { state, outage, newlyHeld, exhausted };
  }
}

/** The typed refusal a run raises when holding another item would exceed HOLD_CAP. */
export function holdsExhaustedError(sourceId: string): OperationError {
  const error = new OperationError('connector_holds_exhausted',
    `Source "${sourceId}" already holds ${HOLD_CAP} items; this run did not advance its cursor.`,
    `Review the held items with: gbrain sources status ${sourceId}; re-attempt them with: gbrain sources retry-held ${sourceId}`,
    'docs/guides/write-refusals.md#connector-holds-exhausted');
  error.writeError = 'connector_holds_exhausted';
  return error;
}

export const retryHeldCommand = (sourceId: string): string => `gbrain sources retry-held ${sourceId}`;
