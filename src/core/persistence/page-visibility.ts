import { OperationError, opError } from '../ops/contract.ts';
import { callerAccessAllowedSql, callerIdentities, currentCallerAccess, labelledOnlyForSql, OWNER_MEMBER_KEY, privacyPartSql, privatePagesFilterForCaller, readHonorAliases, readPolicyFragment, readRemotePolicyNow, resolveExcludePrivatePages, withCallerAccess } from '../search/private-visibility.ts';
import { anyLabelledOnlyMember, labelledOnlyFor } from '../access/labelled-only.ts';
import { hostFix } from '../ops/op-fix.ts';
import { parseMarkdown } from '../markdown.ts';
import { folderAccessForAll, memberIdentityFor, resolveAudienceIdentities } from '../access/caller.ts';
import type { AudiencePrincipal } from '../access/audience.ts';
import { parseStoredActor, storedActorIdentity } from '../access/actor.ts';
import { ACCESS_ID_RE, hasReaders, normalizePrincipal, normalizeReaders, readersAllow, NOBODY } from '../access/principals.ts';
import { catalogueError } from '../error-catalogue.ts';
import { authorizedSlug, type SqlEngine, type WriteAuthority } from './model.ts';
import type { BrainEngine } from '../engine.ts';
import { noGrantFloorReads } from '../source-resolver.ts';
import { hasScope } from '../scope.ts';
import { viewedEngine } from './switches.ts';
import { ownerOnlyPresentSql, ownerOnlySourceSql, ownerOnlySourcesPresent, sourceIsOwnerOnly } from '../access/owner-only.ts';

/** Publication uses fresh policy, independent of the read-side telemetry cache (read through the resolver). */
export async function excludesPrivateWrites(engine: SqlEngine, remote: boolean): Promise<boolean> {
  if (!remote) return false;
  return !(await readRemotePolicyNow(engine)).privacyRelaxed;
}

/**
 * excludesPrivateWrites for a write's admission: reuses the fresh policy this remote request read when it started
 * (remoteCallerAccess) instead of reading it again. A false result is rechecked fresh at publication.
 */
export async function excludesPrivateWritesAtAdmission(engine: SqlEngine, remote: boolean): Promise<boolean> {
  if (!remote) return false;
  return !(currentCallerAccess().remotePolicy ?? await readRemotePolicyNow(engine)).privacyRelaxed;
}

/**
 * Recheck after page guards at publication; also hide inaccessible receipt targets. GBRA-218: on a brain with
 * member-access restrictions the writer's identity is re-resolved from the stored principal on every check, so a
 * member disabled or unbound after submission (a queued job, a replay) loses the page before commit, and the
 * member-access part applies even when an operator relaxed privacy.
 */
