/**
 * The page visibility guards (BrainEngine readPageHiddenFromCaller, readCallerPageAccess, readWriteVisibilityProbe,
 * readPagePrivacyHidden, readWriterSlugFence): the reads a remote page write runs to learn whether the caller may see a page, which of a list
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
 * The store keeps OAuth clients, but this read does not read a client's fence yet, so it refuses; a local writer's fence is its stored grant
 * ceiling's `slugPrefixes`. What each member answers and why: rust/docs/store/page-visibility.md.
 */
import type { CallerPageAccessRow, PagePolicyPart, PrivateOnlySlugScope, WriteVisibilityProbe } from '../../engine-sql/page-visibility.ts';
import { callerAccessAllowedSql, privacyPartSql, privatePagesFilterForCaller, readPolicyFragment, withCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';
import { judgeWidenedCaller, ownerOnlyFormIn, pagePolicyFlags, renderForStoreCaller, storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

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
      storePageTextPolicy('readWriteVisibilityProbe', () => readPolicyFragment('p', [], true), { callerReaders: true }));
    return await storeCall({ member: 'readWriteVisibilityProbe', slug, sourceId }, () =>
      brain.readWriteVisibilityProbe(sourceId, slug, policy)) as WriteVisibilityProbe;
  };

/** The privacy part alone, with the privacy aliases as the rendered fragment honours them now (readHonorAliases ran first). */
export const readPagePrivacyHidden: StoreMember<[sourceId: string, slug: string], boolean | null> =
  async (brain, sourceId, slug) =>
    await storeCall({ member: 'readPagePrivacyHidden', slug, sourceId }, () =>
      brain.readPagePrivacyHidden(sourceId, slug, pagePolicyFlags(privacyPartSql('p')).honorAliases)) as boolean | null;

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
