/**
 * Group 5 facts members, repair classifiers and loop retirement (src/core/engine-sql/facts-repair.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/repair.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served: listSessionFactsForClassification, listSessionFactTwins, listCapturedFactsForClassification and
 * listWorldFactsFromPrivateSources, which read only `facts` and `pages`, and countLabelFacts, whose label line this member
 * reads into literal labels (label-line.ts). loopFactDrift and closedLoopWithActiveFact are served from open-loops.ts.
 * Also served (facts/repair_gone.rs): listExtractorFactsForClassification, whose receipt is read off the write journal's
 * committed requests, and countPurgedPageFacts, which the store answers as one `purged` flag per counted fact: true when
 * the source's `page_purges` ledger records a purge of the fact's page at or after the fact was written.
 * Refused: listUnwithdrawnFacts. The store keeps derived generations and their items (generations.rs writes them), but
 * no store read lists the facts a facts-fence generation retired, so answering no row could hide one.
 *
 * An id list binds as `bigint[]` on PGLite, so an id that is not an integer refuses rather than guess at its cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { labelsOf } from './label-line.ts';

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

/**
 * `countLabelFacts`: the store counts up to `LIMIT cap + 1` rows and this member caps the count, as the SQL does. The label
 * line must have the shape labelsOf reads and the context pattern must be `%text%` with no `%`, `_` or `\` inside;
 * any other pattern refuses. A cap that is not an integer, or one whose `LIMIT` would be negative, refuses.
 */
export const countLabelFacts: Member<'countLabelFacts'> = (brain, sourceIds, cap, args) => {
  const m = 'countLabelFacts';
  if (!Number.isSafeInteger(cap) || cap + 1 < 0) refuseMember(m, 'a cap that is not an integer of -1 or more');
  const labels = labelsOf(args.labelLine);
  if (labels === null) refuseMember(m, 'a label line other than literal labels between the fixed head and tail');
  const like = /^%([^%_\\]*)%$/.exec(args.contextLike);
  if (like === null) refuseMember(m, 'a context pattern other than %text%');
  const query = {
    sourceIds, limit: cap + 1, segmentSource: args.segmentSource, contextContains: like[1]!, labels,
    terminalSource: args.terminalSource, nonExtractableSource: args.nonExtractableSource,
  };
  return storeCall({ member: m }, async () => {
    const n = Number(await brain.countLabelFacts(query));
    return { count: Math.min(n, cap), capped: n > cap };
  });
};

/** `listExtractorFactsForClassification`: by (source, page, id); `slug` null lists every page of the sources. */
export const listExtractorFactsForClassification: Member<'listExtractorFactsForClassification'> = (brain, sourceIds, slug) =>
  storeCall({ member: 'listExtractorFactsForClassification' }, () => brain.listExtractorFactsForClassification({ sourceIds, slug }));

/**
 * `countPurgedPageFacts`: the store lists the `purged` flag of up to `cap + 1` facts and this member counts them as the
 * SQL does. A cap that is not an integer, or one whose `LIMIT` would be negative, refuses.
 */
export const countPurgedPageFacts: Member<'countPurgedPageFacts'> = (brain, sourceIds, cap) => {
  const m = 'countPurgedPageFacts';
  if (!Number.isSafeInteger(cap) || cap + 1 < 0) refuseMember(m, 'a cap that is not an integer of -1 or more');
  return storeCall({ member: m }, async () => {
    const rows = (await brain.countPurgedPageFacts({ sourceIds, limit: cap + 1 })) as boolean[];
    const kept = rows.slice(0, cap);
    return { evidenced: kept.filter(Boolean).length, ambiguous: kept.filter(r => !r).length, capped: rows.length > cap };
  });
};

/** `listUnwithdrawnFacts`: refused; the store keeps generation items but has no read of the facts a fence retired. */
export const listUnwithdrawnFacts: Member<'listUnwithdrawnFacts'> = async () =>
  refuseMember('listUnwithdrawnFacts', 'a read of the facts a facts-fence generation retired');
