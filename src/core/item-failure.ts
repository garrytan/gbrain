/**
 * One bad item never stops the unit (GBRA-130, the class after #6948).
 *
 * A per-item loop (a page in a maintenance phase, a file in an import, a row
 * in a backfill, an item in a repair kind) classifies each failure with
 * `classifyItemFailure`: run-scoped failures stop the unit, item-scoped ones are
 * recorded for that item and the loop continues, and an accepted, still
 * pending write is progress, never a failure. `ItemRun` adds the circuit
 * breaker every adopting loop needs: when most attempted items fail, or many
 * fail with one code, or none succeeds, the failure is systemic and the run
 * stops with `item_failures_systemic` instead of holding every item.
 *
 * The classification order is fixed: abort, run-level error classes, an
 * accepted pending receipt, the operation code (with its write error), the
 * SQLSTATE, the errno, the `cause` chain, and then the default. Unknown
 * failures are item-scoped and transient, so they never hold an item on their
 * own and always count toward the breaker. The connector holds
 * (connectors/item-holds.ts) keep their own source/rate-limit vocabulary.
 *
 * Every loop that adopts this names its site in `ISOLATE_SITES`; the
 * pathological suite (test/pathological/) must cover each site, which
 * test/pathological/sites.test.ts checks.
 */
import { OperationError, opError } from './ops/contract.ts';
import { CODES } from './error-registry.ts';
import { acceptedPendingReceipt } from './persistence/accepted-pending.ts';
import { providerItemRefusal } from './ai/errors.ts';

/** Every per-item loop that isolates its items, with the inventory row it fixes (reports/GBRA-130-inventory.md). */
export const ISOLATE_SITES = {
  'autopilot.global_maintenance': 'A-10',
  'synthesize.postprocess': 'A-4',
  'synthesize.triage_verdict_cache': 'B-6',
  'backfill.rows': 'A-47',
  'purge.recorded_tombstones': 'A-49',
  'retention.expired_sources': 'A-50',
  'consolidate.buckets': 'A-22',
  'extract_facts.expire_deleted': 'A-21',
  'maintain.cycle_sources': 'A-41',
  'patterns.ground_pages': 'A-23',
  'patterns.ground_timeline_appends': 'A-23',
  'links.extract_stale': 'A-1',
  'repair.apply_items': 'A-9',
  'repair.all_kinds': 'A-45',
  'repair.content_lane_kinds': 'A-46',
  'migration.credential_reseal': 'A-27',
  'transcripts.ingest_session': 'A-2',
  'google.contact': 'A-3',
  'google.calendar_event': 'A-3',
  'migrate_engine.loop_rows': 'A-31',
  'effects.derived_retry_budget': 'A-11',
  'propose_takes.pages': 'A-25',
  'sync.import_files': 'A-18',
  'extract_facts.phantom_redirect': 'A-24',
} as const satisfies Record<string, string>;

export type IsolateSite = keyof typeof ISOLATE_SITES;
export type ItemFailureScope = 'run' | 'item' | 'pending';
export type ItemFailureClass = 'content' | 'transient';

export interface ClassifiedItemFailure {
  code: string;
  scope: ItemFailureScope;
  /** Content: the item itself is refused and will fail the same way until it changes. Transient: it may pass on a later run. */
  class: ItemFailureClass;
  message: string;
  /** An accepted write's request id (scope `pending`), or the failed receipt's. */
  requestId: string | null;
}

/** Codes that mean the writer, the database, the budget or the run itself is unavailable: never one item's fault. */
export const RUN_SCOPED_CODES: ReadonlySet<string> = new Set([
  'aborted', 'lock_stolen', 'budget_exhausted', 'item_failures_systemic', 'schema_behind',
  'writer_coordinator_required', 'owner_unavailable', 'writer_lock_unavailable', 'writer_busy', 'writer_pool_capacity',
  'queue_capacity', 'write_quota_exhausted', 'write_capacity_backpressure', 'maintenance_backpressure', 'database_contention',
  'writer_registration_required', 'writer_identity_invalid', 'writer_not_initialized', 'writer_upgrade_required',
  'writer_not_quiesced', 'writer_admin_locked', 'unsupported_mutation_protocol', 'write_claim_lost', 'connection_lost',
  'permission_denied', 'schema_owner_required', 'scope_denied', 'config', 'auth', 'connector_holds_exhausted', 'transfer_in_progress', 'disk_full',
  'invalid_token', 'insufficient_scope', 'trusted_local_only', 'requires_local_engine', 'not_owner_host', 'host_identity_mismatch',
  'recovery_required', 'cancelled', 'persistence_restart_required', 'writer_regrant_required', 'writer_manifest_rescope_required',
]);

