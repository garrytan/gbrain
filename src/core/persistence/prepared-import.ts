import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';

/**
 * #6007: what an apply reports to its caller. `pageId` is the page it
 * wrote, when the write left it live; `sealed` means sealing its text
 * projection was its last step that can change the page's revision, title or
 * timeline. `chunkerSeal`: a coordinated apply left the page's chunker version
 * to the caller, which stamps it with its text seal (`sealImportedPage`).
 */
export interface PreparedImportApplied { pageId?: number; sealed: boolean; chunkerSeal?: number }

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
}
