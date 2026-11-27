/**
 * The page visibility guards (BrainEngine readPageHiddenFromCaller, readCallerPageAccess, readPageWorldVisible, readWriteVisibilityProbe,
 * readPagePrivacyHidden, readWriterSlugFence): the reads a remote page write runs to learn whether the caller may see a page, which of a list
 * of pages the caller reads, what its visibility check opens with, and whether a stored writer carries a slug fence
 * (engine-sql/page-visibility.ts on the SQL engines).
 *
 * PGLite renders the caller's page policy in its access record. The store implements the no-caller rendering and a
 * fresh record of only a reader identity and a private-readable grant (`page_hidden` in facts/privacy.rs). The member
 * renders the PGLite fragment over `p` in the current context and serves the read only when it equals one of those:
 * the `read` part through storePageTextPolicy, the `access` part (member access alone) here, with the privacy part
 * off. A labelled-only grant or a member's lineage read is served with the caller's folder rules (callerReference); any other
 * caller (folder rules alone, an audience) refuses with `engine_capability_missing`, before any read.
 *
 * The store keeps OAuth clients, but this read does not read a client's fence yet, so it refuses; a local writer's fence is its stored grant
 * ceiling's `slugPrefixes`. What each member answers and why: rust/docs/store/page-visibility.md.
 */
import type { CallerPageAccessRow, PagePolicyPart, PrivateOnlySlugScope, WriteVisibilityProbe } from '../../engine-sql/page-visibility.ts';
import { callerAccessAllowedSql, currentCallerAccess, privacyPartSql, privatePagesFilterForCaller, privatePagesFilterFragment, readPolicyFragment, withCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { selfChecked } from '../access-self-check.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';
import { callerFolders, callerReference, judgeWidenedCaller, ownerOnlyFormIn, pagePolicyFlags, privacyPartAliases, renderForStoreCaller, storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

/**
 * The store policy for page policy part `part` of the current caller, or a refusal. The caller is judged by
 * judgeWidenedCaller (private-provenance.ts), which also judges a caller on a brain whose config holds no member-access
 * restriction, anonymous or with a reader identity, under the restricted rendering the store implements.
 */
function callerPolicy(member: string, part: PagePolicyPart): StorePrivacyPolicy {
  if (part === 'read') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true, fragment: 'caller' });
  return selfChecked(member, { mode: 'member_access' }, () => callerAccessPolicyRendered(member));
}

/** The `access` part of {@link callerPolicy}: member access alone, with the privacy part off. */
function callerAccessPolicyRendered(member: string): StorePrivacyPolicy {
  const policy = judgeWidenedCaller<StorePrivacyPolicy>(readers => {
    const text = callerAccessAllowedSql('p');
    const off = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(text, 'pages', 'p') };
    if (text === renderForStoreCaller({}, () => callerAccessAllowedSql('p'))) return off;
    const canonical = renderForStoreCaller({ ...readers, hidePrivate: true }, () => callerAccessAllowedSql('p'));
    if (text === canonical) return { ...off, ...readers };
    // The same record with the caller's folder rules (an ordinary member that satisfies a rule too), and with the grants when it has any.
    const reference = callerReference();
    if (!reference) return undefined;
    const folders = callerFolders();
    const withGrants = renderForStoreCaller({ ...readers, ...folders, ...reference.record, hidePrivate: true }, () => callerAccessAllowedSql('p'));
    if (text !== withGrants) return undefined;
    return {
      ...off, ...readers, callerRecord: true, ...reference.flags,
      ...(folders.satisfiedRuleIds.length ? { satisfiedRuleIds: folders.satisfiedRuleIds } : {}),
      ...(folders.folderCoverage.length ? { folderCoverage: folders.folderCoverage } : {}),
    };
  });
  if (policy) return policy;
  refuseMember(member, 'a caller whose member pages, grants or lineage widen the member-access policy');
}

