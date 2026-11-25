/**
 * delete_page's derived-origin carry and the label door (BrainEngine readPrivacyOrigin, listOriginDependents,
 * listCheckoutFiles, readPageLabelRow and writePageLabelGuard; SQL in engine-sql/label-door.ts), served from the store's
 * page, link, alias, rename and source records and its label guard records (gbrain-store `label_door`).
 *
 * The privacy rules are the store's `privacy_allows` (privacyPartSql). `honorAliases` is read off the rendered snapshot
 * filter, the one process setting privacyPartSql reads (readHonorAliases sets it), so both engines judge by the same
 * setting. What each member answers and why: rust/docs/store/label_door.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const honorAliases = (): boolean => privateSnapshotFilterFragment('h').includes(privacyAliasSql('h'));

export const readPrivacyOrigin: Member<'readPrivacyOrigin'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readPrivacyOrigin' }, () => brain.readPrivacyOrigin(sourceId, slug, honorAliases()));

export const listOriginDependents: Member<'listOriginDependents'> = (brain, origins) =>
  storeCall({ member: 'listOriginDependents' }, () => brain.listOriginDependents(
    origins.map(o => ({ id: o.id, sourceId: o.source_id, slug: o.slug })), honorAliases()));

export const listCheckoutFiles: Member<'listCheckoutFiles'> = (brain, pageIds) =>
  storeCall({ member: 'listCheckoutFiles' }, () => brain.listCheckoutFiles([...pageIds]));

export const readPageLabelRow: Member<'readPageLabelRow'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readPageLabelRow' }, () => brain.readPageLabelRow(sourceId, slug));

/** The page's owner-set guard tier and its open `lower_page` prior tiers (label_door.rs read_label_guard_tiers). */
export const readLabelGuardTiers: Member<'readLabelGuardTiers'> = (brain, pageId) =>
  storeCall({ member: 'readLabelGuardTiers' }, () => brain.readLabelGuardTiers(pageId));

export const writePageLabelGuard: Member<'writePageLabelGuard'> = (brain, pageId, tier) =>
  storeCall({ member: 'writePageLabelGuard' }, () => brain.writePageLabelGuard(pageId, tier));
