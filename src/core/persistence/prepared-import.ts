import type { BrainEngine } from '../engine.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';

/** Parsing/provider work is complete. apply must run under the coordinator's transaction. */
export interface PreparedContentImport {
  slug: string;
  parsedPage: ParsedPage;
  observedRevision: string | null;
  noop: boolean;
  result: ImportResult;
  /** Recheck preparation-only invariants after the coordinator acquires guards and before file publication. */
  validate(tx: BrainEngine): Promise<void>;
  apply(tx: BrainEngine): Promise<void>;
}
