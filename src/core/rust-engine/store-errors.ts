/**
 * Maps what the Rust store rejects with (an `Error` carrying a `code`, rust/README.md "Error codes") onto the errors
 * the same BrainEngine member throws on PGLite, so callers branch on one set of errors:
 *
 *  - `store_closed` is `engine_closed`; `store_locked` is `rust_store_locked`; `format_unknown`, `store_corrupt` and
 *    `store_io` are `rust_store_unreadable` with that reason.
 *  - `revision_conflict` and `revision_required` are `PageRevisionConflictError`; a missing page is the error
 *    PGLite's member throws (`PageMissingError` for addLink and addTimelineEntry).
 *  - `origin_claimed` is `page_identity_changed` with detail `origin_already_claimed`, PGLite's origin-guard refusal.
 *  - Every other code stays on the original error, which already carries it (`invalid_slug`, `empty_overwrite`, ...).
 */
import { opError } from '../ops/contract.ts';
import { originAlreadyClaimed } from '../persistence/origin-guard.ts';
import { PageMissingError } from '../engine-errors.ts';
import { PageRevisionConflictError } from '../page-state/types.ts';

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
    default:
      return error;
  }
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
