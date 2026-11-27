/**
 * Group 5 facts members, recall's candidate-pool reads (src/core/engine-sql/facts-recall.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/recall.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served: `readFactsEmbeddingColumn`, `listNearestFacts`, `listTypedClaimFactsAtPages`, `listSlotRows`, `listPoolUnbackedKeys`, `listCallOffCueFacts` and
 * `listPoolEntityPairs`, `readFactWrittenDates` (memory_recall's date column, a plain read by fact id) and `readOwnMemberFactIds` (its `own_page` flag, judged under the caller's member-page policy). Each of the pool reads reads under the pool's read policy, which `poolArgs` (fact-pool.ts) resolves as it does for
 * `listFactsForRelevance`: the store answers it exactly when the visibility and privacy policies are ones it serves;
 * anything else refuses. `listNearestFacts` also refuses a vector-typed
 * column (the store keeps `halfvec`); its `hnswIterativeScan` only changes the plan, so the store ignores it.
 * `listFactRowsByIds` is served by facts-remember.ts.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { poolArgs } from './fact-pool.ts';
import { callerMember, memberFactAdmitSql } from '../../access/member-facts.ts';
import { currentCallerAccess } from '../../search/private-visibility.ts';
import { callerFolders, callerFoldersPagePolicy, callerReadersPagePolicy, judgeWidenedCaller, renderForStoreCaller, type StorePrivacyPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

const POOL_DATES = ['valid_from', 'valid_until', 'created_at'] as const;
const rows = <T>(list: Row[]): T[] => list.map(row => withDates(row, POOL_DATES)) as unknown as T[];

export const readFactsEmbeddingColumn: Member<'readFactsEmbeddingColumn'> = async brain =>
  storeCall({ member: 'readFactsEmbeddingColumn' }, () => brain.readFactsEmbeddingColumn());

/** The observed-date read's holding refs (BrainEngine listFactHoldingRefs), from the store's facts (facts/recall.rs). */
export const listFactHoldingRefs: Member<'listFactHoldingRefs'> = async (brain, ids) => {
  if (!ids.length) return [];
  if (!ids.every(Number.isSafeInteger)) refuseMember('listFactHoldingRefs', 'a fact id that is not an integer');
  return await storeCall({ member: 'listFactHoldingRefs' }, () => brain.listFactHoldingRefs([...ids])) as Awaited<ReturnType<BrainEngine['listFactHoldingRefs']>>;
};

/** The facts arm's superseded-claim read (BrainEngine listTypedClaimFactsAtPages), from the store's facts (facts/recall.rs). */
export const listTypedClaimFactsAtPages: Member<'listTypedClaimFactsAtPages'> = async (brain, pageSlugs, entitySlugs) =>
  rows(await storeCall({ member: 'listTypedClaimFactsAtPages' }, () => brain.listTypedClaimFactsAtPages([...pageSlugs], [...entitySlugs])) as Row[]);

/** The facts arm's source-page read (BrainEngine listFactSourcePages), from the store's facts and pages (facts/recall.rs). */
export const listFactSourcePages: Member<'listFactSourcePages'> = async (brain, ids) => {
  if (!ids.length) return [];
  if (!ids.every(Number.isSafeInteger)) refuseMember('listFactSourcePages', 'a fact id that is not an integer');
  return await storeCall({ member: 'listFactSourcePages' }, () => brain.listFactSourcePages([...ids])) as Awaited<ReturnType<BrainEngine['listFactSourcePages']>>;
};

/** memory_recall's date column (BrainEngine readFactWrittenDates): the written day of each fact, from the store's facts (facts/recall.rs). */
export const readFactWrittenDates: Member<'readFactWrittenDates'> = async (brain, ids) => {
  if (!ids.length) return [];
  if (!ids.every(Number.isSafeInteger)) refuseMember('readFactWrittenDates', 'a fact id that is not an integer');
  return await storeCall({ member: 'readFactWrittenDates' }, () => brain.readFactWrittenDates([...ids])) as Awaited<ReturnType<BrainEngine['readFactWrittenDates']>>;
};