export async function authorizePageVisibility(engine: SqlEngine, authority: WriteAuthority, page: string): Promise<void> {
  if (!authority.remote) return;
  const slug = authorizedSlug(authority, page);
  // GBRA-108 design 1: a labelled-only writer reads only pages that name it, so the empty-identity shortcut (a page every
  // caller reads) does not apply to it.
  // The grant probe rides on the empty-identity read, so a write on a brain with no labelled-only member costs no extra
  // statement; an unreadable probe counts as yes, as anyLabelledOnlyMember does.
  const excludePrivate = authority.excludePrivate ?? true;
  const hiddenSql = `SELECT (page_readers IS NOT NULL OR folder_rule_ids IS NOT NULL) FROM pages
      WHERE source_id=$1 AND slug=$2 AND NOT (${readPolicyFragment('pages', [], true)}) LIMIT 1`;
  // The owner-only tests (access/owner-only.ts) ride on the same read, so a write on a brain with no owner-only source
  // costs no extra statement; an unreadable probe reads them live, and an unreadable live read counts as owner-only.
  let probe: { any_labelled?: boolean; identity_may_open: boolean | null; owner_only_source?: boolean; owner_only_any?: boolean } | undefined;
  if (excludePrivate) {
    try {
      [probe] = await engine.executeRaw<{ any_labelled: boolean; identity_may_open: boolean | null; owner_only_source: boolean; owner_only_any: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM access_members WHERE labelled_only) AS any_labelled, (${hiddenSql}) AS identity_may_open,
          ${ownerOnlySourceSql('$1')} AS owner_only_source, ${ownerOnlyPresentSql(engine)} AS owner_only_any`, [authority.sourceId, slug]);
    } catch {
      probe = undefined;
    }
  }
  // An owner-only source takes remote writes only from the owner speaking for itself, so no other credential plants,
  // rewrites or probes a page there; the refusal reads like any page it may not see.
  if ((probe?.owner_only_source ?? await sourceIsOwnerOnly(engine, authority.sourceId)) && !await storedOwnerSpeaksForItself(engine, authority)) {
    throw pageNotVisibleError();
  }
  const ownerOnlyPresent = probe?.owner_only_any;
  const anyLabelled = excludePrivate ? probe?.any_labelled ?? true : await anyLabelledOnlyMember(engine);
  const labelled = anyLabelled && await writerLabelledOnly(engine, authority, await writerIdentities(engine, authority));
  // GST-2091: the owner's own page write (storedOwnerWrite) to a live page is held to member access without the privacy
  // part. It is judged only for a page the privacy part hides, so every other write costs no extra lookup; a soft-deleted
  // private page stays refused as before, so a write there never republishes it or opens its version history.
  let owner: boolean | undefined;
  const ownerOnLivePage = async () => await storedOwnerWrite(engine, authority)
    && (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1', [authority.sourceId, slug])).length > 0;
  if (!labelled && excludePrivate) {
    // Privacy is hidden whatever the policy says, and an empty identity is the strictest reading (an identity only
    // opens a page that names readers or sits under a folder rule), so a page visible with none needs no policy read
    // or member lookup.
    probe ??= (await engine.executeRaw<{ identity_may_open: boolean | null }>(`SELECT (${hiddenSql}) AS identity_may_open`, [authority.sourceId, slug]))[0];
    if (probe?.identity_may_open == null) return;
    if (!probe.identity_may_open && !(owner = await ownerOnLivePage())) throw pageNotVisibleError();
  }
  const policy = await readRemotePolicyNow(engine);
  const hidePrivate = excludePrivate || !policy.privacyRelaxed;
  if (!hidePrivate && !policy.restricted && !labelled) return;
  const hiddenUnder = async (hide: boolean) => (await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2
    AND NOT (${await writerReadPolicySql(engine, authority, 'pages', hide, policy.restricted, ownerOnlyPresent)}) LIMIT 1`, [authority.sourceId, slug])).length > 0;
  if (!await hiddenUnder(hidePrivate && owner !== true)) return;
  if (hidePrivate && owner === undefined && await ownerOnLivePage() && !await hiddenUnder(false)) return;
  throw pageNotVisibleError();
}

/**
 * The read policy a stored remote write's writer is held to, re-resolved live: the member-access part always (an
 * empty identity, the strictest reading, when the brain has no restrictions), then the privacy part when
 * `hidePrivate`. No operator hatch relaxes the member-access part. GBRA-108 design 1: a labelled-only writer is held to
 * pages that name it too, the same rule its reads follow.
 */
export async function writerReadPolicySql(engine: SqlEngine, authority: WriteAuthority, pageAlias: string, hidePrivate: boolean,
  restricted?: boolean, ownerOnlyPresent?: boolean): Promise<string> {
  restricted ??= (await readRemotePolicyNow(engine)).restricted;
  const identities = restricted ? await writerIdentities(engine, authority) : [[]];
  const folder = restricted ? await folderAccessForAll(engine, identities) : { satisfiedRuleIds: [], folderCoverage: [] };
  const owner = (ownerOnlyPresent ?? await ownerOnlySourcesPresent(engine)) && await storedOwnerSpeaksForItself(engine, authority);
  const fragment = withCallerAccess({ folderCoverage: folder.folderCoverage, ...(owner ? { owner: true } : {}) },
    () => readPolicyFragment(pageAlias, { all: identities }, hidePrivate, folder.satisfiedRuleIds));
  if (!restricted || !await anyLabelledOnlyMember(engine) || !await writerLabelledOnly(engine, authority, identities)) return fragment;
  return `(${fragment} AND ${labelledOnlyForSql(pageAlias, identities, folder.satisfiedRuleIds)})`;
}

/**
 * GBRA-108 design 1: a stored write is labelled-only when its credential's member, or a member it writes for, carries
 * the grant (labelledOnlyFor); never the owner. The members it writes for are taken from the stored authority (the
 * audience's member entries, the attested actor's member) as well as from their re-resolved identities, so a
 * re-resolution that reads as the guest identity never makes a labelled-only member's write unlabelled.
 */
