/**
 * GBRA-218: the caller-access record of one remote MCP operation. The
 * credential's verifier-derived principal (never a display name or request
 * data) names the token or OAuth client; its bound member, when the member is
 * live, plus that member's groups form the identity readers are checked
 * against. The verifiers (src/core/oauth-provider.ts, src/mcp/http-transport.ts)
 * join the binding once and carry it on AuthInfo.member, so dispatch costs no
 * query; an AuthInfo no verifier built (member undefined) is looked up from
 * its principal. A local stdio server reads its binding from its own
 * `gbrain serve --stdio-member <id>` (the harness's MCP entry, so one
 * registration on one machine), else from config `mcp.stdio_member` set by
 * hand. A remote read or write on a brain with no member-access restriction
 * and no owner never looks a binding up. An empty identity means the
 * credential is unbound or its member is unknown, disabled or removed; it
 * reads no restricted page. A lookup that fails never reads as unbound, which
 * would open every unlabelled page to a labelled-only member. A statement the
 * database rejected (a SQLSTATE) throws access_identity_unavailable, which is
 * retryable, unless the persistence consumer's transientDatabaseFailure or
 * transientInterruption classifies it (a dropped connection, a lock or
 * statement timeout, a stale plan, a publication past its ceiling); that, and
 * every failure that is not a statement error (a preparation deadline, an
 * abort, a coded refusal), is rethrown unchanged, so a stored write keeps its
 * consumer's release, retry and deadline handling. The one failure that stays
 * empty is a schema older than the member tables (v282), whose lookup misses
 * access_members, access_group_members or the member_id column; no member,
 * labelled-only (v308) or not, can exist there, and every owner caller there
 * is unbound.
 */
import type { BrainEngine } from '../engine.ts';
import type { AuthInfo } from '../ops/contract.ts';
import { remotePrivacyRelaxed, requestRemotePolicy, type CallerAccess, type FolderCoverage, type RemotePolicy } from '../search/private-visibility.ts';
import { ACCESS_ID_RE, identityFor, normalizePrincipal } from './principals.ts';
import { catalogueError } from '../error-catalogue.ts';
import type { Action } from '../agent-output.ts';
import { markNotAdmitted, OperationError, opError } from '../ops/contract.ts';
import { hostOnlyError } from '../ops/op-fix.ts';
import { currentCallerAccess } from '../search/private-visibility.ts';
import { edgeTrimSql } from '../edge-whitespace.ts';
import { GUEST, STDIO_MAY_ACT_FOR_KEY, mayActForCovers, singleMemberAudience, type AudiencePrincipal } from './audience.ts';
import { audienceMemberIds, parseMayActFor } from './members.ts';
import { stdioBindRoute } from './stdio-bind-route.ts';
import { labelledOnlyFor } from './labelled-only.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { transientDatabaseFailure, transientInterruption } from '../persistence/transient-retry.ts';

/** Config key binding a local stdio MCP server to one member. */
export const STDIO_MEMBER_KEY = 'mcp.stdio_member';

const MEMBERS_WHERE_SQL = (predicate: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE ${predicate} AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;
const MEMBER_SQL = (member: string) => MEMBERS_WHERE_SQL(`m.id = (${member})`);

/** The objects v282 added that the lookup reads: a schema without them predates the member tables. */
const MEMBER_TABLES = ['access_members', 'access_group_members'];
const MEMBER_COLUMN = 'member_id';
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const IDENTITY_RETRY_AFTER_MS = 2_000;
const WHOAMI: NonNullable<Action['verify']> = { argv: ['gbrain', 'whoami', '--json'], mcp: { tool: 'whoami', arguments: {} } };

function identityUnavailable(): OperationError {
  return opError('access_identity_unavailable', 'The member this connection is bound to could not be looked up, so nothing was read or written.',
    'Retry the same request in a few seconds (a write with the same request_id); if it keeps failing, ask the brain operator to run gbrain doctor --json on the brain host.', {
      why: 'Reading the credential\'s member binding failed with a database error. Reading the connection as unbound instead would open pages its member may not read, so the request stops here.',
      detail: `retry_after_ms=${IDENTITY_RETRY_AFTER_MS}`,
      fix: { ...WHOAMI, consent: [], actor: 'provider', requires_exclusive: false, verify: WHOAMI,
        why: 'After a few seconds whoami reads the binding again and shows the member this connection reads as; then repeat the original request.' },
    });
}

/**
 * Marks a transient failure liveIdentity rethrew unchanged (a non-enumerable property, so the error still reads the
 * same to the persistence consumer), so the dispatch boundary can tell it from other statements' failures.
 */
const TRANSIENT_LOOKUP_FAILURE = Symbol('gbrain.transientIdentityLookupFailure');

/**
 * At the MCP dispatch boundary: access_identity_unavailable (retryable, not admitted) when `error`, or an error it was
 * wrapped in, is a transient failure of a member-identity lookup; else null. A request that fails this way at
 * submission has written nothing, so the same request_id can be sent again. The persistence consumer never sees the
 * mapping: its lookups keep the original error, which it releases and retries.
 */
export function identityLookupUnavailable(error: unknown): OperationError | null {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { [TRANSIENT_LOOKUP_FAILURE]?: true })[TRANSIENT_LOOKUP_FAILURE] === true) return markNotAdmitted(identityUnavailable());
  }
  return null;
}

