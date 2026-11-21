/**
 * Helpers that keep the store's link relationship state current after a Rust link write (links.ts, link-queries.ts):
 * the keys a write touches, a refresh through the shared builder (link-relationships.ts), and the engine-shaped view of
 * the store's temporal members that applyTemporalEvidence and replaceWantedLinks take. Not a member module: index.ts
 * does not spread it.
 */
import type { BrainEngine } from '../../engine.ts';
import { refreshRelationships, type RelationshipKey } from '../../link-relationships.ts';
import type { TemporalTx } from '../../link-temporal-apply.ts';
import { temporalLinkTypes } from '../../link-validity.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';
import * as temporal from './link-temporal.ts';

type EndpointPair = { from_slug: string; from_source_id: string; to_slug: string; to_source_id: string };

/** The relationship keys of temporal links, transitions and state between `pairs` or out of `fromPages`. */
export async function linkRelationshipKeysTouching(brain: StoreBrain, member: string,
  touching: { pairs?: EndpointPair[]; fromPages?: Array<{ slug: string; source_id: string }> }): Promise<RelationshipKey[]> {
  if (!touching.pairs?.length && !touching.fromPages?.length) return [];
  return storeCall({ member }, () => brain.linkRelationshipKeysTouching({
    pairs: touching.pairs ?? [], fromPages: touching.fromPages ?? [], linkTypes: temporalLinkTypes() }));
}

/** refreshRelationships over the store's evidence and state members. */
export async function refreshOnStore(brain: StoreBrain, keys: readonly RelationshipKey[]): Promise<void> {
  if (!keys.length) return;
  await refreshRelationships(temporalStore(brain), keys);
}

/** The store's temporal members as the engine members applyTemporalEvidence and relationshipKeysForOrigin call. */
export function temporalStore(brain: StoreBrain): TemporalTx & Pick<BrainEngine, 'linkRelationshipKeysForOrigin'> {
  return {
    readLinkRelationshipEvidence: keys => temporal.readLinkRelationshipEvidence(brain, keys),
    writeLinkRelationshipState: write => temporal.writeLinkRelationshipState(brain, write),
    applyLinkTemporalRows: input => temporal.applyLinkTemporalRows(brain, input),
    writeManualLinkTransitions: (rel, rows) => temporal.writeManualLinkTransitions(brain, rel, rows),
    removeManualLinkTransitions: rel => temporal.removeManualLinkTransitions(brain, rel),
    linkRelationshipKeysForOrigin: pageId => temporal.linkRelationshipKeysForOrigin(brain, pageId),
  };
}