/**
 * memory_recall's `own_page` flag (BrainEngine readOwnMemberFactIds): the facts among `ids` that are private facts on the caller's own
 * member page. The SQL admission (memberFactAdmitSql) names the caller's member and the page policy its member page must pass; the
 * store is sent exactly those when the rendered text equals the one for a fresh record of just the caller's reader identity (and
 * folder rules), the same judgement the widened fact lists make (fact-visibility.ts storeVisibility). Any other caller refuses.
 */
export const readOwnMemberFactIds: Member<'readOwnMemberFactIds'> = async (brain, sourceId, ids) => {
  const member = 'readOwnMemberFactIds';
  if (!ids.length || !callerMember()) return [];
  if (!ids.every(Number.isSafeInteger)) refuseMember(member, 'a fact id that is not an integer');
  const openFlag = currentCallerAccess().restricted === false ? { open: true } : {};
  const admit = judgeWidenedCaller<{ member: string; memberPagePolicy: StorePrivacyPolicy }>((readers) => {
    const text = memberFactAdmitSql('facts');
    const folders = callerFolders();
    const withFolders = folders.satisfiedRuleIds.length > 0 || folders.folderCoverage.length > 0;
    for (const record of withFolders ? [{}, folders] : [{}]) {
      const canonical = renderForStoreCaller({ ...readers, ...record, hidePrivate: true }, () => ({ sql: memberFactAdmitSql('facts'), member: callerMember() }));
      if (text !== canonical.sql || !canonical.member) continue;
      const pagePolicy = 'satisfiedRuleIds' in record ? callerFoldersPagePolicy(readers, folders) : callerReadersPagePolicy(readers);
      return { member: canonical.member, memberPagePolicy: { ...pagePolicy, ...openFlag } };
    }
    return undefined;
  });
  if (!admit) refuseMember(member, 'a caller whose member-page admission the store does not model (an audience, or a record that renders other text)');
  return await storeCall({ member, sourceId }, () => brain.readOwnMemberFactIds({ sourceId, ids: [...ids], ...admit })) as Awaited<ReturnType<BrainEngine['readOwnMemberFactIds']>>;
};

export const listNearestFacts: Member<'listNearestFacts'> = async (brain, q) => {
  const member = 'listNearestFacts';
  if (q.vector.type !== 'halfvec') refuseMember(member, 'a vector-typed facts embedding column');
  const pool = poolArgs(member, q.scope, q.filters);
  const found: Row[] = await storeCall({ member }, () => brain.listNearestFacts({
    pool,
    vector: { literal: q.vector.literal, model: q.vector.model, dims: q.vector.dims },
    declared: q.declared,
    limit: q.limit,
  }));
  return rows(found);
};

export const listSlotRows: Member<'listSlotRows'> = async (brain, scope, slots) => {
  const member = 'listSlotRows';
  const pool = poolArgs(member, scope, { includeExpired: true });
  const found: Row[] = await storeCall({ member }, () => brain.listSlotRows({
    pool,
    slots: slots.map(s => ({ sourceId: s.source_id, entitySlug: s.entity_slug, dimension: s.dimension })),
  }));
  return rows(found);
};

export const listPoolUnbackedKeys: Member<'listPoolUnbackedKeys'> = async (brain, scope, keys, limit) => {
  const member = 'listPoolUnbackedKeys';
  const pool = poolArgs(member, scope, undefined);
  return storeCall({ member }, () => brain.listPoolUnbackedKeys({ pool, keys: [...keys], limit }));
};

export const listCallOffCueFacts: Member<'listCallOffCueFacts'> = async (brain, scope, pairs) => {
  const member = 'listCallOffCueFacts';
  const pool = poolArgs(member, scope, undefined);
  const found: Row[] = await storeCall({ member }, () => brain.listCallOffCueFacts({
    pool,
    pairs: pairs.map(p => ({ sourceId: p.source_id, entitySlug: p.entity_slug })),
  }));
  return rows(found);
};

export const listPoolEntityPairs: Member<'listPoolEntityPairs'> = async (brain, scope, filters) => {
  const member = 'listPoolEntityPairs';
  const pool = poolArgs(member, scope, filters);
  return storeCall({ member }, () => brain.listPoolEntityPairs({ pool }));
};