async function liveIdentity(engine: Pick<BrainEngine, 'executeRaw'>, memberSql: string, param: string): Promise<string[]> {
  let row: { id: string; groups: string[] } | undefined;
  try {
    [row] = await engine.executeRaw<{ id: string; groups: string[] }>(MEMBER_SQL(memberSql), [param]);
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', MEMBER_TABLES) || isMissingSchemaObject(error, 'column', MEMBER_COLUMN)) return [];
    if (error && typeof error === 'object' && (transientDatabaseFailure(error) || transientInterruption(error))) {
      if (Object.isExtensible(error)) Object.defineProperty(error, TRANSIENT_LOOKUP_FAILURE, { value: true });
      throw error;
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !SQLSTATE_RE.test(code)) throw error;
    throw identityUnavailable();
  }
  if (!row || normalizePrincipal(`member:${row.id}`) !== `member:${row.id}`) return [];
  const groups = (row.groups ?? []).filter(g => normalizePrincipal(`group:${g}`) === `group:${g}`);
  return identityFor(row.id, groups);
}

/**
 * The member identity bound to `auth`: the verifier's join when present, else a lookup from its principal (a local
 * stdio principal reads the member its serve was started with, stamped as `stdioMember` on a stored write, else
 * config mcp.stdio_member, as stdio reads do); empty when unbound or the member is unknown or not enabled; a lookup
 * that fails throws (liveIdentity: a transient database failure unchanged, else access_identity_unavailable). A write's publication passes only its stored
 * principal, so a member disabled or a binding removed after submission takes effect.
 */
