/**
 * Group 5 facts members, repair classifiers and loop retirement (src/core/engine-sql/facts-repair.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/repair.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served from facts/captured.rs: listActiveSourceIds, readRepairBrainId (the persistence brain id), listFenceRewriteRows,
 * expireCapturedFacts, listExpiredFactIds, listPagelessEntityFacts, readEntityRehomeState and
 * rehomeEntityFacts. The two writers (expireCapturedFacts, rehomeEntityFacts) write through the store's fact writer, and
 * rehomeEntityFacts also applies the withdrawal guard (facts/withdrawal_guard.rs) the SQL gets from its trigger.
 * Served from facts/session_takes.rs (`gbrain repair agent-session-facts`): listAgentSessionTakeCandidates,
 * listSettledSessionFacts, reattributeSessionFacts, retireSessionTakes, listOtherAttributedFactIds and listInactiveTakeIds.
 * reattributeSessionFacts writes through the store's fact writer and retireSessionTakes through its take writer.
 * Served: listSessionFactsForClassification, listSessionFactTwins, listCapturedFactsForClassification and
 * listWorldFactsFromPrivateSources, which read only `facts` and `pages`, countLabelFacts, whose label line this member
 * reads into literal labels (label-line.ts), and countPurgedPageFacts, which reads the store's `page_purges` ledger. No
 * member writes that ledger on Rust: the page purge sweep and the restore replay write it with raw SQL in the write
 * journal's transaction and refuse, so on Rust every counted fact is ambiguous. (`insertFactPurge` and `insertHoldingPagePurges` are
 * served, but they write the `fact_purges` ledger, not `page_purges`, so they do not change that.) listUnwithdrawnFacts reads
 * the store's derived generation ledger (facts/generations.rs), which no member writes on Rust either: the fence writer publishes
 * generations with raw SQL and refuses, so on Rust it lists nothing. loopFactDrift and closedLoopWithActiveFact are
 * served from open-loops.ts. listExtractorFactsForClassification reads its receipts from
 * the write journal's committed requests (`persistence_requests` on SQL), the requests the store's journal records.
 *
 * An id list binds as `bigint[]` on PGLite, so an id that is not an integer refuses rather than guess at its cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { labelsOf } from './label-line.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function wholeIds(member: string, ids: readonly number[] | null): void {
  for (const id of ids ?? []) if (!Number.isSafeInteger(id)) refuseMember(member, 'a fact id that is not an integer');
}

/** The statements that write or name facts of one source by id: the store reads the ids as whole numbers, as `bigint[]` binds. */
function named(member: string, sourceId: string, ids: readonly number[]): { sourceId: string; ids: readonly number[] } {
  wholeIds(member, ids);
  return { sourceId, ids };
}

/** `listActiveSourceIds`: the unarchived sources by id. */
export const listActiveSourceIds: Member<'listActiveSourceIds'> = (brain) =>
  storeCall({ member: 'listActiveSourceIds' }, () => brain.listActiveSourceIds());

/** `readRepairBrainId`: the same brain id `readPersistenceBrainId` answers, null when the brain has none. */
export const readRepairBrainId: Member<'readRepairBrainId'> = (brain) => readPersistenceBrainId(brain);

/** `listFenceRewriteRows`: the named unexpired facts of the source, by id, with their fence row number or null. */
export const listFenceRewriteRows: Member<'listFenceRewriteRows'> = (brain, sourceId, ids) =>
  storeCall({ member: 'listFenceRewriteRows' }, () => brain.listFenceRewriteRows(named('listFenceRewriteRows', sourceId, ids)));

/** `expireCapturedFacts`: expires the named unexpired database-only facts and answers the ids it expired. */
export const expireCapturedFacts: Member<'expireCapturedFacts'> = (brain, sourceId, ids, context) =>
  storeCall({ member: 'expireCapturedFacts' }, () => brain.expireCapturedFacts({ ...named('expireCapturedFacts', sourceId, ids), context }));

/** `listExpiredFactIds`: the named facts of the source that are expired, by id. */
export const listExpiredFactIds: Member<'listExpiredFactIds'> = (brain, sourceId, ids) =>
  storeCall({ member: 'listExpiredFactIds' }, () => brain.listExpiredFactIds(named('listExpiredFactIds', sourceId, ids)));

/** `listPagelessEntityFacts`: per page-less entity of the sources, its database-only fact ids and its fenced count. */
export const listPagelessEntityFacts: Member<'listPagelessEntityFacts'> = (brain, sourceIds) =>
  storeCall({ member: 'listPagelessEntityFacts' }, () => brain.listPagelessEntityFacts({ sourceIds }));

/** `readEntityRehomeState`: whether each page is live and the database-only fact ids keyed under `from`. */
export const readEntityRehomeState: Member<'readEntityRehomeState'> = (brain, sourceId, from, to) =>
  storeCall({ member: 'readEntityRehomeState' }, () => brain.readEntityRehomeState({ sourceId, from, to }));

