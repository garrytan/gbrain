/**
 * GBRA-218: the caller-access record of one remote MCP operation. The
 * credential's verifier-derived principal (never a display name or request
 * data) names the token or OAuth client; its bound member, when the member is
 * live, plus that member's groups form the identity readers are checked
 * against. The verifiers (src/core/oauth-provider.ts, src/mcp/http-transport.ts)
 * join the binding once and carry it on AuthInfo.member, so dispatch costs no
 * query; an AuthInfo no verifier built (member undefined) is looked up from
 * its principal. A local stdio server reads its binding from config
 * `mcp.stdio_member`. A brain with no member-access restriction skips all of
 * it. Every failure (pre-migration schema, unreadable row, unknown or
 * disabled member) yields an empty identity, which reads no restricted page.
 */
import type { BrainEngine } from '../engine.ts';
import type { AuthInfo } from '../ops/contract.ts';
import { accessRestrictionsPresent, remotePrivacyRelaxed, type CallerAccess, type FolderCoverage } from '../search/private-visibility.ts';
import { ACCESS_ID_RE, identityFor, normalizePrincipal } from './principals.ts';
import { catalogueError } from '../error-catalogue.ts';
import { hostOnlyError } from '../ops/op-fix.ts';
import { currentCallerAccess } from '../search/private-visibility.ts';
import { GUEST, STDIO_MAY_ACT_FOR_KEY, mayActForCovers, singleMemberAudience, type AudiencePrincipal } from './audience.ts';
import { parseMayActFor } from './members.ts';

/** Config key binding a local stdio MCP server to one member. */
export const STDIO_MEMBER_KEY = 'mcp.stdio_member';

