import { opError } from '../ops/contract.ts';
import { callerAccessAllowedSql, callerIdentities, currentCallerAccess, OWNER_MEMBER_KEY, privatePagesFilterForCaller, readPolicyFragment, readRemotePolicyNow, resolveExcludePrivatePages, withCallerAccess } from '../search/private-visibility.ts';
import { parseMarkdown } from '../markdown.ts';
import { folderAccessForAll, memberIdentityFor, resolveAudienceIdentities } from '../access/caller.ts';
import type { AudiencePrincipal } from '../access/audience.ts';
import { parseStoredActor, storedActorIdentity } from '../access/actor.ts';
import { ACCESS_ID_RE, hasReaders, normalizePrincipal, normalizeReaders, readersAllow, NOBODY } from '../access/principals.ts';
import { catalogueError } from '../error-catalogue.ts';
import type { SqlEngine, WriteAuthority } from './model.ts';
import type { BrainEngine } from '../engine.ts';
import { noGrantFloorReads } from '../source-resolver.ts';

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
export async function authorizePageVisibility(engine: SqlEngine, authority: WriteAuthority, slug: string): Promise<void> {
  if (!authority.remote) return;
  if (authority.excludePrivate ?? true) {
    // Privacy is hidden whatever the policy says, and an empty identity is the strictest reading (an identity only
    // opens a page that names readers or sits under a folder rule), so a page visible with none needs no policy read
    // or member lookup.
    const [hidden] = await engine.executeRaw<{ identity_may_open: boolean }>(`SELECT (page_readers IS NOT NULL OR folder_rule_ids IS NOT NULL) AS identity_may_open
      FROM pages WHERE source_id=$1 AND slug=$2 AND NOT (${readPolicyFragment('pages', [], true)}) LIMIT 1`, [authority.sourceId, slug]);
    if (!hidden) return;
    if (!hidden.identity_may_open) throw pageNotVisibleError();
  }
  const policy = await readRemotePolicyNow(engine);
  const hidePrivate = (authority.excludePrivate ?? true) || !policy.privacyRelaxed;
  if (!hidePrivate && !policy.restricted) return;
  const fragment = await writerReadPolicySql(engine, authority, 'pages', hidePrivate, policy.restricted);
  const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2
    AND NOT (${fragment}) LIMIT 1`, [authority.sourceId, slug]);
  if (rows.length) throw pageNotVisibleError();
}

/**
 * The read policy a stored remote write's writer is held to, re-resolved live: the member-access part always (an
 * empty identity, the strictest reading, when the brain has no restrictions), then the privacy part when
 * `hidePrivate`. No operator hatch relaxes the member-access part.
 */
export async function writerReadPolicySql(engine: SqlEngine, authority: WriteAuthority, pageAlias: string, hidePrivate: boolean,
  restricted?: boolean): Promise<string> {
  restricted ??= (await readRemotePolicyNow(engine)).restricted;
  const identities = restricted ? await writerIdentities(engine, authority) : [[]];
  const folder = restricted ? await folderAccessForAll(engine, identities) : { satisfiedRuleIds: [], folderCoverage: [] };
  return withCallerAccess({ folderCoverage: folder.folderCoverage }, () => readPolicyFragment(pageAlias, { all: identities }, hidePrivate, folder.satisfiedRuleIds));
}

/**
 * The identities a stored write is checked under, re-resolved live: the principal's member, or (GBRA-231) every entry
 * of the audience it was accepted for, bounded by the principal's live may_act_for. An audience no longer permitted
 * or naming a disabled member resolves to the guest identity, which reads no restricted page (fail closed).
 */
async function writerIdentities(engine: SqlEngine, authority: WriteAuthority): Promise<string[][]> {
  if (authority.actingFor && !Array.isArray(authority.actingFor)) {
    // GST-359 C1: an attested write reads as its member only while actorCoverage still covers the same member.
    const actor = parseStoredActor(authority.actingFor);
    return [actor ? await storedActorIdentity(engine, authority.principal, actor).catch(() => []) : []];
  }
  if (!authority.actingFor?.length) return [await memberIdentityFor(engine, authority)];
  try {
    return await resolveAudienceIdentities(engine, { principal: authority.principal, transport: authority.principal.kind === 'local_stdio' ? 'stdio' : 'http' },
      authority.actingFor as AudiencePrincipal[]);
  } catch {
    return [[]];
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
 * GST-2051: the readers a page written by a default-source member writer (defaultSourceMemberWriter) keeps when its content
 * names none: the stored page's readers when it has them, else the writer alone for a page this write creates, unless
 * the writer is the brain owner (GST-2059), whose new pages stay shared. An existing page with no readers stays as it
 * is. Only ever narrows: a page naming readers is left to the caller.
 */
export function defaultSourceWriterReaders(writer: string | null, frontmatter: Record<string, unknown>, stored: { frontmatter?: unknown; deleted_at?: unknown } | null | undefined, owner = false): void {
  if (!writer || hasReaders(frontmatter)) return;
  const live = stored && stored.deleted_at == null ? stored : null;
  if (live && hasReaders(live.frontmatter)) frontmatter.readable_by = (live.frontmatter as Record<string, unknown>).readable_by;
  else if (!live && !owner) frontmatter.readable_by = [writer];
}

/** The one refusal a remote writer gets for a target it may not see; other visibility refusals reuse it verbatim. */
export function pageNotVisibleError() {
  return opError('page_not_found', 'Page not found.', 'This page does not exist or is not visible to this connection, so nothing was written. Do not retry this slug as a create; ask the user whether the page exists and who can read it, or write to a different slug.');
}