async function writerLabelledOnly(engine: SqlEngine, authority: WriteAuthority, identities: readonly (readonly string[])[]): Promise<boolean> {
  const attested = authority.actingFor && !Array.isArray(authority.actingFor);
  const bound = attested ? [] : await memberIdentityFor(engine, authority);
  const actor = attested ? parseStoredActor(authority.actingFor) : null;
  const stored = actor ? [`member:${actor.member}`] : Array.isArray(authority.actingFor) ? authority.actingFor.filter(p => p.startsWith('member:')) : [];
  const [owner] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [OWNER_MEMBER_KEY]);
  const ownerId = owner?.value?.trim();
  const members = [...identities, bound, ...stored.map(p => [p])].filter(id => !(ownerId && id.includes(`member:${ownerId}`)));
  return labelledOnlyFor(engine, members);
}

/**
 * GBRA-108 design 1: a labelled-only writer may create a page only when the page names it: its readable_by holds the
 * member or one of its groups (or an audience entry it writes for), or a folder or page rule over the slug lists them.
 * Otherwise it would write a page it could never read back. An update is held to the readers check
 * (authorizePageVisibility), so only a slug with no live page is checked here. Refused with the readers line to add and
 * the page rule the operator could add instead.
 */
export async function assertLabelledOnlyCreate(engine: SqlEngine, authority: WriteAuthority, slug: string,
  stored: { deleted_at?: unknown } | null | undefined, frontmatter: unknown): Promise<void> {
  if (!authority.remote || (stored && stored.deleted_at == null)) return;
  if (!await anyLabelledOnlyMember(engine)) return;
  const identities = await writerIdentities(engine, authority);
  if (!await writerLabelledOnly(engine, authority, identities)) return;
  const named = new Set(identities.flat());
  if ((normalizeReaders(frontmatter) ?? []).some(r => named.has(r))) return;
  const folder = await folderAccessForAll(engine, identities);
  const [row] = await engine.executeRaw<{ named: boolean }>('SELECT COALESCE(gbrain_access_folder_rules($1, $2) && $3::text[], false) AS named',
    [authority.sourceId, slug, folder.satisfiedRuleIds]);
  if (row?.named === true) return;
  const reader = [...named].sort().find(p => p.startsWith('member:'))?.slice('member:'.length) ?? [...named].sort()[0] ?? 'alice-example';
  const [owner] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [OWNER_MEMBER_KEY]).catch(() => []);
  const ownerId = owner?.value?.trim();
  const ruleReaders = ownerId && ACCESS_ID_RE.test(ownerId) && ownerId !== reader ? `${reader},${ownerId}` : reader;
  throw opError('access_labelled_only_unnamed', `This connection is labelled-only, so a page it creates must name it: add readable_by: [${reader}] (or one of its groups) to the frontmatter of ${slug}, or ask the user for a page or folder rule over it that lists them; nothing was written.`,
    `Add readable_by: [${reader}] (or one of its groups) to the frontmatter and submit again with a new request_id, or ask the user to add a page or folder rule that lists it on the brain host.`,
    { fix: hostFix({ remote: true, transport: 'http' }, ['gbrain', 'access', 'rule', 'add', '--slug', slug, '--readers', ruleReaders, '--source', authority.sourceId],
      'A page rule over this slug that lists the labelled-only member, so the page it creates names it. Adding readable_by to the page itself needs no operator.') });
}

/** The readers check (remoteReadersChecked) and the labelled-only create check (assertLabelledOnlyCreate) of one remote page write. */
export async function remoteLabelsChecked<T extends { parsedPage: { frontmatter: unknown } }>(engine: SqlEngine, authority: WriteAuthority, slug: string,
  stored: { frontmatter?: unknown; deleted_at?: unknown } | null | undefined, prepared: T): Promise<T> {
  const ready = await remoteReadersChecked(engine, authority, stored?.frontmatter, prepared);
  await assertLabelledOnlyCreate(engine, authority, slug, stored, ready.parsedPage.frontmatter);
  return ready;
}