const MEMBERS_WHERE_SQL = (predicate: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE ${predicate} AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;
const MEMBER_SQL = (member: string) => MEMBERS_WHERE_SQL(`m.id = (${member})`);

async function liveIdentity(engine: Pick<BrainEngine, 'executeRaw'>, memberSql: string, param: string): Promise<string[]> {
  try {
    const [row] = await engine.executeRaw<{ id: string; groups: string[] }>(MEMBER_SQL(memberSql), [param]);
    if (!row || normalizePrincipal(`member:${row.id}`) !== `member:${row.id}`) return [];
    const groups = (row.groups ?? []).filter(g => normalizePrincipal(`group:${g}`) === `group:${g}`);
    return identityFor(row.id, groups);
  } catch {
    return [];
  }
}

/** HARN-1: an enabled member's identity by exact id; empty when absent, disabled or unreadable. */
export const enabledMemberIdentity = (engine: Pick<BrainEngine, 'executeRaw'>, id: string) => liveIdentity(engine, '$1', id);

/**
 * The member identity bound to `auth`: the verifier's join when present, else a lookup from its principal; empty
 * when unbound, unknown or unreadable. A write's publication passes only its stored principal, so a member disabled
 * or a binding removed after submission takes effect.
 */
export async function memberIdentityFor(engine: Pick<BrainEngine, 'executeRaw'>, auth: Pick<AuthInfo, 'member'> & { principal?: { kind: string; id: string } } | undefined): Promise<string[]> {
  if (auth?.member !== undefined) return auth.member ? identityFor(auth.member.id, auth.member.groups) : [];
  const principal = auth?.principal;
  if (!principal || (principal.kind !== 'legacy_token' && principal.kind !== 'oauth_client')) return [];
  return liveIdentity(engine, principal.kind === 'legacy_token'
    ? 'SELECT member_id FROM access_tokens WHERE id::text = $1'
    : 'SELECT member_id FROM oauth_clients WHERE client_id = $1', principal.id);
}

/** The member a local stdio server is bound to (config mcp.stdio_member), or null when unset or ill-formed. */
export async function stdioMemberId(engine: BrainEngine): Promise<string | null> {
  try {
    const raw = (await engine.getConfig(STDIO_MEMBER_KEY))?.trim();
    return raw && ACCESS_ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The identity of a local stdio server: its bound live member, else empty (unbound stdio reads no restricted page). */
export async function stdioMemberIdentity(engine: BrainEngine): Promise<string[]> {
  const member = await stdioMemberId(engine);
  return member ? liveIdentity(engine, '$1', member) : [];
}

/**
 * GBRA-218 (A2): the folder-rule part of a caller's record, read live from the applied rulebook: the
 * source-qualified ids of the rules `identity` satisfies, and every prefix that reads as nobody (a narrowing being
 * stamped, an invalid policy file). An unreadable rulebook satisfies nothing and covers everything (fail closed).
 */
export async function folderAccessFor(engine: Pick<BrainEngine, 'executeRaw'>, identity: readonly string[]): Promise<{ satisfiedRuleIds: string[]; folderCoverage: FolderCoverage[] }> {
  return folderAccessForAll(engine, [identity]);
}

/**
 * GBRA-231: folderAccessFor for an audience. A rule is satisfied only when every identity meets its readers, so the
 * satisfied set is the intersection of each entry's set (empty when any entry, a guest included, meets none).
 */
export async function folderAccessForAll(engine: Pick<BrainEngine, 'executeRaw'>, identities: readonly (readonly string[])[]): Promise<{ satisfiedRuleIds: string[]; folderCoverage: FolderCoverage[] }> {
  try {
    const union = [...new Set(identities.flat())];
    const rules = union.length && identities.length && identities.every(id => id.length > 0)
      ? await engine.executeRaw<{ source_id: string; rule_id: string; readable_by: string[] }>('SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]', [union])
      : [];
    const satisfied = rules.filter(r => identities.every(id => (r.readable_by ?? []).some(reader => id.includes(reader))));
    const coverage = await engine.executeRaw<{ source_id: string; prefix: string }>('SELECT DISTINCT source_id, prefix FROM access_pending_coverage ORDER BY source_id, prefix');
    return { satisfiedRuleIds: satisfied.map(r => `${r.source_id}:${r.rule_id}`).sort(), folderCoverage: coverage.map(c => ({ source_id: c.source_id, prefix: c.prefix })) };
  } catch {
    return { satisfiedRuleIds: [], folderCoverage: [{ source_id: '!unreadable', prefix: '' }] };
  }
}

/** Who asserts an audience: a verified credential (live call), a stored principal (a queued write or job), or a stdio server. */
export interface AudienceCaller {
  auth?: Pick<AuthInfo, 'member' | 'mayActFor' | 'clientId' | 'clientName'> & { principal?: { kind: string; id: string } };
  principal?: { kind: string; id: string };
  transport?: string;
}

/**
 * The may_act_for list that bounds `caller`: the verifier's join on a live call (read on every request), else a live
 * lookup from the stored principal (a revoked token or deleted client permits nothing), else for a stdio server
 * config mcp.stdio_may_act_for. Unreadable or ill-formed values permit nothing.
 */
export async function mayActForOf(engine: Pick<BrainEngine, 'executeRaw'>, caller: AudienceCaller): Promise<string[] | null> {
  const auth = caller.auth;
  if (auth?.member !== undefined) return auth.mayActFor ?? null;
  const principal = auth?.principal ?? caller.principal;
  try {
    if (principal?.kind === 'legacy_token') {
      const [row] = await engine.executeRaw<{ may_act_for: unknown }>('SELECT may_act_for FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL', [principal.id]);
      return Array.isArray(row?.may_act_for) ? row!.may_act_for as string[] : null;
    }
    if (principal?.kind === 'oauth_client') {
      const [row] = await engine.executeRaw<{ may_act_for: unknown }>('SELECT may_act_for FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL', [principal.id]);
      return Array.isArray(row?.may_act_for) ? row!.may_act_for as string[] : null;
    }
    if (principal?.kind === 'local_stdio' || (!auth && !principal && caller.transport === 'stdio')) {
      const [row] = await engine.executeRaw<{ value: string | null }>('SELECT value FROM config WHERE key = $1', [STDIO_MAY_ACT_FOR_KEY]);
      const raw = row?.value?.trim();
      return raw ? parseMayActFor(raw) : null;
    }
  } catch { /* unreadable: permits nothing */ }
  return null;
}

function audienceNotPermitted(caller: AudienceCaller, audience: readonly AudiencePrincipal[], mayActFor: readonly string[] | null, missing: readonly string[]) {
  const principal = caller.auth?.principal ?? caller.principal;
  const list = [...new Set([...(mayActFor ?? []), ...audience])].sort().join(',');
  const target = principal?.kind === 'legacy_token' ? { handle: `token ${caller.auth?.clientName ?? principal.id}`, argv: ['gbrain', 'auth', 'rescope', ...(caller.auth?.clientName ? ['--token', caller.auth.clientName] : ['--id', principal.id]), '--may-act-for', list] }
    : principal?.kind === 'oauth_client' ? { handle: `OAuth client ${principal.id}`, argv: ['gbrain', 'auth', 'rescope', '--client', principal.id, '--may-act-for', list] }
    : { handle: 'this stdio server', argv: ['gbrain', 'config', 'set', STDIO_MAY_ACT_FOR_KEY, list] };
  return hostOnlyError({ remote: true, transport: caller.transport === 'stdio' || target.handle === 'this stdio server' ? 'stdio' : 'http' }, 'on_behalf_of_not_permitted',
    `This connection (${target.handle}) may not act for ${missing.join(', ')}, so nothing was read.`,
    target.argv,
    'Lets this credential act for the whole audience. Widening whose notes a shared agent may read is the brain operator\'s decision, never the agent\'s.',
    { suggestion: `A shared agent acts only for the people its credential lists in may_act_for. The brain operator decides whether to approve the audience ${audience.join(', ')} by running the command in fix on the brain host; until then, call without the audience.` });
}

function audienceUnknown(principal: string) {
  const group = principal.startsWith('group:');
  return catalogueError('on_behalf_of_unknown_member', `The audience names ${principal}, which is not ${group ? 'a group' : 'an enabled member'} on this brain, so nothing was read.`,
    `Name enabled members and existing groups only; a person who is not a member joins the audience as guest. The brain operator checks the ids with gbrain access ${group ? 'group' : 'member'} list${group ? '' : ' --all'}.`);
}

/**
 * GBRA-231: the identities of an asserted audience, in order: a member's live identity (itself and its groups), a
 * group as itself, a guest as the empty identity. Every entry must be in the caller's live may_act_for
 * (on_behalf_of_not_permitted, checked first so it never confirms whether an id exists) and name an enabled member
 * or an existing group (on_behalf_of_unknown_member). Read on every call, so a revoked permission or a disabled
 * member takes effect at once.
 */
export async function resolveAudienceIdentities(engine: Pick<BrainEngine, 'executeRaw'>, caller: AudienceCaller, audience: readonly AudiencePrincipal[]): Promise<string[][]> {
  const mayActFor = await mayActForOf(engine, caller);
  const missing = audience.filter(p => !mayActForCovers(mayActFor, p));
  if (missing.length) throw audienceNotPermitted(caller, audience, mayActFor, missing);
  const memberIds = audience.filter(p => p.startsWith('member:')).map(p => p.slice('member:'.length));
  const groupIds = audience.filter(p => p.startsWith('group:')).map(p => p.slice('group:'.length));
  const members = new Map<string, string[]>();
  const groups = new Set<string>();
  try {
    if (memberIds.length) {
      for (const row of await engine.executeRaw<{ id: string; groups: string[] }>(MEMBERS_WHERE_SQL('m.id = ANY($1::text[])'), [memberIds])) {
        members.set(row.id, (row.groups ?? []).filter(g => normalizePrincipal(`group:${g}`) === `group:${g}`));
      }
    }
    if (groupIds.length) for (const row of await engine.executeRaw<{ id: string }>('SELECT id FROM access_groups WHERE id = ANY($1::text[])', [groupIds])) groups.add(row.id);
  } catch { /* unreadable: every entry reads as unknown below */ }
  return audience.map(p => {
    if (p === GUEST) return [];
    if (p.startsWith('group:')) { if (!groups.has(p.slice(6))) throw audienceUnknown(p); return [p]; }
    const id = p.slice('member:'.length);
    const memberGroups = members.get(id);
    if (!memberGroups) throw audienceUnknown(p);
    return identityFor(id, memberGroups);
  });
}

/**
 * The CallerAccess fields for a remote operation (identity, privacy relaxation and the GBRA-156 private-readable set).
 * GBRA-231: with an asserted `audience` the identities are the audience's (resolveAudienceIdentities, which refuses
 * an entry outside may_act_for or naming no member), the source grant stays the caller's, and the caller's privacy
 * relaxation (granted_sources, an operator hatch) applies only when the audience is exactly one member: a channel
 * (several entries, a group or a guest) sees no visibility: private page.
 */
export async function remoteCallerAccess(engine: BrainEngine, auth: AuthInfo | undefined, privateSources: readonly string[] | undefined, transport?: string, audience?: readonly AudiencePrincipal[] | null): Promise<Partial<CallerAccess>> {
  const [relaxed, restricted] = await Promise.all([remotePrivacyRelaxed(engine), accessRestrictionsPresent(engine)]);
  if (audience?.length) {
    const identities = await resolveAudienceIdentities(engine, { auth, transport }, audience);
    const single = singleMemberAudience(audience);
    return {
      identity: identities.length === 1 ? identities[0]! : [],
      audience: [...audience],
      audienceIdentities: identities.length > 1 ? identities : [],
      ...(restricted ? await folderAccessForAll(engine, identities) : { satisfiedRuleIds: [], folderCoverage: [] }),
      privateReadableSources: single ? privateSources ?? [] : [],
      hidePrivate: single ? !relaxed : true,
      applyRemoteReadPolicy: false,
      restricted,
    };
  }
  const identity = !restricted ? []
    : !auth && transport === 'stdio' ? await stdioMemberIdentity(engine)
    : await memberIdentityFor(engine, auth);
  return {
    identity,
    audience: null,
    audienceIdentities: [],
    ...(restricted ? await folderAccessFor(engine, identity) : { satisfiedRuleIds: [], folderCoverage: [] }),
    privateReadableSources: privateSources ?? [],
    hidePrivate: !relaxed,
    applyRemoteReadPolicy: false,
    restricted,
  };
}

/**
 * GBRA-231: the view a remote call was answered under, as `_meta.access` on every remote response and `access.applied`
 * in whoami: the member and groups it read as (none for an audience of several entries), the asserted audience, the
 * applied folder-rule revision of each source the credential is granted (every source for an unauthenticated stdio
 * server; null on a brain with no restriction) and the privacy relaxation in force.
 */
export interface AppliedAccess {
  member: string | null;
  groups: string[];
  audience: string[] | null;
  /** GST-359 C1: present on an attested call (the system that named the person; the id is not echoed). */
  actor?: { system: string };
  policy_rev: Record<string, number> | null;
  relaxation: 'none' | 'granted_sources' | 'operator';
}

export async function appliedAccessSummary(engine: Pick<BrainEngine, 'executeRaw'>, auth?: AuthInfo, sourceIds: readonly (string | undefined)[] = []): Promise<AppliedAccess> {
  const access = currentCallerAccess();
  const member = access.identity.find(p => p.startsWith('member:'))?.slice('member:'.length) ?? null;
  let policyRev: Record<string, number> | null = null;
  if (access.restricted) {
    try {
      const rows = await engine.executeRaw<{ source_id: string; rev: number | string | null }>(
        'SELECT source_id, max(revision) FILTER (WHERE applied_at IS NOT NULL) AS rev FROM access_policy_revisions GROUP BY source_id ORDER BY source_id');
      const visible = auth ? new Set([auth.sourceId, ...(auth.allowedSources ?? []), ...sourceIds].filter(Boolean)) : null;
      policyRev = Object.fromEntries(rows.filter(r => r.rev !== null && (!visible || visible.has(r.source_id))).map(r => [r.source_id, Number(r.rev)]));
    } catch { policyRev = null; }
  }
  return {
    member,
    groups: access.identity.filter(p => p.startsWith('group:')).map(p => p.slice('group:'.length)),
    audience: access.audience ? [...access.audience] : null,
    ...(access.actor ? { actor: { system: access.actor.system } } : {}),
    policy_rev: policyRev,
    relaxation: !access.hidePrivate ? 'operator' : access.privateReadableSources.length ? 'granted_sources' : 'none',
  };
}

/** What whoami and grant_diagnosis report about the caller's member identity. */
export interface CallerAccessView {
  member: string | null;
  groups: string[];
  may_act_for: string[] | null;
  bound_by: 'credential' | 'stdio_config' | 'as' | 'none';
  note?: string;
}

export function accessView(identity: readonly string[], boundBy: CallerAccessView['bound_by'], mayActFor: string[] | null = null, note?: string): CallerAccessView {
  const member = identity.find(p => p.startsWith('member:'))?.slice('member:'.length) ?? null;
  return {
    member,
    groups: identity.filter(p => p.startsWith('group:')).map(p => p.slice('group:'.length)),
    may_act_for: mayActFor,
    bound_by: member ? boundBy : 'none',
    ...(note ? { note } : {}),
  };
}

const UNBOUND_NOTE = 'Bound to no member: pages that name readers (readable_by) are hidden from this caller, and a not_found may be such a page.';

/** The access view of an authenticated credential (the verifier's join, else a principal lookup). */
export async function credentialAccessView(engine: BrainEngine, auth: AuthInfo): Promise<CallerAccessView> {
  const identity = await memberIdentityFor(engine, auth);
  return accessView(identity, 'credential', auth.mayActFor ?? null, identity.length ? undefined : UNBOUND_NOTE);
}

/** The access view of a local stdio server (config mcp.stdio_member). */
export async function stdioAccessView(engine: BrainEngine): Promise<CallerAccessView> {
  const [configured, identity] = await Promise.all([stdioMemberId(engine), stdioMemberIdentity(engine)]);
  if (identity.length) return accessView(identity, 'stdio_config');
  return accessView([], 'none', null, configured
    ? `mcp.stdio_member names "${configured}", which is not an enabled member, so this server reads no page that names readers.`
    : `${UNBOUND_NOTE} Bind it with gbrain config set ${STDIO_MEMBER_KEY} <member>.`);
}