export async function memberIdentityFor(engine: Pick<BrainEngine, 'executeRaw'>, auth: Pick<AuthInfo, 'member'> & { principal?: { kind: string; id: string }; stdioMember?: string } | undefined): Promise<string[]> {
  if (auth?.member !== undefined) return auth.member ? identityFor(auth.member.id, auth.member.groups) : [];
  const principal = auth?.principal;
  if (principal?.kind === 'local_stdio') return auth?.stdioMember !== undefined ? liveIdentity(engine, '$1', auth.stdioMember)
    : liveIdentity(engine, `SELECT ${edgeTrimSql('value')} FROM config WHERE key = $1`, STDIO_MEMBER_KEY);
  if (!principal || (principal.kind !== 'legacy_token' && principal.kind !== 'oauth_client')) return [];
  return liveIdentity(engine, principal.kind === 'legacy_token'
    ? 'SELECT member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'
    : 'SELECT member_id FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL', principal.id);
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

/**
 * The identity of a local stdio server: the live member its serve was started with (--stdio-member), else the live
 * member config mcp.stdio_member names, else empty. A named member that is disabled or unknown reads as nobody and
 * never falls back to the config key; a lookup that fails throws (liveIdentity). With no member named it runs no
 * query.
 */
export async function stdioMemberIdentity(engine: BrainEngine, registered?: string): Promise<string[]> {
  const member = registered ?? await stdioMemberId(engine);
  return member ? liveIdentity(engine, '$1', member) : [];
}

/**
 * GBRA-218 (A2): the folder-rule part of a caller's record, read live from the applied rulebook: the
 * source-qualified ids of the rules `identity` satisfies, and every prefix that reads as nobody (a narrowing being
 * stamped, an invalid policy file). An unreadable rulebook satisfies nothing and covers everything (fail closed), and so
 * does one row-level security hides from this database role.
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
    const coverage = await engine.executeRaw<{ source_id: string; prefix: string }>(`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`);
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
async function mayActForOf(engine: Pick<BrainEngine, 'executeRaw'>, caller: AudienceCaller): Promise<string[] | null> {
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
export async function resolveAudienceIdentities(engine: Pick<BrainEngine, 'executeRaw'>, caller: AudienceCaller, audience: readonly AudiencePrincipal[],
  opts: { mayActFor?: 'enforce' | 'owner_room_assessment' } = {}): Promise<string[][]> {
  // GBRA-498: only room.ts passes owner_room_assessment, after it checked that the caller reads as the brain owner or is
  // the trusted local CLI; it marks results for a room and never reads as the room, so neither needs may_act_for for it.
  if (opts.mayActFor !== 'owner_room_assessment') {
    const mayActFor = await mayActForOf(engine, caller);
    const missing = audience.filter(p => !mayActForCovers(mayActFor, p));
    if (missing.length) throw audienceNotPermitted(caller, audience, mayActFor, missing);
  }
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
 * GST-2059: a caller bound to the brain owner (config access.owner_member) reads with its privacy relaxed in every
 * source its grant reads (owner), with no audience or an audience of the owner alone; member access stays.
 * GST-363: `stdioMember` is the member an unauthenticated stdio server was started with (serve --stdio-member).
 * GST-2490: `readOnly` (a non-mutating operation) gives an owner read the owner's lineage (a derivative of origins it
 * reads) and, under access.owner_reads_restricted, the opt-in; a write's checks keep the every-caller rule, so its
 * pre-check and its publication agree.
 * GBRA-108: under access.members_read_lineage a read by any other member speaking for itself (no audience, or an
 * audience of that one member) gets the same lineage (design 3), and an owner read carries the audience members
 * (design 2). Never an audience of several, a group or a guest, and never an unbound credential (no member identity).
 * GBRA-108 design 1: a read or write whose bound member, or any member of its audience, is labelled-only reads only
 * pages that name it (labelledOnly); never the owner.
 */
export async function remoteCallerAccess(engine: BrainEngine, auth: AuthInfo | undefined, privateSources: readonly string[] | undefined, transport?: string, audience?: readonly AudiencePrincipal[] | null, stdioMember?: string, readOnly = false): Promise<Partial<CallerAccess>> {
  const [relaxed, remotePolicy] = await Promise.all([remotePrivacyRelaxed(engine), requestRemotePolicy(engine)]);
  const restricted = remotePolicy.restricted;
  if (audience?.length) return audienceCallerAccess(engine, auth, privateSources, transport, audience, await resolveAudienceIdentities(engine, { auth, transport }, audience), stdioMember, readOnly, relaxed, remotePolicy);
  const identity = restricted || remotePolicy.ownerMember ? await boundIdentity(engine, auth, transport, stdioMember) : [];
  const owner = isOwner(identity, remotePolicy);
  const lineage = readOnly && identity.some(p => p.startsWith('member:')) && (owner || remotePolicy.membersReadLineage === true);
  return {
    identity,
    audience: null,
    audienceIdentities: [],
    ...(restricted ? await folderAccessFor(engine, identity) : { satisfiedRuleIds: [], folderCoverage: [] }),
    privateReadableSources: privateSources ?? [],
    hidePrivate: !relaxed && !owner,
    owner,
    lineage,
    ownerReadsRestricted: owner && lineage && remotePolicy.ownerReadsRestricted === true,
    audienceKindMembers: owner && lineage ? await audienceMemberIds(engine) : [],
    labelledOnly: !owner && restricted && await labelledOnlyFor(engine, [identity]),
    applyRemoteReadPolicy: false,
    restricted,
    remotePolicy,
  };
}

/**
 * GBRA-231: the access record of an audience whose identities resolveAudienceIdentities resolved. GBRA-498: room.ts
 * builds a room's record with it, so a room mark and an on_behalf_of read of the same audience judge pages alike.
 */
export async function audienceCallerAccess(engine: BrainEngine, auth: AuthInfo | undefined, privateSources: readonly string[] | undefined, transport: string | undefined,
  audience: readonly AudiencePrincipal[], identities: string[][], stdioMember?: string, readOnly = false,
  relaxed?: boolean, policy?: RemotePolicy): Promise<Partial<CallerAccess>> {
  const remotePolicy = policy ?? await requestRemotePolicy(engine);
  const restricted = remotePolicy.restricted;
  if (relaxed === undefined) relaxed = await remotePrivacyRelaxed(engine);
  const single = singleMemberAudience(audience);
  const owner = single && audience[0] === `member:${remotePolicy.ownerMember}`
    && isOwner(await boundIdentity(engine, auth, transport, stdioMember), remotePolicy);
  const lineage = readOnly && single && identities.length === 1 && (owner || remotePolicy.membersReadLineage === true);
  return {
    identity: identities.length === 1 ? identities[0]! : [],
    audience: [...audience],
    audienceIdentities: identities.length > 1 ? identities : [],
    ...(restricted ? await folderAccessForAll(engine, identities) : { satisfiedRuleIds: [], folderCoverage: [] }),
    privateReadableSources: single ? privateSources ?? [] : [],
    hidePrivate: single ? !relaxed && !owner : true,
    owner,
    lineage,
    ownerReadsRestricted: owner && lineage && remotePolicy.ownerReadsRestricted === true,
    audienceKindMembers: owner && lineage ? await audienceMemberIds(engine) : [],
    labelledOnly: !owner && restricted && await labelledOnlyFor(engine, [...identities, await boundIdentity(engine, auth, transport, stdioMember)]),
    applyRemoteReadPolicy: false,
    restricted,
    remotePolicy,
  };
}

/** The member identity a remote caller's credential (or, unauthenticated over stdio, serve --stdio-member, else config mcp.stdio_member) is bound to. */
async function boundIdentity(engine: BrainEngine, auth: AuthInfo | undefined, transport?: string, stdioMember?: string): Promise<string[]> {
  return !auth && transport === 'stdio' ? stdioMemberIdentity(engine, stdioMember) : memberIdentityFor(engine, auth);
}

/** GST-2059: the live identity is the brain owner's (config access.owner_member). Only a live, enabled member has an identity. */
function isOwner(identity: readonly string[], policy: RemotePolicy): boolean {
  return !!policy.ownerMember && identity.includes(`member:${policy.ownerMember}`);
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
  relaxation: 'none' | 'granted_sources' | 'operator' | 'owner';
}

export async function appliedAccessSummary(engine: Pick<BrainEngine, 'executeRaw'>, auth?: AuthInfo, sourceIds: readonly (string | undefined)[] = []): Promise<AppliedAccess> {
  const access = currentCallerAccess();
  const member = access.identity.find(p => p.startsWith('member:'))?.slice('member:'.length) ?? null;
  let policyRev: Record<string, number> | null = null;
  if (access.restricted) {
    try {
      const rows = await engine.executeRaw<{ source_id: string; rev: number | string | null }>(
        `SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`);
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
    relaxation: access.owner ? 'owner' : !access.hidePrivate ? 'operator' : access.privateReadableSources.length ? 'granted_sources' : 'none',
  };
}

/** What whoami and grant_diagnosis report about the caller's member identity. */
export interface CallerAccessView {
  member: string | null;
  groups: string[];
  may_act_for: string[] | null;
  bound_by: 'credential' | 'stdio_registration' | 'stdio_config' | 'as' | 'none';
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

/** The access view of a local stdio server: serve --stdio-member (`registered`) when it was started with one, else config mcp.stdio_member. */
export async function stdioAccessView(engine: BrainEngine, registered?: string): Promise<CallerAccessView> {
  const [configured, identity] = await Promise.all([stdioMemberId(engine), stdioMemberIdentity(engine, registered)]);
  if (registered !== undefined) {
    const ignored = configured && configured !== registered ? ` config mcp.stdio_member names "${configured}", which this server ignores: its own --stdio-member wins.` : '';
    if (identity.length) return accessView(identity, 'stdio_registration', null, ignored.trim() || undefined);
    return accessView([], 'none', null, `This server was started with --stdio-member ${registered}, which is not an enabled member, so it reads no page that names readers.${ignored}`);
  }
  if (identity.length) return accessView(identity, 'stdio_config');
  return accessView([], 'none', null, configured
    ? `mcp.stdio_member names "${configured}", which is not an enabled member, so this server reads no page that names readers.`
    : `${UNBOUND_NOTE} ${stdioBindRoute().text}`);
}