/**
 * The identities a stored write is checked under, re-resolved live: the principal's member, or (GBRA-231) every entry
 * of the audience it was accepted for, bounded by the principal's live may_act_for. An audience no longer permitted,
 * naming a disabled member or an actor no longer covered (a coded refusal) resolves to the guest identity, which reads
 * no restricted page (fail closed; writerLabelledOnly still reads the stored members). A database failure is rethrown,
 * so the write is retried or fails instead of being checked as the guest.
 */
async function writerIdentities(engine: SqlEngine, authority: WriteAuthority): Promise<string[][]> {
  const refusedAsGuest = (error: unknown): string[] => { if (error instanceof OperationError) return []; throw error; };
  if (authority.actingFor && !Array.isArray(authority.actingFor)) {
    // GST-359 C1: an attested write reads as its member only while actorCoverage still covers the same member.
    const actor = parseStoredActor(authority.actingFor);
    return [actor ? await storedActorIdentity(engine, authority.principal, actor).catch(refusedAsGuest) : []];
  }
  if (!authority.actingFor?.length) return [await memberIdentityFor(engine, authority)];
  try {
    return await resolveAudienceIdentities(engine, { principal: authority.principal, transport: authority.principal.kind === 'local_stdio' ? 'stdio' : 'http' },
      authority.actingFor as AudiencePrincipal[]);
  } catch (error) {
    return [refusedAsGuest(error)];
  }
}

/**
 * The read policy a remote caller's get_page applies, as a predicate on `pageAlias`: the member-access part, then the
 * privacy part with its grant and hatch; the member-access part alone where get_page applies no policy (an operator
 * relaxed privacy and the brain holds no member-access restriction). Call inside the caller's access record.
 */
export async function remoteReadPolicySql(engine: BrainEngine, pageAlias: string): Promise<string> {
  return await resolveExcludePrivatePages(engine, true) ? privatePagesFilterForCaller(pageAlias) : callerAccessAllowedSql(pageAlias);
}

/**
 * Whether an existing page is hidden from the current remote caller (never for a trusted local caller). GBRA-431: the
 * full read policy, so a `visibility: private` page answers like a missing one as well as a page whose readers omit
 * the caller; `memberAccessOnly` keeps the member-access part alone for a caller that refuses privacy itself.
 */
export async function remoteTargetHidden(engine: BrainEngine, remote: boolean | undefined, sourceId: string, slug: string, memberAccessOnly = false): Promise<boolean> {
  if (remote === false) return false;
  const policy = memberAccessOnly ? callerAccessAllowedSql('pages') : await remoteReadPolicySql(engine, 'pages');
  const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND NOT ${policy} LIMIT 1`, [sourceId, slug]);
  return rows.length > 0;
}

/**
 * GBRA-431: for the (source_id, slug) pairs among `pages`, keyed `${source_id}\u0000${slug}`, which name any page row
 * (`known`, soft-deleted rows included) and which name a live page the current remote caller can read (`readable`).
 * A slug with no live page row (never written, deleted, purged or renamed) is not readable, so a caller that must
 * fail closed keeps only `readable`. Call for remote callers only.
 */
export async function remotePageAccess(engine: BrainEngine, pages: readonly { source_id: string; slug: string }[]): Promise<{ known: Set<string>; readable: Set<string> }> {
  if (pages.length === 0) return { known: new Set(), readable: new Set() };
  const policy = await remoteReadPolicySql(engine, 'p');
  const rows = await engine.executeRaw<{ source_id: string; slug: string; readable: boolean }>(`SELECT p.source_id, p.slug,
      bool_or(p.deleted_at IS NULL AND ${policy}) AS readable FROM pages p
    JOIN unnest($1::text[], $2::text[]) AS t(source_id, slug) ON p.source_id = t.source_id AND p.slug = t.slug
    GROUP BY p.source_id, p.slug`, [pages.map(p => p.source_id), pages.map(p => p.slug)]);
  const key = (r: { source_id: string; slug: string }) => `${r.source_id}\u0000${r.slug}`;
  return { known: new Set(rows.map(key)), readable: new Set(rows.filter(r => r.readable).map(key)) };
}

/**
 * GBRA-218: a remote write's `readable_by` is well formed (readable_by_invalid names the bad entry and the corrected
 * YAML form) and keeps the page readable by the writer's `identity`. Checked at submission with the request's
 * identity and again at preparation with the identity re-resolved from the stored principal.
 */
export function assertRemoteReadersValid(frontmatter: unknown, identity: readonly string[] | readonly (readonly string[])[], audience?: readonly string[] | null): void {
  const identities = identity.length && typeof identity[0] !== 'string' ? identity as readonly (readonly string[])[] : [identity as readonly string[]];
  if (!hasReaders(frontmatter)) return;
  const value = (frontmatter as Record<string, unknown>).readable_by;
  if (normalizeReaders(frontmatter)?.[0] === NOBODY) {
    const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    const bad = entries.find(e => typeof e !== 'string' || normalizePrincipal(e) === null);
    const kept = entries.filter((e): e is string => typeof e === 'string' && normalizePrincipal(e) !== null).map(e => e.trim().toLowerCase());
    const example = `readable_by: [${(kept.length ? kept : ['alice-example', 'group:team-a']).join(', ')}]`;
    const what = bad !== undefined ? `the entry ${JSON.stringify(bad)} is not a member id or group:<id>`
      : entries.length === 0 ? 'it names no reader' : 'it is not a string or a list of strings (at most 256)';
    throw catalogueError('readable_by_invalid', `readable_by is invalid: ${what}.`,
      `Nothing was written. Member and group ids are lower-case letters, digits, '.', '_' and '-' (1-64 characters); write the field as ${example} and submit again with a new request_id.`);
  }
  if (!identities.every(id => readersAllow(frontmatter, id))) {
    if (audience?.length) {
      throw catalogueError('readable_by_invalid', 'readable_by would leave this page unreadable by the audience this connection acts for.',
        `Nothing was written. Every audience entry (${audience.join(', ')}) must stay a reader, and a guest can read no page that names readers; write the page without readable_by changes, or ask the user to change the readers on the brain host.`);
    }
    const one = identities[0] ?? [];
    throw catalogueError('readable_by_invalid', 'readable_by would leave this page unreadable by this connection.',
      `Nothing was written. Keep this connection's member${one.length ? ` (${one.join(', ')})` : ' (this connection is bound to none)'} or one of its groups in readable_by, or ask the user to change the readers on the brain host.`);
  }
}

