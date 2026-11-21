/**
 * The folder-rule policy members access/policy.ts runs (readAccessStoreConfig through replaceAccessInvalidCoverage;
 * SQL in engine-sql/access-policy.ts), served by gbrain-store `access_policy` over the `access_rules` records. Each
 * write is one store write, so a refused change leaves nothing of itself behind, and policy.ts's row locks are the store
 * write transaction RustEngine.transaction holds. What each member answers: rust/docs/store/access_rules.md.
 */
import type {
  AccessCoverageRow, AccessPolicyMarks, AccessRestampWindow, AccessRevisionInsert, AccessRevisionQuery, AccessRevisionRow, AccessRuleChanges, AccessRuleRow,
} from '../../engine-sql/access-policy.ts';
import { RULE_COVERED_PAGES_LIMIT } from '../../engine-sql/access-policy.ts';
import { ruleCovers } from '../../access/folder-rules.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readAccessStoreConfig: StoreMember<[sourceId: string], { store: string | null } | null> = (brain, sourceId) =>
  storeCall({ member: 'readAccessStoreConfig', sourceId }, () => brain.readAccessStoreConfig(sourceId));

export const writeAccessStoreConfig: StoreMember<[sourceId: string, store: string], void> = async (brain, sourceId, store) => {
  await storeCall({ member: 'writeAccessStoreConfig', sourceId }, () => brain.writeAccessStoreConfig(sourceId, store));
};

export const ensureAccessPolicyState: StoreMember<[sourceId: string], void> = async (brain, sourceId) => {
  await storeCall({ member: 'ensureAccessPolicyState', sourceId }, () => brain.ensureAccessPolicyState(sourceId));
};

/** One statement under the writer gate; inside RustEngine.transaction the gate is held until it ends, which is the lock. */
export const lockAccessPolicy: StoreMember<[sourceId: string], void> = async (brain, sourceId) => {
  await storeCall({ member: 'lockAccessPolicy', sourceId }, () => brain.lockAccessPolicy(sourceId));
};

export const listAccessRules: StoreMember<[sourceId: string], AccessRuleRow[]> = (brain, sourceId) =>
  storeCall({ member: 'listAccessRules', sourceId }, () => brain.listAccessRules(sourceId));

export const readAccessPolicyRevisions: StoreMember<[query: AccessRevisionQuery], AccessRevisionRow[]> = (brain, query) =>
  storeCall({ member: 'readAccessPolicyRevisions', sourceId: 'sourceId' in query ? query.sourceId : undefined }, () => brain.readAccessPolicyRevisions(query));

export const listAccessCoverage: StoreMember<[sourceId: string], AccessCoverageRow[]> = (brain, sourceId) =>
  storeCall({ member: 'listAccessCoverage', sourceId }, () => brain.listAccessCoverage(sourceId));

export const applyAccessRuleChanges: StoreMember<[sourceId: string, changes: AccessRuleChanges], void> = async (brain, sourceId, changes) => {
  const sent = {
    remove: [...changes.remove], pending: [...changes.pending], revision: changes.revision, actor: changes.actor,
    insert: changes.insert.map(r => ({ rule_id: r.rule_id, prefix: r.prefix, readable_by: [...r.readable_by], covers_derived: r.covers_derived })),
  };
  await storeCall({ member: 'applyAccessRuleChanges', sourceId }, () => brain.applyAccessRuleChanges(sourceId, sent));
};

export const restampAccessWindow: StoreMember<[sourceId: string, after: number, batch: number], AccessRestampWindow> = (brain, sourceId, after, batch) =>
  storeCall({ member: 'restampAccessWindow', sourceId }, () => brain.restampAccessWindow(sourceId, after, batch));

export const finishAccessRestamp: StoreMember<[sourceId: string], number> = (brain, sourceId) =>
  storeCall({ member: 'finishAccessRestamp', sourceId }, () => brain.finishAccessRestamp(sourceId));

/** A revision number the source has, or an operation id any source recorded, refuses `constraint_violation`. */
export const insertAccessPolicyRevision: StoreMember<[row: AccessRevisionInsert], void> = async (brain, row) => {
  const sent = { ...row, rules: row.rules === undefined ? null : JSON.parse(JSON.stringify(row.rules)) };
  await storeCall({ member: 'insertAccessPolicyRevision', sourceId: row.source_id }, () => brain.insertAccessPolicyRevision(sent));
};

export const markAccessRevisionsApplied: StoreMember<[sourceId: string, upTo?: number], void> = async (brain, sourceId, upTo) => {
  await storeCall({ member: 'markAccessRevisionsApplied', sourceId }, () => brain.markAccessRevisionsApplied(sourceId, upTo));
};

export const approveAccessPolicyRevision: StoreMember<[sourceId: string, revision: number, actor: string], void> = async (brain, sourceId, revision, actor) => {
  await storeCall({ member: 'approveAccessPolicyRevision', sourceId }, () => brain.approveAccessPolicyRevision(sourceId, revision, actor));
};

export const hasAccessPolicyState: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasAccessPolicyState', sourceId }, () => brain.hasAccessPolicyState(sourceId));

export const listAccessPrefixSlugs: StoreMember<[sourceId: string, prefixes: string | readonly string[]], string[]> = (brain, sourceId, prefixes) =>
  storeCall({ member: 'listAccessPrefixSlugs', sourceId }, () => brain.listAccessPrefixSlugs(sourceId, typeof prefixes === 'string' ? [prefixes] : [...prefixes]));

export const readAccessPolicyMarks: StoreMember<[sourceId: string, operationId?: string], AccessPolicyMarks> = (brain, sourceId, operationId) =>
  storeCall({ member: 'readAccessPolicyMarks', sourceId }, () => brain.readAccessPolicyMarks(sourceId, operationId));

export const replaceAccessInvalidCoverage: StoreMember<[sourceId: string, prefixes: readonly string[], detail: unknown], void> = async (brain, sourceId, prefixes, detail) => {
  const sent = detail === undefined ? null : JSON.parse(JSON.stringify(detail));
  await storeCall({ member: 'replaceAccessInvalidCoverage', sourceId }, () => brain.replaceAccessInvalidCoverage(sourceId, [...prefixes], sent));
};

/** The live slugs of a source any of `prefixes` covers (`ruleCoversSql`: `''` covers the whole source), by slug bytes. */
async function covered(brain: StoreBrain, member: string, sourceId: string, prefixes: readonly string[]): Promise<string[]> {
  const slugs = await storeCall({ member, sourceId }, () => brain.listAccessPrefixSlugs(sourceId, [...prefixes])) as string[];
  return slugs.filter(slug => prefixes.some(p => p === '' || ruleCovers(slug, p)));
}

export const countRuleCoveredPages: StoreMember<[sourceId: string, prefixes: string | readonly string[]], number> = async (brain, sourceId, prefixes) =>
  (await covered(brain, 'countRuleCoveredPages', sourceId, typeof prefixes === 'string' ? [prefixes] : prefixes)).length;

export const listRuleCoveredSlugs: StoreMember<[sourceId: string, prefixes: readonly string[]], string[]> = (brain, sourceId, prefixes) =>
  covered(brain, 'listRuleCoveredSlugs', sourceId, prefixes);

export const listRuleCoveredPages: StoreMember<[sourceId: string, prefix: string], Array<{ source_id: string; slug: string }>> = async (brain, sourceId, prefix) =>
  (await covered(brain, 'listRuleCoveredPages', sourceId, [prefix])).slice(0, RULE_COVERED_PAGES_LIMIT).map(slug => ({ source_id: sourceId, slug }));
