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
import { renderWriterReadPolicy } from '../../engine-sql/remote-links.ts';
import { validQualifiedRuleId } from '../../access/folder-rules.ts';
import type { RustEngine } from '../../rust-engine.ts';
import { callerAccessAllowedSql, labelledOnlyForSql, labelledOnlyTerms, privacyPartSql } from '../../search/private-visibility.ts';
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

/**
 * The store policy for the writer's read policy, or a refusal. A labelled-only writer's text is the rest of the policy ANDed
 * with the labelled-only conjunct (`renderWriterReadPolicy`): the rest is served as for any writer, and the conjunct goes to the
 * store as data (the sets `labelledOnlySql` embeds), once the text is shown to be exactly those two parts.
 */
function writerPolicy(policy: WriterReadPolicy, member = 'readLinkTargetPages'): StorePrivacyPolicy {
  if (!policy.labelledOnly) return unlabelledWriterPolicy(policy, member);
  const rest = unlabelledWriterPolicy({ ...policy, labelledOnly: false }, member);
  const terms = labelledOnlyTerms({ identity: [], audienceIdentities: policy.identities, satisfiedRuleIds: policy.satisfiedRuleIds });
  const expected = `(${renderWriterReadPolicy({ ...policy, labelledOnly: false }, 'p', false)} AND ${labelledOnlyForSql('p', policy.identities, policy.satisfiedRuleIds)})`;
  if (renderWriterReadPolicy(policy, 'p', false) !== expected) refuseMember(member, 'a labelled-only writer whose policy is not the member-access policy and the labelled-only conjunct');
  return { ...rest, labelledOnly: terms };
}

/** The store policy for the member-access and privacy parts of the writer's read policy, or a refusal. */
function unlabelledWriterPolicy(policy: WriterReadPolicy, member = 'readLinkTargetPages'): StorePrivacyPolicy {
  const text = renderWriterReadPolicy(policy, 'p', false);
  const off = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(text, 'pages', 'p') };
  const fragment = (record: Parameters<typeof renderForStoreCaller>[0]) =>
    `(${renderForStoreCaller(record, () => callerAccessAllowedSql('p'))} AND TRUE)`;
  if (text === fragment({})) return off;
  // A writer with no identity (an unbound or anonymous writer): its policy renders in a record of its own folder
  // coverage, so the store reads that coverage instead of the live pending prefixes (callerRecord).
  const folderCoverage = policy.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix }));
  if (!policy.identities.length && text === fragment({ identity: [], satisfiedRuleIds: [], folderCoverage })) {
    return { ...off, identity: [], ...(folderCoverage.length ? { folderCoverage } : {}), callerRecord: true };
  }
  const [identity] = policy.identities;
  // The owner speaking for itself renders the same text without the owner-only clause (CallerAccess.owner), which `off` reads as no test.
  const oneIdentity = (owner: boolean, folders: object) => policy.identities.length === 1 && identity
    && text === fragment({ identity: [...identity], privateReadableSources: [], hidePrivate: true, ...folders, ...(owner ? { owner } : {}) });
  if (oneIdentity(false, {}) || oneIdentity(true, {})) {
    return { ...off, identity: [...identity], privateReadableSources: [] };
  }
  // One identity under folder rules it satisfies and the pending prefixes its record names: the record's own folder access
  // (callerRecord), as the no-identity form above, judged for that identity.
  if (identity && (policy.satisfiedRuleIds.length || folderCoverage.length)) {
    const folders = { satisfiedRuleIds: [...policy.satisfiedRuleIds], folderCoverage };
    // The SQL text drops the whole set when one id is not a valid qualified id (folderRulesAllowedSql); so does the store's.
    const satisfiedRuleIds = policy.satisfiedRuleIds.every(validQualifiedRuleId) ? folders.satisfiedRuleIds : [];
    if (oneIdentity(false, folders) || oneIdentity(true, folders)) {
      return { ...off, identity: [...identity], privateReadableSources: [], callerRecord: true,
        ...(satisfiedRuleIds.length ? { satisfiedRuleIds } : {}), ...(folderCoverage.length ? { folderCoverage } : {}) };
    }
  }
  refuseMember(member, 'a writer whose owner record or identities widen the member-access policy');
}

export const readLinkTargetPages: StoreMember<[sourceId: string, slugs: readonly string[], policy: WriterReadPolicy | null], LinkTargetPage[]> =
  async (brain, sourceId, slugs, policy) => {
    const storePolicy = policy ? writerPolicy(policy) : null;
    if (!slugs.length) return [];
    const { honorAliases } = pagePolicyFlags(privacyPartSql('p'));
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
    const { honorAliases } = pagePolicyFlags(privacyPartSql('p'));
    return Boolean(await storeCall({ member: 'readPageHiddenFromWriter', sourceId, slug }, () =>
      brain.readPageHiddenFromWriter(sourceId, slug, storePolicy, hidePrivate, honorAliases)));
  };

export const rearmLinksEffects: StoreMember<[opts: LinksRearm], number> = async (brain, opts) => {
  if (!opts.requestIds.length) return 0;
  return Number(await storeCall({ member: 'rearmLinksEffects', sourceId: opts.sourceId }, () =>
    brain.rearmLinksEffects({ sourceId: opts.sourceId, requestIds: [...opts.requestIds], ...(opts.slugs ? { slugs: [...opts.slugs] } : {}) })));
};
