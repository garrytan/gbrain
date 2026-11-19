/**
 * The page visibility guards (BrainEngine readPageHiddenFromCaller, readCallerPageAccess, readWriterSlugFence): the
 * reads a remote page write runs to learn whether the caller may see a page, which of a list of pages the caller reads,
 * and whether a stored writer carries a slug fence (engine-sql/page-visibility.ts on the SQL engines).
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
import type { CallerPageAccessRow, PagePolicyPart } from '../../engine-sql/page-visibility.ts';
import { callerAccessAllowedSql, currentCallerAccess, privatePagesFilterForCaller, withCallerAccess, withoutCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

/** The store policy for page policy part `part` of the current caller, or a refusal. */
function callerPolicy(member: string, part: PagePolicyPart): StorePrivacyPolicy {
  if (part === 'read') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true });
  const text = callerAccessAllowedSql('p');
  const off = { honorAliases: false, entityPrivacy: false };
  if (text === withoutCallerAccess(() => callerAccessAllowedSql('p'))) return off;
  const access = currentCallerAccess();
  const readers = { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
  const canonical = withoutCallerAccess(() => withCallerAccess({ ...readers, hidePrivate: true }, () => callerAccessAllowedSql('p')));
  if (text === canonical) return { ...off, ...readers };
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

/** A local writer's fence comes from the stored registration; an OAuth client's refuses (the store keeps no OAuth clients). */
export const readWriterSlugFence: StoreMember<[principal: { kind: string; id: string }], unknown> = async (brain, principal) => {
  if (principal.kind === 'oauth_client') refuseMember('readWriterSlugFence', 'an OAuth client fence (the store keeps no OAuth clients)');
  if (principal.kind !== 'local_cli' && principal.kind !== 'local_stdio') return null;
  const row = await storeCall({ member: 'readWriterSlugFence' }, () => brain.readLocalWriter(principal.id)) as
    { grant_ceiling?: { slugPrefixes?: unknown } | null } | null;
  return row?.grant_ceiling?.slugPrefixes ?? null;
};