export const readPageHiddenFromCaller: StoreMember<[sourceId: string, slug: string, opts: { policy: PagePolicyPart }], boolean> =
  async (brain, sourceId, slug, opts) => {
    const policy = callerPolicy('readPageHiddenFromCaller', opts.policy);
    return await storeCall({ member: 'readPageHiddenFromCaller', slug, sourceId }, () => brain.readPageHiddenFromCaller(sourceId, slug, policy)) === true;
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

export const readCallerPageAccess: StoreMember<[pages: readonly { source_id: string; slug: string }[], opts: { policy: PagePolicyPart }], CallerPageAccessRow[]> =
  async (brain, pages, opts) => {
    const policy = callerPolicy('readCallerPageAccess', opts.policy);
    if (pages.length === 0) return [];
    return storeCall({ member: 'readCallerPageAccess' }, () =>
      brain.readCallerPageAccess(pages.map(p => ({ sourceId: p.source_id, slug: p.slug })), policy));
  };

/**
 * get_page's fuzzy candidates: the slugs whose every in-scope row the caller's page policy (the `read` part) hides. The
 * scope keeps the SQL's precedence (a non-empty array, else a non-empty scalar, else every source); the store judges
 * each row with `page_hidden`. A caller the store's policy cannot express refuses before the read (callerPolicy).
 */
export const readPrivateOnlySlugs: StoreMember<[slugs: readonly string[], scope?: PrivateOnlySlugScope, opts?: { includeDeleted?: boolean }], string[]> =
  async (brain, slugs, scope, opts) => {
    const taken = takeOptions('readPrivateOnlySlugs', scope, ['sourceId', 'sourceIds']);
    const { includeDeleted } = takeOptions('readPrivateOnlySlugs', opts, ['includeDeleted']);
    if (slugs.length === 0) return [];
    const policy = callerPolicy('readPrivateOnlySlugs', 'read');
    const sourceIds = Array.isArray(taken.sourceIds) && taken.sourceIds.length > 0 ? [...taken.sourceIds as string[]] : null;
    const sourceId = sourceIds === null && typeof taken.sourceId === 'string' && taken.sourceId !== '' ? taken.sourceId : null;
    return storeCall({ member: 'readPrivateOnlySlugs', sourceId: sourceId ?? undefined }, () =>
      brain.readPrivateOnlySlugs([...slugs], sourceId, sourceIds, includeDeleted === true, policy)) as Promise<string[]>;
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
      storePageTextPolicy('readWriteVisibilityProbe', () => readPolicyFragment('p', [], true), { callerReaders: true, fragment: 'plain' }));
    return await storeCall({ member: 'readWriteVisibilityProbe', slug, sourceId }, () =>
      brain.readWriteVisibilityProbe(sourceId, slug, policy)) as WriteVisibilityProbe;
  };

/** The privacy part alone, with the privacy aliases as the rendered fragment honours them now (readHonorAliases ran first). */
export const readPagePrivacyHidden: StoreMember<[sourceId: string, slug: string], boolean | null> =
  async (brain, sourceId, slug) =>
    await storeCall({ member: 'readPagePrivacyHidden', slug, sourceId }, () =>
      brain.readPagePrivacyHidden(sourceId, slug, privacyPartAliases('readPagePrivacyHidden'))) as boolean | null;

/**
 * A local writer's fence comes from the stored registration; an OAuth client's from its stored client record
 * (`bound_slug_prefixes`, or `delegated_slug_prefixes` for a delegated write), null when the client is gone.
 */
export const readWriterSlugFence: StoreMember<[principal: { kind: string; id: string }, opts?: { delegated?: boolean }], unknown> =
  async (brain, principal, opts) => {
  if (principal.kind === 'oauth_client') {
    const client = await readOauthClient(brain, principal.id);
    return (opts?.delegated ? client?.delegated_slug_prefixes : client?.bound_slug_prefixes) ?? null;
  }
  if (principal.kind !== 'local_cli' && principal.kind !== 'local_stdio') return null;
  const row = await storeCall({ member: 'readWriterSlugFence' }, () => brain.readLocalWriter(principal.id)) as
    { grant_ceiling?: { slugPrefixes?: unknown } | null } | null;
  return row?.grant_ceiling?.slugPrefixes ?? null;
};
