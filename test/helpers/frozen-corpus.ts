import { readdirSync } from 'node:fs';
import { corpusFileSessionId } from '../../src/core/context/corpus-segments.ts';
import { freezeSessionSource } from '../../src/core/context/corpus-source.ts';

/** #7805: freeze every top-level corpus transcript's session to `sourceId`, as a post-#6268 capture or an operator mapping would. */
export function freezeCorpusSessions(corpusDir: string, sourceId: string): void {
  for (const name of readdirSync(corpusDir)) {
    if (name.endsWith('.txt')) freezeSessionSource(corpusDir, corpusFileSessionId(name), sourceId, 'operator');
  }
}