/** A remote put_page's readable_by, checked with the request's identity before anything is admitted (preparation checks it again). */
export function assertSubmittedReaders(remote: boolean | undefined, slug: unknown, content: unknown): void {
  if (remote === false || typeof content !== 'string' || !content.includes('readable_by')) return;
  assertRemoteReadersValid(parseMarkdown(content, typeof slug === 'string' ? slug : 'page').frontmatter, callerIdentities(), currentCallerAccess().audience);
}

/**
 * The preparation-time check, returning the prepared import it was given: the stored principal's live identity, and a
 * remote write never drops readable_by from a page that names readers.
 */
export async function remoteReadersChecked<T extends { parsedPage: { frontmatter: unknown } }>(engine: SqlEngine, authority: WriteAuthority, before: unknown, prepared: T): Promise<T> {
  const after = prepared.parsedPage.frontmatter;
  if (!authority.remote || (!hasReaders(before) && !hasReaders(after))) return prepared;
  if (!hasReaders(after)) {
    throw catalogueError('readable_by_invalid', 'This write removes readable_by from a page that names readers.',
      'Nothing was written. A remote write keeps the readable_by line: read the page with get_page include_content:true and keep its frontmatter, or ask the user to widen the page on the brain host.');
  }
  const acting = authority.actingFor;
  assertRemoteReadersValid(after, await writerIdentities(engine, authority), Array.isArray(acting) ? acting : acting ? [`member:${acting.member}`] : undefined);
  return prepared;
}

/**
 * GST-2051: the member a remote write's token or OAuth client is bound to, as `member:<id>`, when the write goes to a
 * source every credential without a source grant reads, unbound ones included (noGrantFloorReads): `default`, the
 * no-grant floor of every token without `--sources` and the registration default of every OAuth client, and since
 * #8982 every federated source. Null for a local, unbound, attested or audience write, and for any other source (the
 * operator chose that source's audience through its grants). Read from the stored binding and source config at
 * preparation, so a binding removed after submission takes effect; a disabled member's page names a reader nobody
 * holds and is refused, and a binding or source table that cannot be read throws instead of publishing the page shared.
 */
