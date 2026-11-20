/**
 * The page visibility guards (BrainEngine readPageHiddenFromCaller, readCallerPageAccess, readPageWorldVisible, readWriteVisibilityProbe,
 * readWriterSlugFence): the reads a remote page write runs to learn whether the caller may see a page, which of a list
 * of pages the caller reads, what its visibility check opens with, and whether a stored writer carries a slug fence
 * (engine-sql/page-visibility.ts on the SQL engines).
 *
 * PGLite renders the caller's page policy in its access record. The store implements the no-caller rendering and a
 * fresh record of only a reader identity and a private-readable grant (`page_hidden` in facts/privacy.rs). The member
 * renders the PGLite fragment over `p` in the current context and serves the read only when it equals one of those:
 * the `read` part through storePageTextPolicy, the `access` part (member access alone) here, with the privacy part
 * off. Any other caller (folder rules, an audience, lineage, a labelled-only grant) refuses with
 * `engine_capability_missing`, before any read.
 *
 * The store keeps no OAuth clients, so an OAuth client's fence refuses; a local writer's fence is its stored grant
 * ceiling's `slugPrefixes`. What each member answers and why: rust/docs/store/page-visibility.md.
 */
import type { CallerPageAccessRow, PagePolicyPart, WriteVisibilityProbe } from '../../engine-sql/page-visibility.ts';
import { callerAccessAllowedSql, currentCallerAccess, privatePagesFilterForCaller, privatePagesFilterFragment, readPolicyFragment, withCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { judgeWidenedCaller, ownerOnlyFormIn, renderForStoreCaller, storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

/**
 * The store policy for page policy part `part` of the current caller, or a refusal. The caller is judged by
 * judgeWidenedCaller (private-provenance.ts), which also judges a caller on a brain whose config holds no member-access
 * restriction, anonymous or with a reader identity, under the restricted rendering the store implements.
 */
function callerPolicy(member: string, part: PagePolicyPart): StorePrivacyPolicy {
  if (part === 'read') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true });
  const policy = judgeWidenedCaller<StorePrivacyPolicy>(readers => {
    const text = callerAccessAllowedSql('p');
    const off = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(text, 'pages', 'p') };
    if (text === renderForStoreCaller({}, () => callerAccessAllowedSql('p'))) return off;
    const canonical = renderForStoreCaller({ ...readers, hidePrivate: true }, () => callerAccessAllowedSql('p'));
    return text === canonical ? { ...off, ...readers } : undefined;
  });
  if (policy) return policy;
  refuseMember(member, 'a caller whose member pages, grants or lineage widen the member-access policy');
}

export const readPageHiddenFromCaller: StoreMember<[sourceId: string, slug: string, opts: { policy: PagePolicyPart }], boolean> =
  async (brain, sourceId, slug, opts) => {
    const policy = callerPolicy('readPageHiddenFromCaller', opts.policy);
    return await storeCall({ member: 'readPageHiddenFromCaller', slug, sourceId }, () => brain.readPageHiddenFromCaller(sourceId, slug, policy)) === true;
  };

export const readCallerPageAccess: StoreMember<[pages: readonly { source_id: string; slug: string }[], opts: { policy: PagePolicyPart }], CallerPageAccessRow[]> =
  async (brain, pages, opts) => {
    const policy = callerPolicy('readCallerPageAccess', opts.policy);
    if (pages.length === 0) return [];
    return storeCall({ member: 'readCallerPageAccess' }, () =>
      brain.readCallerPageAccess(pages.map(p => ({ sourceId: p.source_id, slug: p.slug })), policy));
  };

/**
 * The probe's page policy is the empty-identity policy with privacy (`readPolicyFragment(p, [], true)`), whoever the
 * caller is. It is rendered in the current record with the identity and grant emptied, and served when it equals the
 * no-caller rendering or a fresh record's rendering for the empty identity (storePageTextPolicy with callerReaders).
 * On a brain whose config holds no member-access restriction it is judged under the restricted rendering, for the
 * reason callerPolicy gives.
 */
export const readWriteVisibilityProbe: StoreMember<[sourceId: string, slug: string], WriteVisibilityProbe | undefined> =
  async (brain, sourceId, slug) => {
    const policy = withCallerAccess({ restricted: true, identity: [], privateReadableSources: [] }, () =>
      storePageTextPolicy('readWriteVisibilityProbe', () => readPolicyFragment('p', [], true), { callerReaders: true }));
    return await storeCall({ member: 'readWriteVisibilityProbe', slug, sourceId }, () =>
      brain.readWriteVisibilityProbe(sourceId, slug, policy)) as WriteVisibilityProbe;
  };

/**
 * World visibility is the empty-identity policy with privacy (`privatePagesFilterFragment`): no reader identity, grant
 * or satisfied folder rule counts. It is judged as the probe's policy is, under the restricted rendering with the
 * identity and grant emptied, and answered by the live-row read readCallerPageAccess runs: a missing or soft-deleted
 * page is not world-visible. Two parts of the caller's record still count, as they do in the SQL fragment: its folder
 * coverage (a page under a pending or invalid prefix is hidden; the policy carries it) and its owner flag (an owner read
 * renders no owner-only test, so the policy is sent with the owner-only test off).
 */
export const readPageWorldVisible: StoreMember<[sourceId: string, slug: string], boolean> = async (brain, sourceId, slug) => {
  const owner = currentCallerAccess().owner;
  const rendered = withCallerAccess({ restricted: true, identity: [], privateReadableSources: [] }, () =>
    storePageTextPolicy('readPageWorldVisible', () => privatePagesFilterFragment('p'), { callerReaders: true }));
  const policy: StorePrivacyPolicy = owner ? { ...rendered, ownerOnly: 'off' } : rendered;
  const rows = await storeCall({ member: 'readPageWorldVisible', slug, sourceId }, () =>
    brain.readCallerPageAccess([{ sourceId, slug }], policy)) as CallerPageAccessRow[];
  return rows.some(row => row.source_id === sourceId && row.slug === slug && row.readable === true);
};

/** A local writer's fence comes from the stored registration; an OAuth client's refuses (the store keeps no OAuth clients). */
export const readWriterSlugFence: StoreMember<[principal: { kind: string; id: string }], unknown> = async (brain, principal) => {
  if (principal.kind === 'oauth_client') refuseMember('readWriterSlugFence', 'an OAuth client fence (the store keeps no OAuth clients)');
  if (principal.kind !== 'local_cli' && principal.kind !== 'local_stdio') return null;
  const row = await storeCall({ member: 'readWriterSlugFence' }, () => brain.readLocalWriter(principal.id)) as
    { grant_ceiling?: { slugPrefixes?: unknown } | null } | null;
  return row?.grant_ceiling?.slugPrefixes ?? null;
};
