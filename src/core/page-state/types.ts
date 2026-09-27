import type { GetPageOpts, Page } from '../types.ts';

/** Opaque logical revisions are independent of timestamps and filesystem hashes. */
export interface PageMutationPrecondition {
  expectedRevision?: string;
  force?: boolean;
}

export interface PageWriteOptions extends PageMutationPrecondition {
  sourceId?: string;
  allowEmptyOverwrite?: boolean;
}

export interface PageKey { sourceId: string; slug: string }
export interface PageSnapshotOptions extends GetPageOpts {
  /** Exact slug wins; only follow a source-scoped alias when explicitly requested. */
  resolveAlias?: boolean;
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
  readonly code = 'revision_conflict';
  constructor(readonly expectedRevision: string | null, readonly currentRevision: string | null) {
    super(currentRevision === null ? 'The page no longer exists at the expected revision.'
      : expectedRevision === null ? 'The page already exists; an expected revision is required.'
      : 'The page changed after it was read. Read its current revision before retrying.');
    this.name = 'PageRevisionConflictError';
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
  const current = snapshot?.revision ?? null;
  if (current !== (expectedRevision?.toLowerCase() ?? null)) throw new PageRevisionConflictError(expectedRevision ?? null, current);
}
