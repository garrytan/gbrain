import type { BrainEngine } from '../engine.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';

/** Parsing/provider work is complete. apply must run under the coordinator's transaction. */
export interface PreparedContentImport {
  slug: string;
  parsedPage: ParsedPage;
  observedRevision: string | null;
  noop: boolean;
  result: ImportResult;
  apply(tx: BrainEngine): Promise<void>;
}