/** Item codes that fail the same way until the item changes. Every other item code is transient. */
export const CONTENT_ITEM_CODES: ReadonlySet<string> = new Set([
  'invalid_params', 'invalid_fence', 'invalid_frontmatter', 'invalid_connector_text', 'request_too_large', 'payload_too_large',
  'page_identity_changed', 'page_not_found', 'page_body_segmented', 'take_row_collision', 'content_rejected', 'purged_content',
  'fact_withdrawn', 'skill_bundle_required', 'source_changed', 'malformed', 'invalid_data', 'unreadable_item',
]);

/** SQLSTATE classes: a failed transaction, a lost or overloaded connection, a missing relation stop the run; data and constraint errors are the row's. */
function sqlstateFailure(state: string): { code: string; scope: 'run' | 'item'; class: ItemFailureClass } | null {
  if (state === '25P02' || state === '40001' || state === '40P01' || state.startsWith('08') || state.startsWith('53') || state.startsWith('57P')
    || state.startsWith('58') || state.startsWith('XX')) return { code: 'database_contention', scope: 'run', class: 'transient' };
  if (state === '42P01' || state === '42703' || state === '42883') return { code: 'schema_behind', scope: 'run', class: 'transient' };
  if (state === '42501') return { code: 'permission_denied', scope: 'run', class: 'transient' };
  if (state.startsWith('28')) return { code: 'auth', scope: 'run', class: 'transient' };
  if (state === '57014') return { code: 'statement_timeout', scope: 'item', class: 'transient' };
  if (state === '55P03') return { code: 'lock_timeout', scope: 'item', class: 'transient' };
  if (state.startsWith('22') || state.startsWith('23') || state === '54000') return { code: 'invalid_data', scope: 'item', class: 'content' };
  return null;
}

const RUN_ERRNOS = new Set(['ENOSPC', 'EMFILE', 'ENFILE', 'EROFS', 'EDQUOT']);
const ITEM_ERRNOS = new Set(['EACCES', 'EPERM', 'ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG', 'EILSEQ']);
const RUN_ERROR_NAMES: Record<string, string> = { AbortError: 'aborted', LockStolenError: 'lock_stolen', BudgetExhausted: 'budget_exhausted' };
/** A model or embedding provider's own failure (the gateway's error classes, an HTTP fetch that failed): never the database connection; a provider outage trips the breaker. */
const AI_ERROR_NAMES = new Set(['AIServiceError', 'AITransientError', 'AIConfigError']);
/** Typed refusals of one item raised as plain errors: content, because the item fails the same way until it or its source changes. */
const ITEM_ERROR_NAMES: Record<string, string> = { PageSourceMissingError: 'unknown_source' };

function classifyOne(error: unknown): ClassifiedItemFailure | null {
  const message = error instanceof Error ? error.message : String(error);
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && RUN_ERROR_NAMES[name]) return { code: RUN_ERROR_NAMES[name]!, scope: 'run', class: 'transient', message, requestId: null };
  if (typeof name === 'string' && ITEM_ERROR_NAMES[name]) return { code: ITEM_ERROR_NAMES[name]!, scope: 'item', class: 'content', message, requestId: null };
  const pending = acceptedPendingReceipt(error);
  if (pending) return { code: 'write_pending', scope: 'pending', class: 'transient', message, requestId: pending.request_id };
  if (error instanceof OperationError) {
    const code = String(error.code === 'storage_error' && error.writeError ? error.writeError : error.canonicalCode);
    const requestId = error.writeRequest?.request_id ?? null;
    if (RUN_SCOPED_CODES.has(code) || (code === 'storage_error' && error.detail === 'database_contention')) {
      return { code, scope: 'run', class: 'transient', message, requestId };
    }
    const registryClass = (CODES as Record<string, { class: string }>)[code]?.class;
    return { code, scope: 'item', class: CONTENT_ITEM_CODES.has(code) || registryClass === 'caller' ? 'content' : 'transient', message, requestId };
  }
  const raw = (error as { code?: unknown } | null)?.code;
  if (typeof raw === 'string' && /^[0-9A-Z]{5}$/.test(raw)) {
    const sql = sqlstateFailure(raw);
    if (sql) return { ...sql, message, requestId: null };
  }
  if (typeof raw === 'string' && RUN_ERRNOS.has(raw)) return { code: 'disk_full', scope: 'run', class: 'transient', message, requestId: null };
  if (typeof raw === 'string' && ITEM_ERRNOS.has(raw)) return { code: 'unreadable_item', scope: 'item', class: 'content', message, requestId: null };
  const refusal = providerItemRefusal(error);
  if (refusal) return { code: refusal, scope: 'item', class: 'content', message, requestId: null };
  if ((typeof name === 'string' && AI_ERROR_NAMES.has(name)) || /^fetch failed\b/i.test(message)) {
    return { code: 'provider_error', scope: 'item', class: 'transient', message, requestId: null };
  }
  if (/ECONNRESET|ECONNREFUSED|connection (terminated|ended|closed)|Connection terminated|socket hang up/i.test(message)) {
    return { code: 'connection_lost', scope: 'run', class: 'transient', message, requestId: null };
  }
  return null;
}

