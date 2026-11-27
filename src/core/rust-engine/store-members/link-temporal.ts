/**
 * Link temporal state (src/core/engine-sql/link-temporal.ts): the relationship evidence and state rows, the origin's
 * tense and derived transitions, manual transitions and the relationship keys a write touches. The store keeps them
 * under `q <source> \0 R` and `q <source> \0 T` (rust/docs/store/link_temporal.md). The relationship builder stays in
 * TypeScript (link-relationships.ts): it reads the pack's relation semantics, which live in this process.
 *
 * Export only BrainEngine members from this file (index.ts spreads the module into STORE_MEMBERS); helpers stay
 * unexported.
 */
import type * as LinkTemporalSql from '../../engine-sql/link-temporal.ts';
import { DERIVED_TRANSITION_PRODUCERS } from '../../engine-sql/link-temporal.ts';
import type { RelationshipEvidence, RelationshipKey, RelationshipStateWrite } from '../../link-relationships.ts';
import { temporalLinkTypes } from '../../link-validity.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';
import { pagePolicyFlags } from './private-provenance.ts';

/** The no-caller page policy of `privatePagesFilterFragment`, which decides whether an evidence origin is public. */
function originPolicy() {
  return pagePolicyFlags('readLinkRelationshipEvidence', privatePagesFilterFragment('p'));
}

const ids = (pageIds: readonly number[]) => pageIds.map(Number);

export const applyLinkTemporalRows: StoreMember<[input: LinkTemporalSql.LinkTemporalRows], LinkTemporalSql.LinkTemporalApplied> = (brain, input) =>
  storeCall({ member: 'applyLinkTemporalRows', sourceId: input.sourceId }, () => brain.applyLinkTemporalRows({
    pageId: Number(input.pageId), sourceId: input.sourceId, tenseRows: input.tenseRows, transitions: input.transitions,
    explicitTargets: input.explicitTargets, producers: DERIVED_TRANSITION_PRODUCERS, linkTypes: temporalLinkTypes(),
  }));

export const writeManualLinkTransitions: StoreMember<[rel: LinkTemporalSql.ManualLinkRelationship,
  rows: ReadonlyArray<{ kind: 'start' | 'end'; occurred_on: string }>], { inserted: number; key: RelationshipKey | null }> =
  (brain, rel, rows) => storeCall({ member: 'writeManualLinkTransitions', sourceId: rel.sourceId }, () =>
    brain.writeManualLinkTransitions({ rel: { from: rel.from, to: rel.to, linkType: rel.linkType, sourceId: rel.sourceId }, rows: [...rows] }));

export const removeManualLinkTransitions: StoreMember<[rel: { from: string; to: string; linkType?: string; sourceId: string; databaseOnly?: boolean }],
  RelationshipKey[]> = (brain, rel) => storeCall({ member: 'removeManualLinkTransitions', sourceId: rel.sourceId }, () =>
    brain.removeManualLinkTransitions({ from: rel.from, to: rel.to, linkType: rel.linkType ?? null, sourceId: rel.sourceId,
      databaseOnly: rel.databaseOnly === true }));

export const readLinkRelationshipEvidence: StoreMember<[keys: readonly RelationshipKey[]], RelationshipEvidence> = (brain, keys) =>
  storeCall({ member: 'readLinkRelationshipEvidence' }, () =>
    brain.readLinkRelationshipEvidence({ keys: [...keys], originPolicy: originPolicy() }));

export const writeLinkRelationshipState: StoreMember<[write: RelationshipStateWrite], number> = (brain, write) =>
  storeCall({ member: 'writeLinkRelationshipState' }, () =>
    brain.writeLinkRelationshipState({ upserts: write.upserts, removals: write.removals, changed: write.changed }));

export const linkRelationshipKeysForOrigin: StoreMember<[pageId: number], RelationshipKey[]> = (brain, pageId) =>
  storeCall({ member: 'linkRelationshipKeysForOrigin' }, () =>
    brain.linkRelationshipKeysForOrigin({ pageId: Number(pageId), linkTypes: temporalLinkTypes() }));

export const linkRelationshipKeysForPages: StoreMember<[pageIds: readonly number[]], RelationshipKey[]> = async (brain, pageIds) =>
  pageIds.length === 0 ? [] : storeCall({ member: 'linkRelationshipKeysForPages' }, () =>
    brain.linkRelationshipKeysForPages({ pageIds: ids(pageIds), linkTypes: temporalLinkTypes() }));

export const staleLinkRelationshipKeys: StoreMember<[limit: number], RelationshipKey[]> = (brain, limit) =>
  storeCall({ member: 'staleLinkRelationshipKeys' }, () =>
    brain.staleLinkRelationshipKeys({ limit: Math.max(0, Math.trunc(limit)), linkTypes: temporalLinkTypes() }));
