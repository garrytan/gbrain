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
import { readRemotePolicyNow, remotePrivacyRelaxed, type CallerAccess } from '../search/private-visibility.ts';
import { ACCESS_ID_RE, identityFor, normalizePrincipal } from './principals.ts';

/** Config key binding a local stdio MCP server to one member. */
export const STDIO_MEMBER_KEY = 'mcp.stdio_member';

const MEMBER_SQL = (member: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;

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

/** The CallerAccess fields for a remote operation (identity, privacy relaxation and the GBRA-156 private-readable set). */
export async function remoteCallerAccess(engine: BrainEngine, auth: AuthInfo | undefined, privateSources: readonly string[] | undefined, transport?: string): Promise<Partial<CallerAccess>> {
  const [relaxed, remotePolicy] = await Promise.all([remotePrivacyRelaxed(engine), readRemotePolicyNow(engine)]);
  const restricted = remotePolicy.restricted;
  const identity = !restricted ? []
    : !auth && transport === 'stdio' ? await stdioMemberIdentity(engine)
    : await memberIdentityFor(engine, auth);
  return {
    identity,
    privateReadableSources: privateSources ?? [],
    hidePrivate: !relaxed,
    applyRemoteReadPolicy: false,
    restricted,
    remotePolicy,
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
