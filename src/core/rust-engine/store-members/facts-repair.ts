/**
 * Group 5 facts members, repair classifiers and loop retirement (src/core/engine-sql/facts-repair.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/repair.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served: listSessionFactsForClassification, listSessionFactTwins, listCapturedFactsForClassification and
 * listWorldFactsFromPrivateSources, which read only `facts` and `pages`. loopFactDrift and closedLoopWithActiveFact are served
 * from open-loops.ts. Refused: countLabelFacts (a POSIX regular expression the store does not evaluate), and, because the
 * store holds no such table, listExtractorFactsForClassification (`persistence_requests`, `fact_withdrawals`), countPurgedPageFacts (`page_purges`,
 * `fact_withdrawals`, `open_loops`) and listUnwithdrawnFacts (`derived_generations`, `derived_generation_items`,
 * `fact_withdrawals`).
 *
 * An id list binds as `bigint[]` on PGLite, so an id that is not an integer refuses rather than guess at its cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function wholeIds(member: string, ids: readonly number[] | null): void {
  for (const id of ids ?? []) if (!Number.isSafeInteger(id)) refuseMember(member, 'a fact id that is not an integer');
}

/** `listSessionFactsForClassification` (engine-sql/facts-repair.ts): by (source, id), as the SQL orders them. */
export const listSessionFactsForClassification: Member<'listSessionFactsForClassification'> = (brain, sourceIds, lanes, ids) => {
  wholeIds('listSessionFactsForClassification', ids);
  return storeCall({ member: 'listSessionFactsForClassification' }, () => brain.listSessionFactsForClassification({ sourceIds, lanes, ids }));
};

/**
 * `listSessionFactTwins`: by id (the SQL has no ORDER BY). `twin_sessions` lists each distinct session once, in text
 * order; the SQL leaves the order open and its caller reads it as a set.
 */
export const listSessionFactTwins: Member<'listSessionFactTwins'> = (brain, ids, lanes) => {
  wholeIds('listSessionFactTwins', ids);
  return storeCall({ member: 'listSessionFactTwins' }, () => brain.listSessionFactTwins({ ids, lanes }));
};

/** `listCapturedFactsForClassification`: by (source, id), each row with its fingerprint and `legit_twin`. */
export const listCapturedFactsForClassification: Member<'listCapturedFactsForClassification'> = (brain, sourceIds, lanes, ids) => {
  wholeIds('listCapturedFactsForClassification', ids);
  return storeCall({ member: 'listCapturedFactsForClassification' }, () => brain.listCapturedFactsForClassification({ sourceIds, lanes, ids }));
};

/**
 * `listWorldFactsFromPrivateSources`: by id. `honorAliases` is read off the rendered snapshot filter, the one process
 * setting the statement carries. A folder rule is never read: the store holds no access tables.
 */
export const listWorldFactsFromPrivateSources: Member<'listWorldFactsFromPrivateSources'> = (brain, sourceIds, ids) => {
  wholeIds('listWorldFactsFromPrivateSources', ids);
  const honorAliases = privateSnapshotFilterFragment('h').includes(privacyAliasSql('h'));
  return storeCall({ member: 'listWorldFactsFromPrivateSources' }, () => brain.listWorldFactsFromPrivateSources({ sourceIds, ids, honorAliases }));
};
