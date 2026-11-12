/**
 * Agent contract v1 (B4): one accepted page, two failure shapes. The page is
 * gone → canonical `page_not_found`; it was replaced by another page →
 * `page_identity_changed`. Both keep the frozen wire `error`
 * `page_identity_changed`, which is also what the journal stores, so a replay
 * recovers the distinction from the stored message alone (no schema change).
 */
import { opError, type OperationError } from '../ops/contract.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../facts/extract-from-fence.ts';
import type { WriteRequest } from './model.ts';

export const PAGE_MISSING_MESSAGE = 'The accepted page no longer exists.';

/** Messages journaled for a missing page (current and pre-v1 rows). */
const MISSING_MESSAGES: ReadonlySet<string> = new Set([PAGE_MISSING_MESSAGE]);

export function isMissingPageMessage(message: string | null | undefined): boolean {
  return message != null && MISSING_MESSAGES.has(message);
}

/** The error for an accepted page whose identity no longer matches: `present` says whether any page holds the slug now. */
export function pageIdentityError(present: boolean, replacedMessage: string): OperationError {
  if (!present) {
    return opError('page_not_found', PAGE_MISSING_MESSAGE,
      'The page was deleted before this write published. Check whether it exists now; recreating it is a new write with a new request_id.',
      { legacy_error: 'page_identity_changed' });
  }
  return opError('page_identity_changed', replacedMessage,
    'Another page took this slug while the write was queued. Read the current page before deciding to submit again with a new request_id.');
}

/**
 * B4: a content-free locator for a YAML frontmatter failure (` at line 3,
 * column 5`). Only the numbers are kept: parser messages quote the offending
 * text, and receipts persist this message.
 */
export function yamlLocator(text: string | null | undefined): string {
  const m = /\bline (\d+)(?:,? column (\d+))?/i.exec(text ?? '') ?? /\((\d+):(\d+)\)/.exec(text ?? '');
  return m ? ` at line ${m[1]}${m[2] ? `, column ${m[2]}` : ''}` : '';
}

/**
 * GST-359 C2: a member page (GST-1113: or scope page) another write created after this remember was accepted is the same page, not a recreation;
 * so is memory/unattributed, which the first subjectless (or, GST-2492, held) remember creates (concurrent first saves
 * all land on it). Preparation and the coordinator's publication check share it.
 */
export function rememberAcceptsPageCreatedSince(row: Pick<WriteRequest, 'operation' | 'slug' | 'page_id' | 'intent' | 'authority'>,
  snapshot: { page: { deleted_at?: Date | string | null } } | null): boolean {
  const p = row.intent;
  return row.operation === 'remember' && row.page_id === null && snapshot !== null && !snapshot.page.deleted_at && !!p
    && (p.member_page === true || p.scope_page === true || (row.slug === UNATTRIBUTED_MEMORY_SLUG && (p.entity_slug == null || row.authority.heldFor === p.entity_slug)));
}
