import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';
import type { SegmentedImport } from './segmented-apply.ts';

/**
 * #6007: what an apply reports to its caller. `pageId` is the page it
 * wrote, when the write left it live; `sealed` means sealing its text
 * projection was its last step that can change the page's revision, title or
 * timeline. `chunkerSeal`: a coordinated apply left the page's chunker version
 * to the caller, which stamps it with its text seal (`sealImportedPage`).
 */
export interface PreparedImportApplied { pageId?: number; sealed: boolean; chunkerSeal?: number;
  /** #7172: the apply left the page's chunk rows for its afterCommit (`continueDeferredProjection`); the caller seals nothing. */
  projectionPending?: true;
  /** Wave B: the apply published a segmented body; when `complete` the caller seals it with `sealSegmentedPage`, never the inline seals. */
  segmented?: { complete: boolean } }

/** Parsing/provider work is complete. apply must run under the coordinator's transaction. */
export interface PreparedContentImport {
  slug: string;
  parsedPage: ParsedPage;
  observedRevision: string | null;
  noop: boolean;
  /** The imported content hash, when apply writes the page (`coordinated` callers verify their read-back against it). */
  contentHash?: string;
  result: ImportResult;
  validate(tx: BrainEngine): Promise<void>;
  /** `preimage` (#5984): the publisher's guarded read of this page at the observed revision (see PreparedMutation.apply). */
  apply(tx: BrainEngine, preimage?: PageSnapshot | null): Promise<PreparedImportApplied | void>;
  /** Wave B: runs after the publication committed (a segmented page left unsealed is chunked and sealed). */
  afterCommit?(engine: BrainEngine): Promise<void>;
  /** Wave B: the segmented body this preparation staged, for a later preparation of the same write to reuse (`importFromContent`'s `reuseSegments`). */
  segmented?: SegmentedImport;
  /** Wave C: a segmented body left for the index step (importFromContent `deferSegmented`); `apply` must not run. */
  deferredToIndex?: true;
}

/** Wave C (spec §3.1): the preparation of a segmented body deferred to the index step; nothing is staged and it has no apply. */
export function deferredToIndexImport(input: Pick<PreparedContentImport, 'slug' | 'parsedPage' | 'observedRevision' | 'contentHash' | 'result' | 'validate'>): PreparedContentImport {
  return { ...input, noop: false, deferredToIndex: true, apply: async () => { throw new Error('A write deferred to the index step has no database apply.'); } };
}
