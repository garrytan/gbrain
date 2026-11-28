/**
 * Maps what the Rust store rejects with (an `Error` carrying a `code`, rust/README.md "Error codes") onto the errors
 * the same BrainEngine member throws on PGLite, so callers branch on one set of errors:
 *
 *  - `store_closed` is `engine_closed`; `store_locked` is `rust_store_locked`; `format_unknown`, `store_corrupt` and
 *    `store_io` are `rust_store_unreadable` with that reason.
 *  - `revision_conflict` and `revision_required` are `PageRevisionConflictError`; a missing page is the error
 *    PGLite's member throws (`PageMissingError` for addLink and addTimelineEntry).
 *  - `origin_claimed` is `page_identity_changed` with detail `origin_already_claimed`, PGLite's origin-guard refusal.
 *  - `read_only_transaction` is Postgres's refusal of a write in a READ ONLY transaction: code `25006`
 *    (`read_only_sql_transaction`), message `cannot execute <member> in a read-only transaction`.
 *  - `page_ambiguous` is `PageSnapshotAmbiguousError`, what readPageSnapshot throws under `requireUnambiguous`.
 *  - A `constraint_violation` that names a unique index of the facts table (`idx_facts_ontology_stint_dedup`,
 *    `idx_facts_fence_key`) is the error Postgres and PGLite raise for it: SQLSTATE `23505` in `code`, the same message,
 *    and the constraint, table and schema names. The Postgres `detail` line (the key values) is not reproduced.
 *  - `timeout` (multi-user mode only: a deadline passed in the store) is the `timeout` operation error with the reason
 *    the store's message starts with (`transaction_deadline`, `key_wait`); nothing was committed.
 *  - Every other code stays on the original error, which already carries it (`invalid_slug`, `empty_overwrite`, ...).
 */
import type { Capability } from '../engine-capabilities.ts';
import { opError } from '../ops/contract.ts';
import { originAlreadyClaimed } from '../persistence/origin-guard.ts';
import { PageMissingError } from '../engine-errors.ts';
import { PageRevisionConflictError, PageSnapshotAmbiguousError } from '../page-state/types.ts';
import { READ_ONLY_SQLSTATE } from '../postgres-engine/read-write-transactions.ts';
import { capabilityMissing } from './errors.ts';
import { RUST_ENGINE_MEMBERS } from './members.ts';

export interface StoreErrorContext {
  member: string;
  slug?: string;
  sourceId?: string;
  /** What the caller expected, for `revision_conflict` and `revision_required`. */
  expectedRevision?: string | null;
  /** The page's current revision, read after the rejection; `null` when there is none. */
  currentRevision?: string | null;
}

export function storeErrorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** True for the rejections that are about a page's revision, which the page members re-read before they map. */
export function isRevisionRejection(error: unknown): boolean {
  const code = storeErrorCode(error);
  return code === 'revision_conflict' || code === 'revision_required';
}

export function mapStoreError(error: unknown, ctx: StoreErrorContext): unknown {
  const code = storeErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'store_closed':
      return opError('engine_closed', `The Rust engine's store is closed, so ${ctx.member} did not run.`,
        'Open the brain again with openEngine or connect() before calling it.', { detail: `member=${ctx.member}` });
    case 'store_missing':
      // The store's own last line (the CLI's connect refuses first, src/core/engine-connect.ts): a store that must be
      // there was not, and the open created nothing.
      return opError('brain_missing', `The Rust store is not there (an unmounted drive or a moved folder?), so ${ctx.member} did not open it. Nothing was created there.`,
        'Mount or move the brain back, or point `database_path` in the gbrain config at where it lives now.', { reason: 'missing_brain', detail });
    case 'store_locked':
      return opError('rust_store_locked', 'Another gbrain process or engine has this brain open, so the Rust engine opened nothing.',
        'Stop the other process that is using this brain, or disconnect the other engine, then try again.', { retryable: true, detail });
    case 'format_unknown':
    case 'store_corrupt':
    case 'store_io':
      return opError('rust_store_unreadable', `The Rust store could not complete ${ctx.member}: ${detail}`,
        'Check the brain directory and the disk. For a newer format, upgrade gbrain; for damaged records, restore a backup.', { reason: code, detail });
    case 'revision_conflict':
    case 'revision_required':
      return new PageRevisionConflictError(code === 'revision_required' ? undefined : (ctx.expectedRevision ?? null), ctx.currentRevision ?? null);
    case 'page_not_found':
      return pageNotFound(error, ctx);
    case 'origin_claimed':
      return originClaimed(error);
    case 'read_only_transaction':
      return Object.assign(new Error(`cannot execute ${ctx.member} in a read-only transaction`), { code: READ_ONLY_SQLSTATE });
    case 'page_ambiguous':
      return new PageSnapshotAmbiguousError();
    case 'constraint_violation':
      return factsUniqueViolation(error);
    case 'timeout':
      return storeTimeout(detail, ctx.member);
    case 'lease_lost':
      // A lease fence failed (multi-user mode, rust/crates/gbrain-store/src/leases.rs): nothing was written.
      return leaseLostError(error);
    case 'guest_source_guard:pages':
    case 'guest_source_guard:facts':
    case 'guest_source_guard:takes':
    case 'guest_source_guard:timeline_entries':
      return guestSourceGuard(error, code.slice('guest_source_guard:'.length));
    case 'unmodeled_input':
      // An input the store does not read as Postgres does: refused by name, before anything is written.
      return refusalFor(ctx.member, detail);
    default:
      return error;
  }
}