/**
 * `rehomeEntityFacts`: moves the database-only facts keyed under `from` to `to`. A fact a withdrawal reaches on the new
 * entity is expired, as the SQL's withdrawal trigger does; a stint key the move would duplicate rejects the whole write.
 */
export const rehomeEntityFacts: Member<'rehomeEntityFacts'> = async (brain, sourceId, from, to) => {
  await storeCall({ member: 'rehomeEntityFacts' }, () => brain.rehomeEntityFacts({ sourceId, from, to }));
};

/**
 * `listExtractorFactsForClassification`: the expired fenceless extractor facts with their page, withdrawal, duplicate,
 * fence and receipt evidence, by (source, page, id). `expired_at` is the UTC microsecond text the SQL's `to_char` gives.
 */
export const listExtractorFactsForClassification: Member<'listExtractorFactsForClassification'> = (brain, sourceIds, slug) =>
  storeCall({ member: 'listExtractorFactsForClassification' }, () => brain.listExtractorFactsForClassification({ sourceIds, slug }));

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

/**
 * `countPurgedPageFacts`: the store lists, for up to `LIMIT cap + 1` gone-page facts, whether a purge record is the
 * evidence; this member keeps the first `cap` and counts them, as the SQL does. A cap that is not an integer, or one whose
 * `LIMIT` would be negative, refuses.
 */
export const countPurgedPageFacts: Member<'countPurgedPageFacts'> = (brain, sourceIds, cap) => {
  const m = 'countPurgedPageFacts';
  if (!Number.isSafeInteger(cap) || cap + 1 < 0) refuseMember(m, 'a cap that is not an integer of -1 or more');
  return storeCall({ member: m }, async () => {
    const rows = (await brain.countPurgedPageFacts({ sourceIds, limit: cap + 1 })) as boolean[];
    const kept = rows.slice(0, Math.max(cap, 0));
    const evidenced = kept.filter(Boolean).length;
    return { evidenced, ambiguous: kept.length - evidenced, capped: rows.length > cap };
  });
};

/** `listUnwithdrawnFacts`: the store answers the rows in the SQL's order with its columns. */
export const listUnwithdrawnFacts: Member<'listUnwithdrawnFacts'> = (brain, sourceIds, slug, fenceKind) =>
  storeCall({ member: 'listUnwithdrawnFacts' }, () => brain.listUnwithdrawnFacts({ sourceIds, slug, fenceKind }));

/**
 * The previews of `gbrain repair consolidate-ties`, `facts-rehome`, `ontology-facts` and `duplicate-facts`: the store reads its
 * facts (and pages and withdrawals) and answers the rows of the SQL in its order. Text columns order by byte, as the lowercase
 * ids, slugs and hex fingerprints they hold do under a database collation.
 */
export const listClosedConsolidationTies: Member<'listClosedConsolidationTies'> = (brain, sourceIds) =>
  storeCall({ member: 'listClosedConsolidationTies' }, () => brain.listClosedConsolidationTies({ sourceIds }));

export const listOntologyFactCandidates: Member<'listOntologyFactCandidates'> = (brain, sourceIds) =>
  storeCall({ member: 'listOntologyFactCandidates' }, () => brain.listOntologyFactCandidates({ sourceIds }));

export const listDuplicateFactRows: Member<'listDuplicateFactRows'> = (brain, sourceIds, excludedSources) =>
  storeCall({ member: 'listDuplicateFactRows' }, () => brain.listDuplicateFactRows({ sourceIds, excludedSources }));

/**
 * The previews of `gbrain repair fact-claim-dates` and `url-clone-fences`: the store reads the facts of the UTC day, and the
 * live page of a path (the lowest id, as the SQL's `ORDER BY id LIMIT 1`). A day that is not a real `YYYY-MM-DD` refuses: the
 * SQL's `$2::date` would read other spellings, which a caller never sends.
 */
export const listFactsOnValidDay: Member<'listFactsOnValidDay'> = (brain, sourceId, day) => {
  const m = 'listFactsOnValidDay';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) refuseMember(m, 'a day that is not a real YYYY-MM-DD date');
  return storeCall({ member: m }, () => brain.listFactsOnValidDay({ sourceId, day }));
};

export const readLivePageByPath: Member<'readLivePageByPath'> = async (brain, sourceId, path) =>
  await storeCall({ member: 'readLivePageByPath', sourceId }, () => brain.readLivePageByPath({ sourceId, path })) as { id: number; slug: string } | null;

/** `listPurgedPageFactCandidates`: the store answers the rows of the SQL in its order; `purged` reads its `page_purges` ledger, which no member writes on Rust. */
export const listPurgedPageFactCandidates: Member<'listPurgedPageFactCandidates'> = (brain, sourceIds, ids) => {
  wholeIds('listPurgedPageFactCandidates', ids);
  return storeCall({ member: 'listPurgedPageFactCandidates' }, () => brain.listPurgedPageFactCandidates({ sourceIds, ids }));
};