export async function defaultSourceMemberWriter(engine: BrainEngine, authority: Pick<WriteAuthority, 'remote' | 'actingFor' | 'principal' | 'sourceId'>): Promise<string | null> {
  const { principal } = authority;
  if (!authority.remote || authority.actingFor || (principal.kind !== 'legacy_token' && principal.kind !== 'oauth_client')) return null;
  const [row] = await engine.executeRaw<{ member_id: string | null }>(principal.kind === 'legacy_token'
    ? 'SELECT member_id FROM access_tokens WHERE id::text = $1'
    : 'SELECT member_id FROM oauth_clients WHERE client_id = $1', [principal.id]);
  return row?.member_id && await noGrantFloorReads(engine, authority.sourceId) ? `member:${row.member_id}` : null;
}

/**
 * GST-2059: whether a default-source member writer is the brain owner (config access.owner_member, an enabled member),
 * whose new pages stay shared. A disabled or removed owner member is not the owner here, so its pages keep the stamp.
 */
export async function defaultSourceWriterIsOwner(engine: SqlEngine, writer: string | null): Promise<boolean> {
  if (!writer) return false;
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [OWNER_MEMBER_KEY]);
  const owner = row?.value?.trim();
  if (!owner || !ACCESS_ID_RE.test(owner) || writer !== `member:${owner}`) return false;
  const [live] = await engine.executeRaw<{ id: string }>('SELECT id FROM access_members WHERE id = $1 AND disabled_at IS NULL AND tombstoned_at IS NULL', [owner]);
  return !!live;
}

/**
 * GST-2346 D1: whether a stored remote write came from the brain owner's own credential speaking for itself, judged
 * live from the stored authority (the request-time twin is ownerSpeaksForItself): no attested actor, no audience, no
 * subagent and no slug fence, stored or live (an OAuth client's bound_slug_prefixes, a local writer's grant ceiling), and the
 * principal's member is the enabled owner now. A credential unbound or fenced, a member disabled or an owner changed after
 * submission is not the owner here.
 */
export async function storedOwnerSpeaksForItself(engine: SqlEngine, authority: WriteAuthority, member?: string): Promise<boolean> {
  if (!authority.remote || authority.actingFor || authority.restrictedNamespace || authority.slugPrefixes != null) return false;
  const { principal } = authority;
  const fence = principal.kind === 'oauth_client' ? 'SELECT bound_slug_prefixes AS prefixes FROM oauth_clients WHERE client_id=$1'
    : principal.kind === 'local_cli' || principal.kind === 'local_stdio' ? "SELECT grant_ceiling->'slugPrefixes' AS prefixes FROM persistence_local_writers WHERE id=$1::uuid" : null;
  if (fence && (await engine.executeRaw<{ prefixes: unknown }>(fence, [principal.id]))[0]?.prefixes != null) return false;
  const bound = (await memberIdentityFor(engine, authority)).find(p => p.startsWith('member:')) ?? null;
  return (member === undefined || bound === member) && defaultSourceWriterIsOwner(engine, bound);
}

/**
 * GST-2891: whether a stored write's caller reads held fence rows, as worldOnlyFacts decided its reads: the local CLI,
 * or a credential bound to the live owner member, for itself or for an audience of the owner alone. Any other caller
 * read the page without them.
 */
export async function storedWriterReadsHeld(engine: SqlEngine, authority: WriteAuthority): Promise<boolean> {
  if (!authority.remote) return true;
  const audience = authority.actingFor;
  if (audience !== undefined && !(Array.isArray(audience) && audience.length === 1)) return false;
  const bound = (await memberIdentityFor(engine, authority)).find(p => p.startsWith('member:')) ?? null;
  return (audience === undefined || audience[0] === bound) && await defaultSourceWriterIsOwner(engine, bound);
}

/**
 * GST-2091: whether a stored page write is the brain owner's own (WriteAuthority.ownerWrite), judged live: it still holds
 * write scope and storedOwnerSpeaksForItself still names the same owner member. Such a write reaches a private page the
 * owner reads; readable_by and folder rules still apply to it, like to every other writer.
 */
export async function storedOwnerWrite(engine: SqlEngine, authority: WriteAuthority): Promise<boolean> {
  return !!authority.ownerWrite && hasScope(authority.scopes, 'write') && await storedOwnerSpeaksForItself(engine, authority, authority.ownerWrite);
}

