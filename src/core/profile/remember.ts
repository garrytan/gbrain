/**
 * Lane 3 P1: remember's facet routing and the profile refusals (registered in error-registry.ts). The facet list and
 * its validation are facets.ts.
 */
import type { OperationContext, OperationError } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { unquoteFactText } from '../search/transcript-quote.ts';
import { sqlEngineKind } from '../sql-engine-kind.ts';
import { canonicalFacet, facetKind, isProfileMetricLabel, PRIVATE_BY_DEFAULT_FACETS, PROFILE_FACETS, PROFILE_METRIC_PREFIX } from './facets.ts';

const FACET_LIST = 'size.<item> (e.g. size.shoe), ' + PROFILE_FACETS.filter(f => f !== 'size').join(', ');

function callArgs(p: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...p, ...patch };
  delete args.request_id;
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete args[k];
  return args;
}

export function facetUnknown(p: Record<string, unknown>): OperationError {
  return opError('profile_facet_unknown', `remember: facet ${JSON.stringify(p.facet)} is not a profile facet; nothing was saved.`,
    `Pass facet as one of: ${FACET_LIST}; or omit facet to save an ordinary fact.`,
    { legacy_error: 'invalid_params', reason: 'profile_facet_unknown', docs: 'docs/guides/profile.md#facets',
      fix: { mcp: { tool: 'remember', arguments: callArgs(p, { facet: 'other' }) }, consent: [], actor: 'agent', requires_exclusive: false,
        why: `The same call under the catch-all facet "other"; pick a closer one from: ${FACET_LIST}.` } });
}

export function metricReserved(p: Record<string, unknown>): OperationError {
  const facet = canonicalFacet(String(p.claim_metric).trim().slice(PROFILE_METRIC_PREFIX.length)) ?? 'other';
  return opError('profile_metric_reserved', `remember: claim_metric ${JSON.stringify(p.claim_metric)} uses the reserved profile. prefix; nothing was saved.`,
    `A profile fact is saved with facet (e.g. facet: "${facet}"), which sets the metric; pass facet instead of claim_metric.`,
    { legacy_error: 'invalid_params', reason: 'profile_metric_reserved', docs: 'docs/guides/profile.md#facets',
      fix: { mcp: { tool: 'remember', arguments: callArgs(p, { claim_metric: undefined, facet }) }, consent: [], actor: 'agent', requires_exclusive: false,
        why: 'The same call with facet in place of the hand-written profile metric.' } });
}

export function entityNotSelf(p: Record<string, unknown>, self: string | null): OperationError {
  return opError('profile_entity_not_self', `remember: a profile fact from this credential is saved only on its own profile, not on ${JSON.stringify(p.entity)}; nothing was saved.`,
    self ? `Omit entity to save it on your own profile (${self}), or drop facet to save an ordinary fact about ${String(p.entity)}.`
      : 'This credential speaks for no member and is not the brain owner, so it has no profile; drop facet to save an ordinary fact.',
    { legacy_error: 'invalid_params', reason: 'profile_entity_not_self', docs: 'docs/guides/profile.md#who-a-profile-belongs-to',
      fix: { mcp: { tool: 'remember', arguments: callArgs(p, self ? { entity: undefined } : { facet: undefined }) }, consent: [], actor: 'agent', requires_exclusive: false,
        why: self ? 'The same call with no entity, which saves it on your own profile.' : 'The same call without facet, saved as an ordinary fact.' } });
}

export interface ProfileSelf {
  slug: string;
  /** How the slug was found; never the identifiers behind it. */
  basis: 'identifier_page' | 'member_page' | 'reserved_page';
  /** A member's own profile (its member page), or the brain owner's. */
  kind: 'owner' | 'member';
  source_id: string | null;
  /**
   * The owner's other profile homes (memory/owner, the owner member's page), read beside slug so a fact saved before
   * the owner identity changed (an owner named, a person page matched) stays in the profile.
   */
  homes?: string[];
}

/**
 * Whose profile this caller reads and writes: a member credential its own member page, the brain owner (a trusted local
 * caller, or the owner's credential speaking for itself) the owner entity, and on a brain with no person members any
 * credential, which is the owner's. Any other caller has no profile (null).
 */
export async function profileSelf(ctx: OperationContext): Promise<ProfileSelf | null> {
  sqlEngineKind(ctx.engine.kind, 'profile');
  const [{ callerMember, memberPageSlug, ownerSpeaksForItself }, { currentCallerAccess }, { ownerIdentity, RESERVED_OWNER_SLUG }] = await Promise.all([
    import('../access/member-facts.ts'), import('../search/private-visibility.ts'), import('../identity/owner.ts')]);
  const owner = async (): Promise<ProfileSelf> => {
    const id = await ownerIdentity(ctx.engine);
    const homes = [RESERVED_OWNER_SLUG, ...(id.member ? [memberPageSlug(id.member)] : [])].filter(s => s !== id.entity.slug);
    return { slug: id.entity.slug, basis: id.entity.basis, kind: 'owner', source_id: id.entity.source_id, homes };
  };
  if (ctx.remote === false) return owner();
  if (ownerSpeaksForItself(ctx)) return owner();
  const access = currentCallerAccess();
  if (access.audienceIdentities.length || access.audience !== null) return null;
  const member = callerMember();
  if (member) return { slug: memberPageSlug(member), basis: 'member_page', kind: 'member', source_id: null };
  if (access.owner) return owner();
  const { listMembers } = await import('../access/members.ts');
  const people = (await listMembers(ctx.engine)).filter(m => m.status === 'enabled' && m.kind === 'person');
  return people.length === 0 ? owner() : null;
}

