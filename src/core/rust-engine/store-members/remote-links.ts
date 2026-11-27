/**
 * The remote links effect's members (BrainEngine setEffectTransactionLimits, readOwnedLinks, deleteOwnedLinks,
 * readLinkTargetPages, rearmLinksEffects): the edges one producer owns from a page, their removal, which of a list of
 * pages the writer reads and the privacy part shows, and the re-arm of a batch's `links` effects
 * (engine-sql/remote-links.ts on the SQL engines; gbrain-store `remote_links.rs` and `rearm_links_effects`).
 *
 * The store has no lock or statement timeout, so the effect transaction's limits do nothing. The writer's read policy
 * is rendered as PGLite renders it and served only when it equals the no-caller member-access rendering or a fresh
 * record's rendering for the writer's one reader identity (with the folder rules it satisfies and the coverage its record
 * names), with or without the owner flag the owner's own call renders (the forms `page_hidden` in facts/privacy.rs
 * implements), and, for a labelled-only writer, that rendering ANDed with the labelled-only conjunct, which the store
 * judges from the writer's identities and satisfied rules; any other writer (an owner record, several identities)
 * refuses with `engine_capability_missing`, before any read. What each member answers and why: rust/docs/store/remote-links.md.
 */
import type { LinksRearm, LinkTargetPage, OwnedLink, WriterReadPolicy } from '../../engine-sql/remote-links.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import { storeCall, type StoreMember } from './common.ts';
import { writerPolicy } from './access-policies.ts';
import { privacyPartAliases } from './private-provenance.ts';

/** The links transaction's settings: the store has no lock wait or statement limit. Refuses on an ended transaction. */
export const setEffectTransactionLimits = async function setEffectTransactionLimits(this: RustEngine, _brain: StoreBrain): Promise<void> {
  if (this._txScope?.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'setEffectTransactionLimits' });
};

export const readOwnedLinks: StoreMember<[linkSource: string, originPageId: number | string], OwnedLink[]> =
  async (brain, linkSource, originPageId) => {
    const rows = await storeCall({ member: 'readOwnedLinks' }, () => brain.readOwnedLinks(linkSource, String(originPageId))) as OwnedLink[];
    return rows.map(r => ({ id: Number(r.id), slug: r.slug }));
  };

export const deleteOwnedLinks: StoreMember<[originPageId: number | string, linkSource: string, ids: readonly (number | string)[]], number> =
  async (brain, originPageId, linkSource, ids) => {
    if (!ids.length) return 0;
    return Number(await storeCall({ member: 'deleteOwnedLinks' }, () =>
      brain.deleteOwnedLinks(String(originPageId), linkSource, ids.map(String))));
  };

export const readLinkTargetPages: StoreMember<[sourceId: string, slugs: readonly string[], policy: WriterReadPolicy | null], LinkTargetPage[]> =
  async (brain, sourceId, slugs, policy) => {
    const storePolicy = policy ? writerPolicy(policy) : null;
    if (!slugs.length) return [];
    const honorAliases = privacyPartAliases('readLinkTargetPages');
    return storeCall({ member: 'readLinkTargetPages', sourceId }, () =>
      brain.readLinkTargetPages(sourceId, [...slugs], storePolicy, honorAliases));
  };

/**
 * Whether a row of the slug, live or soft-deleted, fails the writer's read policy (and the privacy part when `hidePrivate`).
 * The writer shapes are the ones readLinkTargetPages serves, refused before the store is asked; the store judges the row.
 */
export const readPageHiddenFromWriter: StoreMember<[sourceId: string, slug: string, policy: WriterReadPolicy, hidePrivate: boolean], boolean> =
  async (brain, sourceId, slug, policy, hidePrivate) => {
    const storePolicy = writerPolicy(policy, 'readPageHiddenFromWriter');
    const honorAliases = privacyPartAliases('readPageHiddenFromWriter');
    return Boolean(await storeCall({ member: 'readPageHiddenFromWriter', sourceId, slug }, () =>
      brain.readPageHiddenFromWriter(sourceId, slug, storePolicy, hidePrivate, honorAliases)));
  };

export const rearmLinksEffects: StoreMember<[opts: LinksRearm], number> = async (brain, opts) => {
  if (!opts.requestIds.length) return 0;
  return Number(await storeCall({ member: 'rearmLinksEffects', sourceId: opts.sourceId }, () =>
    brain.rearmLinksEffects({ sourceId: opts.sourceId, requestIds: [...opts.requestIds], ...(opts.slugs ? { slugs: [...opts.slugs] } : {}) })));
};