/**
 * GST-2091: for a page write that is the owner's own (storedOwnerWrite), whether the live stored page is private by the
 * privacy rules remote reads apply (privacyPartSql: visibility, privacy aliases, pinned questions, derived types and
 * lineage, with visibility.honor_aliases read first as remote reads do); null when the write is not the owner's.
 * `wholePage` is a put_page, which replaces the whole frontmatter. ownerWriteKeepsLabels keeps such a page private.
 */
export async function ownerRewriteOf(engine: BrainEngine, authority: WriteAuthority, sourceId: string, slug: string, wholePage: boolean): Promise<OwnerRewrite | null> {
  if (!await storedOwnerWrite(engine, authority)) return null;
  await readHonorAliases(viewedEngine(engine));
  const [row] = await engine.executeRaw<{ hidden: boolean }>(`SELECT NOT (${privacyPartSql('p')}) AS hidden FROM pages p
    WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [sourceId, slug]);
  return { privacyPrivate: row?.hidden === true, wholePage };
}
export interface OwnerRewrite { privacyPrivate: boolean; wholePage: boolean }

/**
 * GST-2051: the readers a page written by a default-source member writer (defaultSourceMemberWriter) keeps when its content
 * names none: the stored page's readers when it has them, else the writer alone for a page this write creates, unless
 * the writer is the brain owner (GST-2059), whose new pages stay shared. An existing page with no readers stays as it
 * is. Only ever narrows: a page naming readers is left to the caller. `ownerRewrite` (GST-2091, ownerRewriteOf): first keep the
 * stored labels the owner's own whole-page rewrite leaves out (ownerWriteKeepsLabels).
 */
export function defaultSourceWriterReaders(writer: string | null, frontmatter: Record<string, unknown>, stored: { frontmatter?: unknown; deleted_at?: unknown } | null | undefined, owner = false,
  ownerRewrite: OwnerRewrite | null = null): void {
  if (ownerRewrite) ownerWriteKeepsLabels(frontmatter, stored, ownerRewrite);
  if (!writer || hasReaders(frontmatter)) return;
  const live = stored && stored.deleted_at == null ? stored : null;
  if (live && hasReaders(live.frontmatter)) frontmatter.readable_by = (live.frontmatter as Record<string, unknown>).readable_by;
  else if (!live && !owner) frontmatter.readable_by = [writer];
}

/**
 * GST-2091: a page write (put_page, edit_page, append_page) by the brain owner's own credential (storedOwnerWrite) to a
 * page private by the privacy rules (`privacyPrivate`: visibility, an alias, a pinned question, a derived type or a
 * private origin) is stored as `visibility: private` when its result states no visibility (an empty or null value
 * states none), so removing an alias, a derived type or a lineage key never publishes it; a stored pinned_question the
 * result leaves out is kept, since granted_sources credentials read every other private page of their sources. A
 * whole-page rewrite (put_page) also keeps the stored visibility and readable_by its content leaves out. A value the
 * result states replaces the stored one.
 */
function ownerWriteKeepsLabels(frontmatter: Record<string, unknown>, stored: { frontmatter?: unknown; deleted_at?: unknown } | null | undefined, rewrite: OwnerRewrite): void {
  const live = stored && stored.deleted_at == null && typeof stored.frontmatter === 'object' && stored.frontmatter !== null ? stored.frontmatter as Record<string, unknown> : null;
  if (!live) return;
  const visibility = frontmatter.visibility;
  if (visibility == null || (typeof visibility === 'string' && visibility.trim() === '')) {
    delete frontmatter.visibility;
    if (rewrite.privacyPrivate) frontmatter.visibility = 'private';
    else if (rewrite.wholePage && live.visibility != null) frontmatter.visibility = live.visibility;
  }
  if (frontmatter.pinned_question == null && live.pinned_question != null) frontmatter.pinned_question = live.pinned_question;
  if (rewrite.wholePage && !hasReaders(frontmatter) && hasReaders(live)) frontmatter.readable_by = live.readable_by;
}

/** The one refusal a remote writer gets for a target it may not see; other visibility refusals reuse it verbatim. */
export function pageNotVisibleError() {
  return opError('page_not_found', 'Page not found.', 'This page does not exist or is not visible to this connection, so nothing was written. Do not retry this slug as a create; ask the user whether the page exists and who can read it, or write to a different slug.');
}