/**
 * The `lease_lost` reasons the store sends (`leases::LostReason`). `fence_missing` is retired: a protected call with no
 * fence is no longer refused for lacking one, but a receipt an older build wrote may carry it, so it still parses.
 */
export const LEASE_LOST_REASONS = ['not_found', 'epoch_moved', 'released', 'expired', 'claim_epoch_mismatch', 'held_by_another', 'fence_missing'] as const;
export type LeaseLostReason = typeof LEASE_LOST_REASONS[number];

/** The store's `lease_lost` message as `opError('lease_lost')` with its reason, or the error unchanged. */
export function leaseLostError(error: unknown): unknown {
  let at: { reason?: string; name?: string; epoch?: number; current_epoch?: number | null };
  try { at = JSON.parse(error instanceof Error ? error.message : ''); } catch { return error; }
  const reason = (LEASE_LOST_REASONS as readonly string[]).includes(String(at.reason)) ? String(at.reason) : 'epoch_moved';
  return opError('lease_lost',
    `The lease "${at.name ?? ''}" at epoch ${at.epoch ?? '?'} no longer fences this write (${reason}), so nothing was written.`,
    'Stop the work this lease protected, take the lease again (a new epoch) and re-read the state before writing.',
    { reason, detail: `name=${at.name ?? ''} epoch=${at.epoch ?? ''} current_epoch=${at.current_epoch ?? 'unknown'}` });
}

/**
 * A guest-source rule of the trust trigger (rust/crates/gbrain-store/src/guest_sources.rs): the error the trigger
 * raises, SQLSTATE `P0001` with the same message, constraint `guest_source_guard`, the table, and the trigger function
 * in `where`, so persistence/publication-failure.ts reads it as it reads the SQL engines' refusal.
 */
function guestSourceGuard(error: unknown, table: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message), {
    severity: 'ERROR', code: 'P0001', schema_name: 'public', table_name: table, constraint_name: 'guest_source_guard',
    where: 'PL/pgSQL function gbrain_stamp_trust_tier() line 1 at RAISE',
  });
}

/** `engine_capability_missing` for `member`, under the capability the member table gives it, naming what was refused. */
function refusalFor(member: string, what: string): Error {
  return capabilityMissing((RUST_ENGINE_MEMBERS as Record<string, string>)[member] as Capability, `${member} (${what})`);
}

/** The unique indexes of the facts table the store enforces, by the name Postgres reports. */
const FACTS_UNIQUE_INDEXES: ReadonlySet<string> = new Set(['idx_facts_ontology_stint_dedup', 'idx_facts_fence_key']);

/** SQLSTATE `unique_violation`. */
export const UNIQUE_VIOLATION_SQLSTATE = '23505';

function factsUniqueViolation(error: unknown): unknown {
  const message = error instanceof Error ? error.message : '';
  const named = /^duplicate key value violates unique constraint "(.+)"$/s.exec(message);
  if (!named || !FACTS_UNIQUE_INDEXES.has(named[1]!)) return error;
  return Object.assign(new Error(message), {
    severity: 'ERROR', code: UNIQUE_VIOLATION_SQLSTATE, schema_name: 'public', table_name: 'facts', constraint_name: named[1],
  });
}

function pageNotFound(error: unknown, ctx: StoreErrorContext): unknown {
  const slug = ctx.slug ?? '';
  const sourceId = ctx.sourceId ?? 'default';
  if (ctx.member === 'addTimelineEntry') return new PageMissingError('addTimelineEntry', 'page', slug, sourceId);
  if (ctx.member === 'addLink') {
    // The store's message names the endpoint and the page it could not find: `addLink failed: to page "x" (source=default) not found`.
    const named = /failed: (from|to) page "(.*)" \(source=(.*)\) not found$/s.exec(error instanceof Error ? error.message : '');
    return named ? new PageMissingError('addLink', named[1] as 'from' | 'to', named[2]!, named[3]!) : error;
  }
  if (ctx.member === 'addTag' || ctx.member === 'createVersion') {
    return new Error(`${ctx.member} failed: page "${slug}" (source=${sourceId}) not found`);
  }
  return error;
}

/** The store's message is JSON: `{ source_id, source_path, holders, slug }` (rust/README.md "Error codes"). */
function originClaimed(error: unknown): unknown {
  try {
    const at = JSON.parse(error instanceof Error ? error.message : '') as { source_id: string; source_path: string; holders: string[]; slug: string };
    return originAlreadyClaimed(at.source_id, at.source_path, at.holders, at.slug);
  } catch {
    return error;
  }
}

/** The reasons a store `timeout` message starts with (`gbrain_store::error::TIMEOUT`). */
const STORE_TIMEOUT_REASONS = new Set(['transaction_deadline', 'key_wait']);

/** A store `timeout`: its reason decoded from the message prefix, with what happened and what to do. */
function storeTimeout(message: string, member: string): unknown {
  const match = /^([a-z_]+): /.exec(message);
  const reason = match && STORE_TIMEOUT_REASONS.has(match[1]!) ? match[1]! : 'transaction_deadline';
  const what = reason === 'key_wait'
    ? `${member} waited for a key another writer holds past its deadline`
    : `${member} ran past its transaction deadline`;
  return opError('timeout', `${what}, so nothing was committed (ids it took may be skipped).`,
    'Retry the call; if it keeps timing out, give it a longer deadline or retry when fewer writers use the same pages.',
    { reason, detail: `member=${member} written=nothing` });
}
