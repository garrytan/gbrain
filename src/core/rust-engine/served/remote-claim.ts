/**
 * The check a brain server makes before it runs a remote whole operation (remote-whole-ops.ts) whose claimed grant names
 * a principal other than the owner's floor: a member's OAuth client or legacy token, which an owner-floor client (an
 * HTTP MCP server of the owner, say) sends for the caller it serves (docs/designs/rust-engine/multi-user-server.md,
 * "Follow-up (A1)").
 *
 * A claim with no principal is the owner's floor itself and is not checked here (the owner may already set any client's
 * surface and write as itself). A claim that names a principal is checked against the store before anything runs:
 *  - the credential is live (an OAuth client not deleted, a legacy token not revoked), and an OAuth client's grant names
 *    its own client id;
 *  - each claimed scope is one the stored grant holds;
 *  - a claimed member binding is the one the store binds the credential to;
 *  - the frame's access record is no wider than the record the server builds from the store for that principal (its
 *    claimed audience resolved and refused as the dispatch resolves it; an attested actor through storedActorIdentity).
 * A frame with no access record runs under the narrowest view (served/session-calls.ts), so it needs no check.
 * The write path re-reads the stored grant again (persistence/authority.ts authorizeWrite and authorizePageVisibility),
 * so a claim that passes here still writes only inside its grant.
 * The same check bounds a non-owner connection once A1 lifts, alongside the record the session proved for it
 * (owner-ipc/frame-access.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import { opError, type AuthInfo, type Operation } from '../../ops/contract.ts';
import { hasScope } from '../../scope.ts';
import { grantFromTokenRow } from '../../grants/model.ts';
import { folderAccessFor, memberIdentityFor, remoteCallerAccess } from '../../access/caller.ts';
import { labelledOnlyFor } from '../../access/labelled-only.ts';
import { storedActorIdentity } from '../../access/actor.ts';
import { parseStoredActor } from '../../access/actor-model.ts';
import type { AudiencePrincipal } from '../../access/audience.ts';
import { callerAccessRecord, type CallerAccess } from '../../search/private-visibility.ts';
import type { Principal } from '../../persistence/model.ts';

type ClaimReason = 'credential_revoked' | 'client_mismatch' | 'scope_widened' | 'member_mismatch' | 'access_mismatch';

const MESSAGES: Record<ClaimReason, string> = {
  credential_revoked: 'The credential this call claims is revoked or unknown, so nothing ran.',
  client_mismatch: 'The call claimed an OAuth client other than the one its credential is, so nothing ran.',
  scope_widened: 'The call claimed a scope its credential\'s stored grant does not hold, so nothing ran.',
  member_mismatch: 'The call claimed a member other than the one its credential is bound to, so nothing ran.',
  access_mismatch: 'The call claimed a caller access record wider than the one its credential has, so nothing ran.',
};

function refused(reason: ClaimReason, name: string): Error {
  return opError('permission_denied', MESSAGES[reason],
    'Send the call with the grant and access record the credential\'s own verification built. This is a client bug if it repeats.',
    { reason, retryable: false, detail: `member=${name} via=served reason=${reason} ran=false written=nothing`,
      why: 'A served brain runs a call for a member\'s credential only inside what the store grants that credential.' });
}

/** The principal a claim names, or null for the owner's floor; a principal of another kind is refused. */
function claimedPrincipal(auth: AuthInfo, name: string): Principal | null {
  const p = auth.principal as { kind?: unknown; id?: unknown } | undefined;
  if (p === undefined || p === null) return null;
  if ((p.kind !== 'oauth_client' && p.kind !== 'legacy_token') || typeof p.id !== 'string' || !p.id) throw refused('client_mismatch', name);
  return { kind: p.kind, id: p.id } as Principal;
}

/** The scopes the principal's stored grant holds; throws when the credential is not live. */
async function storedScopes(engine: BrainEngine, principal: Principal, auth: AuthInfo, name: string): Promise<string[]> {
  if (principal.kind === 'oauth_client') {
    const row = await engine.readOAuthClientWriteGrant(principal.id);
    if (!row || row.deleted_at != null) throw refused('credential_revoked', name);
    if (auth.clientId !== principal.id) throw refused('client_mismatch', name);
    return typeof row.scope === 'string' ? row.scope.split(/\s+/).filter(Boolean) : [];
  }
  const row = await engine.readAccessTokenWriteGrant(principal.id);
  if (!row || row.revoked_at != null) throw refused('credential_revoked', name);
  return [...grantFromTokenRow(row).scopes];
}

