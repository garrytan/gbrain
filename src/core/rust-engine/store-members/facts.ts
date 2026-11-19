/**
 * Facts and their supersession chains (BrainEngine pageCollapseFacts; the other fact members are not served yet and
 * refuse with `engine_capability_missing`, docs/designs/RUST_ENGINE_INTERFACES.md).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/**
 * `pageCollapseFacts` (engine-sql/search-reads.ts): the collapse-stage reads of each page in `ids`, by id (the SQL has
 * no ORDER BY). Both lists bind as `int[]`, so an id that is not a 32-bit integer refuses rather than guess at
 * PGLite's cast error.
 */
export const pageCollapseFacts: Member<'pageCollapseFacts'> = async (brain, ids, bodyIds) => {
  for (const id of [...ids, ...bodyIds]) {
    if (!Number.isInteger(id) || Math.abs(id) > 2 ** 31 - 1) refuseMember('pageCollapseFacts', 'a page id that is not a 32-bit integer');
  }
  if (ids.length === 0) return [];
  return storeCall({ member: 'pageCollapseFacts' }, () => brain.pageCollapseFacts(ids, bodyIds));
};