/**
 * Classifies one failure raised while processing a single item. The `cause`
 * chain is walked (at most 5 deep): a run-scoped stop anywhere in it wins, so a
 * wrapped abort or authorization failure is never one item's (a model provider's
 * own socket failure under a provider error stays the provider's); otherwise the
 * outermost recognized error decides.
 */
export function classifyItemFailure(error: unknown): ClassifiedItemFailure {
  const message = error instanceof Error ? error.message : String(error);
  let first: ClassifiedItemFailure | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const classified = classifyOne(current);
    const providerTransport = first?.code === 'provider_error' && classified?.code === 'connection_lost';
    if (classified?.scope === 'run' && !providerTransport) return depth === 0 ? classified : { ...classified, message };
    if (classified && !first) first = depth === 0 ? classified : { ...classified, message };
    current = (current as { cause?: unknown }).cause;
  }
  return first ?? { code: 'internal', scope: 'item', class: 'transient', message, requestId: null };
}

export interface ItemFailure extends ClassifiedItemFailure { key: string }

/** The breaker's floor: no verdict before this many items were attempted. Matches the connector outage breaker. */
export const ITEM_BREAKER_MIN_ITEMS = 5;

/**
 * One run of a per-item loop. `fail` classifies the error: a run-scoped error is
 * rethrown as is; otherwise the failure is recorded, and when the breaker trips
 * `fail` throws `item_failures_systemic` so the caller stops without holding
 * items from a run that looks systemic.
 */
export class ItemRun {
  private attempted = 0;
  private successes = 0;
  private readonly failed: ItemFailure[] = [];
  private readonly pendingItems: ItemFailure[] = [];

  constructor(readonly site: IsolateSite, private readonly opts: { minItems?: number } = {}) {}

  succeed(): void { this.attempted++; this.successes++; }

  /** Records one item's failure and returns it; rethrows run-scoped errors; throws `item_failures_systemic` when the breaker trips. */
  fail(key: string, error: unknown): ItemFailure {
    const recorded = this.record(key, error);
    if (recorded.systemic) throw recorded.systemic;
    return recorded.failure;
  }

  /** Like `fail`, but a tripped breaker is returned instead of thrown, so a caller can stop through its own exit; run-scoped errors still throw. */
  record(key: string, error: unknown): { failure: ItemFailure; systemic: OperationError | null } {
    const classified = classifyItemFailure(error);
    if (classified.scope === 'run') throw error;
    const failure: ItemFailure = { ...classified, key, message: classified.message.slice(0, 500) };
    if (classified.scope === 'pending') { this.pendingItems.push(failure); return { failure, systemic: null }; }
    this.attempted++;
    this.failed.push(failure);
    return { failure, systemic: this.systemic() };
  }

  /** Item failures recorded so far (pending writes excluded). */
  get failures(): readonly ItemFailure[] { return this.failed; }
  /** Accepted writes still publishing. */
  get pending(): readonly ItemFailure[] { return this.pendingItems; }
  get succeeded(): number { return this.successes; }

  /** Holds are recorded only for runs whose failures look like the items' own: call before persisting any hold. */
  systemic(): OperationError | null {
    const min = this.opts.minItems ?? ITEM_BREAKER_MIN_ITEMS;
    if (this.attempted < min || this.failed.length === 0) return null;
    const transient = this.failed.filter(f => f.class === 'transient').length;
    const byCode = new Map<string, number>();
    for (const f of this.failed) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
    const [topCode, sameCode] = [...byCode.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const tripped = this.successes === 0 || transient * 2 >= this.attempted || (sameCode >= min && sameCode * 2 >= this.attempted);
    if (!tripped) return null;
    const sample = this.failed.slice(0, 3).map(f => `${f.key} (${f.code})`).join(', ');
    const error = opError('item_failures_systemic',
      `${this.failed.length} of ${this.attempted} items failed at ${this.site} (most often ${topCode}: ${sameCode}); this looks systemic, so no item was held. First failures: ${sample}.`,
      'Fix the shared cause the first failures name, then rerun; run `gbrain doctor --json` if the cause is unclear.',
      { detail: this.site, reason: topCode });
    return error;
  }
}