const sorted = (xs: readonly string[] | undefined) => JSON.stringify([...(xs ?? [])].sort());
const within = (xs: readonly string[] | undefined, of: readonly string[] | undefined) => (xs ?? []).every(x => (of ?? []).includes(x));
const canonical = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/** The record the store gives `principal` for this call: its own, its claimed audience's, or its attested actor's. */
async function storedRecord(engine: BrainEngine, principal: Principal, claimed: CallerAccess, op: Operation, transport: string, name: string): Promise<Partial<CallerAccess>> {
  const auth = { token: '', clientId: principal.id, scopes: [], principal } as unknown as AuthInfo;
  if (claimed.actor) {
    const actor = parseStoredActor(claimed.actor);
    if (!actor) throw refused('access_mismatch', name);
    const identity = await storedActorIdentity(engine, principal, actor, name);
    const base = await remoteCallerAccess(engine, auth, undefined, transport, null, undefined, false);
    return { ...base, identity, audience: claimed.audience, audienceIdentities: [], actor: claimed.actor, owner: false, lineage: false,
      hidePrivate: true, privateReadableSources: [], ownerReadsRestricted: false, audienceKindMembers: [],
      ...(base.restricted ? await folderAccessFor(engine, identity) : {}),
      labelledOnly: !!base.restricted && await labelledOnlyFor(engine, [identity]) };
  }
  const audience = claimed.audience?.length ? claimed.audience as readonly AudiencePrincipal[] : null;
  return remoteCallerAccess(engine, auth, undefined, transport, audience, undefined, op.mutating === false);
}

/** True when record `c` reads no more than record `r`: every widening field of `c` is inside `r`'s. */
function narrows(c: CallerAccess, r: Partial<CallerAccess>): boolean {
  return within(c.identity, r.identity)
    && canonical(c.audience ?? null) === canonical(r.audience ?? null)
    && canonical(c.audienceIdentities ?? []) === canonical(r.audienceIdentities ?? [])
    && canonical(c.actor ?? null) === canonical(r.actor ?? null)
    && (!c.owner || !!r.owner) && (!c.ownerReads || !!r.owner) && (!c.lineage || !!r.lineage)
    && (c.hidePrivate !== false || r.hidePrivate === false)
    && within(c.privateReadableSources, r.privateReadableSources) && within(c.privateFactSources, r.privateFactSources)
    && within(c.satisfiedRuleIds, r.satisfiedRuleIds) && within(c.audienceKindMembers, r.audienceKindMembers)
    && (r.folderCoverage ?? []).every(f => (c.folderCoverage ?? []).some(g => canonical(g) === canonical(f)))
    && (!r.labelledOnly || c.labelledOnly === true) && (!r.restricted || c.restricted === true)
    && (!r.ownerReadsRestricted || c.ownerReadsRestricted === true) && (!r.applyRemoteReadPolicy || c.applyRemoteReadPolicy === true)
    && (c.remotePolicy == null || (c.remotePolicy.ownerMember ?? null) === (r.remotePolicy?.ownerMember ?? null));
}

/**
 * Checks the claimed grant `auth` of remote whole operation `name` (and the frame's access record, the caller access
 * of this call) against the store, when the grant names a principal. Throws `permission_denied` before anything runs.
 */
export async function verifyRemoteClaim(engine: BrainEngine, name: string, op: Operation, auth: AuthInfo, transport: unknown): Promise<void> {
  const principal = claimedPrincipal(auth, name);
  if (!principal) return;
  const scopes = await storedScopes(engine, principal, auth, name);
  if (!(auth.scopes ?? []).every(s => hasScope(scopes, s))) throw refused('scope_widened', name);
  const bound = await memberIdentityFor(engine, { principal });
  if (auth.member !== undefined && sorted(await memberIdentityFor(engine, { member: auth.member })) !== sorted(bound)) throw refused('member_mismatch', name);
  const claimed = callerAccessRecord();
  if (claimed === null) return;
  const own = await storedRecord(engine, principal, claimed, op, typeof transport === 'string' ? transport : 'http', name);
  if (!narrows(claimed, own)) throw refused('access_mismatch', name);
}