/**
 * remember's facet: the claim metric it sets, the entity it routes to and its default visibility. Only a call that sets
 * facet changes; a call with no facet and no entity is untouched (never rerouted). A member's profile write goes only
 * to its own member page.
 */
export async function profileRemember(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (p.facet === undefined || p.facet === null) {
    // remember unquotes a remote caller's claim_metric before storing it, so the reservation reads the same value.
    const metric = typeof p.claim_metric === 'string' ? (ctx.remote === false ? p.claim_metric : unquoteFactText(p.claim_metric)) : null;
    if (isProfileMetricLabel(metric)) throw metricReserved(p);
    return p;
  }
  const facet = typeof p.facet === 'string' ? canonicalFacet(p.facet) : null;
  if (!facet) throw facetUnknown(p);
  if (p.claim_metric !== undefined && p.claim_metric !== null) {
    throw opError('profile_metric_reserved', 'remember: facet sets the claim metric, so claim_metric cannot be passed with it; nothing was saved.',
      'Pass facet alone; claim_value, claim_unit and claim_period may still ride with it.',
      { legacy_error: 'invalid_params', reason: 'profile_metric_reserved', docs: 'docs/guides/profile.md#facets',
        fix: { mcp: { tool: 'remember', arguments: callArgs(p, { claim_metric: undefined }) }, consent: [], actor: 'agent', requires_exclusive: false,
          why: 'The same call without claim_metric; facet sets it.' } });
  }
  const entity = typeof p.entity === 'string' && p.entity.trim() ? p.entity.trim() : null;
  const self = await profileSelf(ctx);
  if (entity === null && !self) throw entityNotSelf(p, null);
  if (entity !== null && self?.kind === 'member' && entity !== self.slug) throw entityNotSelf(p, self.slug);
  if (entity !== null && ctx.remote !== false && !self) throw entityNotSelf(p, null);
  const own = self !== null && (entity === null || entity === self.slug);
  // The profile is read from the owner page's own source (read.ts), so a fact on it is saved there or not at all.
  const pinned = own && self.source_id ? self.source_id : null;
  if (pinned && typeof p.source_id === 'string' && p.source_id !== pinned) {
    throw opError('profile_entity_not_self', `remember: your profile is ${self!.slug} in source ${pinned}, so a profile fact is saved only there, not in source ${JSON.stringify(p.source_id)}; nothing was saved.`,
      'Omit source_id to save it on your own profile.',
      { legacy_error: 'invalid_params', reason: 'profile_entity_not_self', docs: 'docs/guides/profile.md#who-a-profile-belongs-to',
        fix: { mcp: { tool: 'remember', arguments: callArgs(p, { source_id: undefined }) }, consent: [], actor: 'agent', requires_exclusive: false,
          why: 'The same call without source_id, which saves it on your own profile.' } });
  }
  if (pinned && ctx.remote !== false) {
    const [{ grantedWriteSource, writeGrantRefusal }, { perCallWriteSource }] = await Promise.all([import('../persistence/write-grant.ts'), import('../access/attest-sources.ts')]);
    if (pinned !== grantedWriteSource(ctx) && !perCallWriteSource(ctx, pinned)) {
      throw writeGrantRefusal(ctx, `Your profile is ${self!.slug} in source ${pinned}, and this connection cannot write there, so the profile fact was not saved (saving it elsewhere would hide it from your profile). Ask the brain host's operator to grant this connection source ${pinned}, or save it from the brain host's CLI.`);
    }
  }
  const privateDefault = PRIVATE_BY_DEFAULT_FACETS.includes(facetKind(facet)) && p.visibility == null && p.share !== true;
  if ((privateDefault || p.visibility === 'private') && self?.kind === 'owner' && own) {
    const [{ worldOnlyFacts }, { profilePrivateHiddenNotice }] = await Promise.all([import('../search/private-visibility.ts'), import('../interop-notices.ts')]);
    if (worldOnlyFacts(ctx.remote)) ctx.emitNotice?.(profilePrivateHiddenNotice());
  }
  const { facet: _facet, ...rest } = p;
  return { ...rest, claim_metric: PROFILE_METRIC_PREFIX + facet, entity: entity ?? self!.slug, infer_entity: false,
    ...(pinned ? { source_id: pinned } : {}), ...(privateDefault ? { visibility: 'private' } : {}) };
}