/**
 * The scan of `gbrain repair facts-home` and the approved-set digest of the maintenance repairs: the store answers the rows of the
 * SQL in its order (text sorts by byte). `listHeldHomeRows` counts `days` as 24-hour days from the store's clock, so a count that is
 * not a whole number refuses. `readFactSnapshots` has no row lock: `lock` (FOR UPDATE, only inside a SQL transaction) refuses.
 */
const HOME_DATES = ['valid_from', 'valid_until'] as const;

export const listFactsHomeCandidates: Member<'listFactsHomeCandidates'> = async (brain, sourceId) => {
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'listFactsHomeCandidates' }, () => brain.listFactsHomeCandidates({ sourceId }));
  return rows.map(row => withDates(row, HOME_DATES)) as never;
};

export const listHeldHomeRows: Member<'listHeldHomeRows'> = async (brain, sourceId, days) => {
  if (!Number.isSafeInteger(days)) refuseMember('listHeldHomeRows', 'a day count that is not a whole number');
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'listHeldHomeRows' }, () => brain.listHeldHomeRows({ sourceId, days }));
  return rows.map(row => withDates(row, HOME_DATES)) as never;
};

export const listOrphanedFenceRows: Member<'listOrphanedFenceRows'> = (brain, sourceId) =>
  storeCall({ member: 'listOrphanedFenceRows' }, () => brain.listOrphanedFenceRows({ sourceId }));

export const readFactSnapshots: Member<'readFactSnapshots'> = (brain, sourceId, ids, lock) => {
  if (lock) refuseMember('readFactSnapshots', 'a row lock (FOR UPDATE)');
  wholeIds('readFactSnapshots', ids);
  return storeCall({ member: 'readFactSnapshots' }, () => brain.readFactSnapshots({ sourceId, ids }));
};

/** `listAgentSessionTakeCandidates`: the open self fact takes of the sources with their consolidated facts, by source, slug and id. */
export const listAgentSessionTakeCandidates: Member<'listAgentSessionTakeCandidates'> = async (brain, sourceIds, ids, noteMark) => {
  wholeIds('listAgentSessionTakeCandidates', ids);
  if (!sourceIds.length) return [];
  return storeCall({ member: 'listAgentSessionTakeCandidates' }, () =>
    brain.listAgentSessionTakeCandidates({ sourceIds: [...sourceIds], ids: ids === null ? null : [...ids], noteMark }));
};

/** `listSettledSessionFacts`: the named unexpired, unsuperseded facts of the source attributed to `other`, with their context. */
export const listSettledSessionFacts: Member<'listSettledSessionFacts'> = async (brain, sourceId, ids) => {
  if (!ids.length) return [];
  return storeCall({ member: 'listSettledSessionFacts' }, () => brain.listSettledSessionFacts(named('listSettledSessionFacts', sourceId, ids)));
};

/** `reattributeSessionFacts`: sets the named active database-only user facts to `other`, appending each note once. */
export const reattributeSessionFacts: Member<'reattributeSessionFacts'> = async (brain, sourceId, facts, separator) => {
  wholeIds('reattributeSessionFacts', facts.map(f => f.id));
  if (!facts.length) return [];
  return storeCall({ member: 'reattributeSessionFacts' }, () =>
    brain.reattributeSessionFacts({ sourceId, facts: facts.map(f => ({ id: f.id, note: f.note })), separator }));
};

/** `retireSessionTakes`: retires the named open self fact takes of the source that no user fact feeds. */
export const retireSessionTakes: Member<'retireSessionTakes'> = async (brain, sourceId, takeIds) => {
  wholeIds('retireSessionTakes', takeIds);
  if (!takeIds.length) return [];
  return storeCall({ member: 'retireSessionTakes' }, () => brain.retireSessionTakes({ sourceId, takeIds: [...takeIds] }));
};

/** `listOtherAttributedFactIds`: the named facts of the source attributed to `other`, by id. */
export const listOtherAttributedFactIds: Member<'listOtherAttributedFactIds'> = async (brain, sourceId, ids) => {
  if (!ids.length) return [];
  return storeCall({ member: 'listOtherAttributedFactIds' }, () => brain.listOtherAttributedFactIds(named('listOtherAttributedFactIds', sourceId, ids)));
};

/** `listInactiveTakeIds`: the named takes that are inactive, by id. */
export const listInactiveTakeIds: Member<'listInactiveTakeIds'> = async (brain, ids) => {
  wholeIds('listInactiveTakeIds', ids);
  if (!ids.length) return [];
  return storeCall({ member: 'listInactiveTakeIds' }, () => brain.listInactiveTakeIds({ ids: [...ids] }));
};
