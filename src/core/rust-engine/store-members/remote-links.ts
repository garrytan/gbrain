/**
 * The remote links effect's members (BrainEngine setEffectTransactionLimits, readOwnedLinks, deleteOwnedLinks,
 * readLinkTargetPages, rearmLinksEffects): the edges one producer owns from a page, their removal, which of a list of
 * pages the writer reads and the privacy part shows, and the re-arm of a batch's `links` effects
 * (engine-sql/remote-links.ts on the SQL engines; gbrain-store `remote_links.rs` and `rearm_links_effects`).
 *
 * The store has no lock or statement timeout, so the effect transaction's limits do nothing. The writer's read policy
 * is rendered as PGLite renders it and served only when it equals the no-caller member-access rendering or a fresh
 * record's rendering for the writer's one reader identity, with or without the owner flag the owner's own call renders (the forms
 * `page_hidden` in facts/privacy.rs implements); any
 * other writer (folder rules, an owner record, a labelled-only grant, several identities) refuses with
 * `engine_capability_missing`, before any read. What each member answers and why: rust/docs/store/remote-links.md.
 */
import type { LinksRearm, LinkTargetPage, OwnedLink, WriterReadPolicy } from '../../engine-sql/remote-links.ts';
import { renderWriterReadPolicy } from '../../engine-sql/remote-links.ts';
import type { RustEngine } from '../../rust-engine.ts';
import { callerAccessAllowedSql, privacyPartSql } from '../../search/private-visibility.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { ownerOnlyFormIn, pagePolicyFlags, renderForStoreCaller, type StorePrivacyPolicy } from './private-provenance.ts';

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

/** The store policy for the writer's read policy, or a refusal. */
function writerPolicy(policy: WriterReadPolicy): StorePrivacyPolicy {
  const text = renderWriterReadPolicy(policy, 'p', false);
  const off = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(text, 'pages', 'p') };
  const fragment = (record: Parameters<typeof renderForStoreCaller>[0]) =>
    `(${renderForStoreCaller(record, () => callerAccessAllowedSql('p'))} AND TRUE)`;
  if (text === fragment({})) return off;
  const [identity] = policy.identities;
  // The owner speaking for itself renders the same text without the owner-only clause (CallerAccess.owner), which `off` reads as no test.
  const oneIdentity = (owner: boolean) => policy.identities.length === 1 && identity && text === fragment({ identity: [...identity], privateReadableSources: [], hidePrivate: true, ...(owner ? { owner } : {}) });
  if (oneIdentity(false) || oneIdentity(true)) {
    return { ...off, identity: [...identity], privateReadableSources: [] };
  }
  refuseMember('readLinkTargetPages', 'a writer whose folder rules, owner record, labelled-only grant or identities widen the member-access policy');
}

export const readLinkTargetPages: StoreMember<[sourceId: string, slugs: readonly string[], policy: WriterReadPolicy | null], LinkTargetPage[]> =
  async (brain, sourceId, slugs, policy) => {
    const storePolicy = policy ? writerPolicy(policy) : null;
    if (!slugs.length) return [];
    const { honorAliases } = pagePolicyFlags(privacyPartSql('p'));
    return storeCall({ member: 'readLinkTargetPages', sourceId }, () =>
      brain.readLinkTargetPages(sourceId, [...slugs], storePolicy, honorAliases));
  };

export const rearmLinksEffects: StoreMember<[opts: LinksRearm], number> = async (brain, opts) => {
  if (!opts.requestIds.length) return 0;
  return Number(await storeCall({ member: 'rearmLinksEffects', sourceId: opts.sourceId }, () =>
    brain.rearmLinksEffects({ sourceId: opts.sourceId, requestIds: [...opts.requestIds], ...(opts.slugs ? { slugs: [...opts.slugs] } : {}) })));
};
