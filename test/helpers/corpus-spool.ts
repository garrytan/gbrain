import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_SPOOL_SUBDIR } from '../../src/core/context/corpus-segments.ts';

/**
 * #6268 fixture helper: where a current writer puts a corpus file for
 * `source` — the spool subdirectory, the source stamped into the name
 * (`x.txt` → `sourced/x.src-default.txt`; sidecar names keep their suffix:
 * `x.txt.ingested` → `sourced/x.src-default.txt.ingested`). Creates the spool.
 */
export function spoolPath(corpusDir: string, name: string, source = 'default'): string {
  mkdirSync(join(corpusDir, CORPUS_SPOOL_SUBDIR), { recursive: true });
  return join(corpusDir, CORPUS_SPOOL_SUBDIR, name.replace(/\.txt(?=$|\.)/, `.src-${source}.txt`));
}
