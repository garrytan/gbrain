import type { GetPageOpts, Page } from '../types.ts';

/** Opaque logical revisions are independent of timestamps and filesystem hashes. */
export interface PageMutationPrecondition {
  expectedRevision?: string;
  force?: boolean;
}

export interface PageWriteOptions extends PageMutationPrecondition {
  sourceId?: string;
  allowEmptyOverwrite?: boolean;
  /**
   * #5984: inside a page transaction, write in that transaction instead of a
   * savepoint (one round trip less); a failure then aborts the transaction.
   */
  inline?: boolean;
  /**
   * #5984: stamps the page's contextual retrieval state in the same statement,
   * as `updatePageContextualRetrievalState` would right after it. Not for the
   * `none` tier, whose stamp also clears tier vectors.
   */
  contextualRetrieval?: { mode: string; corpusGeneration: string | null };
}

export interface PageKey {
  sourceId: string; slug: string;
  /** #5984: the source incarnation the caller already verified; lets a page lock send its source read with the guard statements. */
  incarnation?: string;
}
export interface PageSnapshotOptions extends GetPageOpts {
  /** Exact slug wins; only follow a source-scoped alias when explicitly requested. */
  resolveAlias?: boolean;
  requireUnambiguous?: boolean;
  requireLiveSource?: boolean;
  preserveExactIdentity?: boolean;
}
export class PageSnapshotAmbiguousError extends Error {
  constructor() {
    super('Multiple readable pages match this identifier.');
    this.name = 'PageSnapshotAmbiguousError';
  }
}
export interface PageWithdrawal {
  visibility: 'private' | 'world';
  fact_hash: string;
  withdrawn_at: string;
}
export interface PageSnapshot {
  page: Page;
  tags: string[];
  revision: string;
  sourceIncarnation: string;
  withdrawals: PageWithdrawal[];
}

export class PageRevisionConflictError extends Error {
  readonly code: 'revision_conflict' | 'revision_backfill_pending' = 'revision_conflict';
  constructor(readonly expectedRevision: string | null, readonly currentRevision: string | null) {
    super(currentRevision === null ? 'The page no longer exists at the expected revision.'
      : expectedRevision === null ? 'The page already exists; an expected revision is required.'
      : 'The page changed after it was read. Read its current revision before retrying.');
    this.name = 'PageRevisionConflictError';
  }
}

/** #5216: the snapshot revision of a row written before the column existed and not yet backfilled. Never a UUID. */
export const REVISION_BACKFILL_PENDING = 'backfill_pending';

/** A revision-bound write to a row whose revision is still being backfilled. A conflict to every retry loop. */
export class RevisionBackfillPendingError extends PageRevisionConflictError {
  override readonly code = 'revision_backfill_pending' as const;
  constructor(expectedRevision: string | null) {
    super(expectedRevision, REVISION_BACKFILL_PENDING);
    this.message = 'This page has no revision yet: the revision backfill for pages written before the upgrade has not reached it. '
      + 'Resume it with: gbrain apply-migrations --yes (see docs/guides/write-refusals.md#other-error-codes).';
    this.name = 'RevisionBackfillPendingError';
  }
}

/** Call after locking the exact source/page key, including absent pages. */
export function assertPageRevision(snapshot: Pick<PageSnapshot, 'revision'> | null, precondition: PageMutationPrecondition = {}): void {
  const { expectedRevision, force } = precondition;
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('force must be a boolean');
  if (expectedRevision !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedRevision)) {
    throw new TypeError('expectedRevision must be a UUID revision');
  }
  if (force && expectedRevision !== undefined) throw new TypeError('force and expectedRevision are mutually exclusive');
  if (force) return;
  if (snapshot?.revision === REVISION_BACKFILL_PENDING) throw new RevisionBackfillPendingError(expectedRevision ?? null);
  const current = snapshot?.revision ?? null;
  if (current !== (expectedRevision?.toLowerCase() ?? null)) throw new PageRevisionConflictError(expectedRevision ?? null, current);
}
