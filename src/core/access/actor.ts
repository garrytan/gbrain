/**
 * GST-359 C1 (GBRA-218): the attested actor. A trusted system's credential (only `qm` today) names the person a call
 * serves in the `x-qm-actor` header: an opaque canonical id (a Slack id, an email principal, `oidc:<hash>:<subject>`),
 * 1-256 visible ASCII characters, compared exactly. gbrain maps it through `access_member_links` to one enabled member
 * and reads and writes as that member, never relaxing privacy.
 *
 * Two facts must both hold, re-read on every call and at every later publication or job tool call (actorCoverage):
 *  - the credential holds the attest right for the system: `attest_actor` on a legacy token bound to no member, or on
 *    an OAuth client bound to no member whose token came from the client-credentials grant (the verifier checks the
 *    grant that issued the token; a stored principal checks the client's registration);
 *  - the id is linked to an enabled member.
 * Everything lives in the database, so a repo-less brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import type { AuthInfo } from '../ops/contract.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { hostOnlyError } from '../ops/op-fix.ts';
import { catalogueError, ERROR_CATALOGUE } from '../error-catalogue.ts';
import type { CallerAccess } from '../search/private-visibility.ts';
import { identityFor } from './principals.ts';
import { isUndefinedColumnError, isUndefinedTableError } from '../utils.ts';
import { memberIdentity } from './members.ts';
import { folderAccessFor, memberIdentityFor } from './caller.ts';
import { ACTOR_ARGUMENT, ACTOR_DEFERRED_OPS, ACTOR_HEADER, attestRightFrom, DEFAULT_ATTEST_OPS, EXTERNAL_ID_RE, QM_AUDIENCE_HEADER, type AttestedActor, type AttestRight } from './actor-model.ts';

export * from './actor-model.ts';

const ATTESTABLE_SCOPES = new Set(['read', 'write', 'agent']);



export type ActorReason = 'no_attest_right' | 'op_not_attested' | 'argument_mismatch' | 'argument_without_attestation' | 'invalid_actor_id' | 'actor_required' | 'audience_not_supported';
/** The operation metadata attestability reads (a subset of Operation, so this module never imports the registry). */
export interface AttestableOpShape { scope?: string; requiredScopes?: readonly string[]; localOnly?: boolean; cliOnly?: unknown }

type Principal = { kind: string; id: string };
export interface ActorCaller {
  auth?: Pick<AuthInfo, 'attest' | 'member' | 'clientName'> & { principal?: Principal };
  principal?: Principal;
}

/** The caller's live attest right: the verifier's on a live call, else a row lookup from the stored principal. */
export async function attestRightOf(engine: Pick<BrainEngine, 'executeRaw'>, caller: ActorCaller): Promise<AttestRight | null> {
  if (caller.auth?.attest !== undefined) return caller.auth.attest ?? null;
  const principal = caller.auth?.principal ?? caller.principal;
  try {
    if (principal?.kind === 'legacy_token') {
      const [row] = await engine.executeRaw<Record<string, unknown>>(
        'SELECT attest_actor, attest_ops, member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL', [principal.id]);
      return attestRightFrom(row, 'legacy', row?.member_id);
    }
    if (principal?.kind === 'oauth_client') {
      const [row] = await engine.executeRaw<Record<string, unknown>>(
        `SELECT attest_actor, attest_ops, member_id, grant_types, client_secret_hash IS NOT NULL AS confidential FROM oauth_clients
         WHERE client_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL`, [principal.id]);
      const cc = Array.isArray(row?.grant_types) && (row!.grant_types as unknown[]).includes('client_credentials') && row!.confidential === true;
      return attestRightFrom(row, cc ? 'client_credentials' : null, row?.member_id);
    }
  } catch (e) {
    // A schema before the attest columns has no right. Any other failure (a lock timeout, an aborted transaction) is
    // rethrown: read as "no right" it would refuse a stored write for good instead of letting it retry.
    if (!isUndefinedTableError(e) && !isUndefinedColumnError(e, 'attest_')) throw e;
  }
  return null;
}

/** Whether an operation may ever run under an attested actor: the reserved memory pair or a read, write or agent op. */
export function attestableOp(name: string, op: AttestableOpShape | undefined): boolean {
  if (ACTOR_DEFERRED_OPS.has(name)) return false;
  if (DEFAULT_ATTEST_OPS.includes(name)) return true;
  if (!op || op.localOnly || op.cliOnly) return false;
  return ATTESTABLE_SCOPES.has(op.scope ?? 'read') && !(op.requiredScopes ?? []).some(s => !ATTESTABLE_SCOPES.has(s));
}

/** A `--attest-ops` value: distinct operation names, each attestable; admin and membership ops are refused. */
export function parseAttestOps(raw: string, lookup: (name: string) => AttestableOpShape | undefined): string[] {
  const ops = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  if (!ops.length) throw opError('invalid_params', '--attest-ops needs at least one operation.', `Pass a comma-separated list, for example ${DEFAULT_ATTEST_OPS.join(',')}.`);
  const deferred = ops.filter(op => ACTOR_DEFERRED_OPS.has(op));
  if (deferred.length) {
    throw opError('invalid_params', `--attest-ops names ${deferred.join(', ')}, which an attested actor cannot run yet: what they read or write is not yet kept to the person.`,
      `Leave ${deferred.join(', ')} out. Not attestable yet: ${[...ACTOR_DEFERRED_OPS].join(', ')}.`,
      { why: 'An attested call must never return or record one person\'s memory where another person reads it.' });
  }
  const refused = ops.filter(op => !/^[a-z][a-z0-9_]{0,63}$/.test(op) || !attestableOp(op, lookup(op)));
  if (refused.length) {
    throw opError('invalid_params', `--attest-ops names ${refused.join(', ')}, which an attested actor can never run.`,
      `Name read, write or agent operations (gbrain --tools-json lists them) or the memory pair ${DEFAULT_ATTEST_OPS.join(',')}; admin, membership and local-only operations are never attestable.`,
      { why: 'An attested call runs as a person the trusted system names; it never carries operator authority.' });
  }
  return ops.sort();
}

function credentialArgv(caller: ActorCaller): string[] {
  const principal = caller.auth?.principal ?? caller.principal;
  if (principal?.kind === 'oauth_client') return ['--client', principal.id];
  return caller.auth?.clientName ? ['--token', caller.auth.clientName] : ['--id', principal?.id ?? '<token id>'];
}

const transportOf = (transport?: string) => ({ remote: true, transport: transport === 'stdio' ? 'stdio' as const : 'http' as const });

/** actor_not_attested with its reason, remedy and (where the operator can fix it) the rescope command. */
export function actorNotAttested(reason: ActorReason, caller: ActorCaller, ctx: { op: string; transport?: string; right?: AttestRight | null; reissue?: boolean; memberBound?: boolean }): OperationError {
  const docs = ERROR_CATALOGUE.actor_not_attested.docs;
  const rescope = (extra: string[]) => ['gbrain', 'auth', 'rescope', ...credentialArgv(caller), ...extra];
  const hostOnly = (message: string, argv: string[], why: string, suggestion: string) =>
    Object.assign(hostOnlyError(transportOf(ctx.transport), 'actor_not_attested', message, argv, why, { reason, suggestion }), { docs });
  switch (reason) {
    case 'no_attest_right':
      if (ctx.reissue) {
        return opError('actor_not_attested', `This client holds the attest right, but this access token was not issued by the client-credentials grant since the upgrade, so it may not name the person it acts for (${ACTOR_HEADER}). Nothing was read or written.`,
          'Request a new token with grant_type=client_credentials (POST /token) and retry with it. Tokens issued before the upgrade, or by another grant, never attest.', { reason, docs });
      }
      return hostOnly(`This connection may not name the person it acts for (${ACTOR_HEADER}), so nothing was read or written.`, rescope(['--attest-actor', 'qm']),
        'Grants this client-credentials client (or member-less legacy token) the right to name the person a QM call serves. Trusting a system to name people is the brain operator\'s decision.',
        'Only a credential the brain operator granted the attest right may send the actor header. Call without it, or ask the operator to run the command in fix.');
    case 'op_not_attested':
      if (ACTOR_DEFERRED_OPS.has(ctx.op)) {
        return opError('actor_not_attested', `${ctx.op} cannot run as an attested person yet: what it reads or writes is not yet kept to the person. Nothing was read or written.`,
          `Call it without ${ACTOR_HEADER}, or use an attestable operation. Not attestable yet: ${[...ACTOR_DEFERRED_OPS].join(', ')}.`, { reason, docs });
      }
      return hostOnly(`${ctx.op} is not in this connection's attested operations, so nothing was read or written.`,
        rescope(['--attest-actor', 'qm', '--attest-ops', [...new Set([...(ctx.right?.ops ?? DEFAULT_ATTEST_OPS), ctx.op])].sort().join(',')]),
        'Lets an attested call run this operation as the person it names. Widening what a trusted system may do as a person is the brain operator\'s decision.',
        `An attested call runs only the operations the operator listed (default ${DEFAULT_ATTEST_OPS.join(', ')}); admin and membership operations never.`);
    case 'argument_mismatch':
      if (ctx.memberBound) {
        return opError('actor_not_attested', `The ${ACTOR_ARGUMENT} argument names someone other than this credential's member, so nothing was read or written.`,
          `Leave ${ACTOR_ARGUMENT} out, or send this credential's own member id or a canonical id linked to it. A credential bound to a member reads only as that member; text in a conversation never chooses whose notes are read.`, { reason, docs });
      }
      return opError('actor_not_attested', `The ${ACTOR_ARGUMENT} argument names someone other than the ${ACTOR_HEADER} header, so nothing was read or written.`,
        `The header decides whom the call serves; send ${ACTOR_ARGUMENT} equal to it, or leave it out. Text in a conversation never chooses whose notes are read.`, { reason, docs });
    case 'argument_without_attestation':
      return opError('actor_not_attested', `The ${ACTOR_ARGUMENT} argument is accepted only on an attested call, so nothing was read or written.`,
        `Remove ${ACTOR_ARGUMENT} from the arguments. A trusted system names the person in the ${ACTOR_HEADER} header from a credential holding the attest right (gbrain auth rescope ... --attest-actor qm on the brain host).`, { reason, docs });
    case 'actor_required':
      return opError('actor_not_attested', `${ctx.op} writes only as an attested person, and this call names none (no ${ACTOR_HEADER} header on a credential holding the attest right), so nothing was written.`,
        `Send ${ACTOR_HEADER} with the person's canonical id from a credential the brain operator granted the attest right (gbrain auth rescope --client <id> --attest-actor qm). To save a fact as yourself, call remember.`, { reason, docs });
    case 'audience_not_supported':
      return opError('actor_not_attested', `This request carries ${QM_AUDIENCE_HEADER} (a channel audience), which this brain does not serve yet, so nothing was read or written.`,
        `Send the call without ${QM_AUDIENCE_HEADER}. Channel turns are refused until wave 2; a call for one person sends ${ACTOR_HEADER} alone.`, { reason, docs });
    case 'invalid_actor_id':
      return opError('actor_not_attested', `The ${ACTOR_HEADER} header or the ${ACTOR_ARGUMENT} argument is not a canonical person id (1-256 visible ASCII characters), so nothing was read or written.`,
        'Fix the harness code that sets the header: send the canonical id unchanged, with no spaces or control characters.', { reason, docs });
  }
}

/** actor_unlinked: the operator links the id to a member. dispatch's actorRefusal is the one place a recall tool may turn it into an empty result. */
export function actorUnlinked(externalId: string, transport?: string): OperationError {
  return Object.assign(hostOnlyError(transportOf(transport), 'actor_unlinked',
    'The person this call names is not linked to an enabled member of this brain, so nothing was read or written.',
    ['gbrain', 'access', 'member', 'link', '<member>', '--qm', externalId],
    'Links the canonical id to the member it belongs to; an unlinked id, or one linked to a disabled member, reads nothing. Who a person is on this brain is the operator\'s decision.',
    { suggestion: 'Ask the brain operator to link this person to their member (gbrain access member link <member> --qm <id>), or to enable the member if it is disabled.' }),
  { docs: ERROR_CATALOGUE.actor_unlinked.docs });
}

/** The enabled member linked to (system, external_id), with its identity; null when unlinked, disabled or the link tables are missing. */
export async function linkedMember(engine: Pick<BrainEngine, 'executeRaw'>, system: string, externalId: string): Promise<{ member: string; groups: string[]; identity: string[] } | null> {
  try {
    const [row] = await engine.executeRaw<{ id: string; groups: string[] | null }>(
      `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
       FROM access_member_links l JOIN access_members m ON m.id = l.member_id LEFT JOIN access_group_members g ON g.member_id = m.id
       WHERE l.system = $1 AND l.external_id = $2 AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL GROUP BY m.id`, [system, externalId]);
    if (!row) return null;
    const groups = row.groups ?? [];
    return { member: row.id, groups, identity: identityFor(row.id, groups) };
  } catch (e) {
    // GST-359 D: only a schema before the link tables reads as unlinked. A database failure (an aborted transaction under
    // a concurrent publication, a lock timeout) is rethrown, so a stored write retries instead of failing as actor_unlinked.
    if (!isUndefinedTableError(e)) throw e;
    return null;
  }
}

/**
 * The one coverage test for an attested actor, used by dispatch, write publication and job tool calls: the caller's
 * live attest right for the system, and a live link from the id to an enabled member. Returns that member's identity;
 * throws actor_not_attested (no_attest_right) or actor_unlinked.
 */
export async function actorCoverage(engine: Pick<BrainEngine, 'executeRaw'>, caller: ActorCaller, actor: { system: string; external_id: string }, transport?: string, op?: string):
  Promise<{ member: string; groups: string[]; identity: string[] }> {
  const right = await attestRightOf(engine, caller);
  if (!right || right.system !== actor.system) throw actorNotAttested('no_attest_right', caller, { op: op ?? 'stored', transport });
  if (op !== undefined && (!right.ops.includes(op) || ACTOR_DEFERRED_OPS.has(op))) throw actorNotAttested('op_not_attested', caller, { op, transport, right });
  const linked = EXTERNAL_ID_RE.test(actor.external_id) ? await linkedMember(engine, actor.system, actor.external_id) : null;
  if (!linked) throw actorUnlinked(actor.external_id, transport);
  return linked;
}

/**
 * A stored attested authority (a queued write, an agent job) re-resolved through actorCoverage: the same member must
 * still be covered and, when `op` is given (publication, a job tool call), the operation must still be attested.
 */
export async function storedActorIdentity(engine: Pick<BrainEngine, 'executeRaw'>, principal: Principal, actor: AttestedActor, op?: string): Promise<string[]> {
  const covered = await actorCoverage(engine, { principal }, actor, undefined, op);
  if (covered.member !== actor.member) throw actorUnlinked(actor.external_id);
  return covered.identity;
}

/**
 * The caller-access record of an attested call: a one-member audience of the linked member with privacy never relaxed
 * (no granted_sources, no operator hatch), whatever the attest credential's own grants say. An explicit mode, not B's
 * may_act_for path, which relaxes privacy for a one-member audience.
 */
export async function attestedCallerAccess(engine: Pick<BrainEngine, 'executeRaw'>, actor: AttestedActor, identity: string[]): Promise<Partial<CallerAccess>> {
  return {
    identity,
    audience: [`member:${actor.member}`],
    audienceIdentities: [],
    actor: { ...actor },
    ...await folderAccessFor(engine, identity),
    privateReadableSources: [],
    hidePrivate: true,
    applyRemoteReadPolicy: false,
    restricted: true,
  };
}

/** The actor channel a transport read from the request: the header value, undefined when absent. Never tool arguments. */
/** The headers the HTTP transport read: x-qm-actor, and x-qm-audience (refused on every call while it is not served). */
export interface ActorChannels { header?: string | null; audience?: string | null }

/**
 * The attested-actor decision for one remote call, made before any work. Null when the call names no actor (no header,
 * no argument): the caller's own identity or B's audience applies. Otherwise the access record and the arguments with
 * `acting_user` stripped, or a refusal: actor_not_attested with its reason, actor_unlinked, or B's
 * on_behalf_of_invalid_audience when an on_behalf_of audience is asserted too.
 */
export async function resolveAttestedActor(engine: Pick<BrainEngine, 'executeRaw'>, input: {
  channels?: ActorChannels; params: Record<string, unknown> | undefined; op: string; opShape: AttestableOpShape | undefined;
  auth?: ActorCaller['auth']; transport?: string; audienceAsserted: boolean;
}): Promise<{ actor?: AttestedActor; access?: Partial<CallerAccess>; params: Record<string, unknown> } | null> {
  const header = input.channels?.header ?? undefined;
  const hasArgument = !!input.params && Object.prototype.hasOwnProperty.call(input.params, ACTOR_ARGUMENT);
  const caller: ActorCaller = { auth: input.auth };
  if (input.channels?.audience != null) throw actorNotAttested('audience_not_supported', caller, { op: input.op, transport: input.transport });
  if (header === undefined && !hasArgument) return null;
  const ctx = { op: input.op, transport: input.transport };
  const argument = hasArgument ? input.params![ACTOR_ARGUMENT] : undefined;
  if ((header !== undefined && !EXTERNAL_ID_RE.test(header)) || (hasArgument && (typeof argument !== 'string' || !EXTERNAL_ID_RE.test(argument)))) {
    throw actorNotAttested('invalid_actor_id', caller, ctx);
  }
  if (header === undefined) return ownMemberArgument(engine, input, argument as string, caller, ctx);
  if (input.audienceAsserted) {
    throw catalogueError('on_behalf_of_invalid_audience', `The call names its person twice (${ACTOR_HEADER} and an on_behalf_of audience). Nothing was read.`,
      `Send one: ${ACTOR_HEADER} from an attest credential, or X-Gbrain-On-Behalf-Of / request-level _meta.on_behalf_of from a shared agent.`);
  }
  const right = input.transport === 'stdio' ? null : await attestRightOf(engine, caller);
  if (!right || right.system !== 'qm') {
    const principal = input.auth?.principal;
    const reissue = !hasArgument && !right && principal?.kind === 'oauth_client' && !!await attestRightOf(engine, { principal });
    throw actorNotAttested(hasArgument ? 'argument_without_attestation' : 'no_attest_right', caller, { ...ctx, reissue });
  }
  if (!right.ops.includes(input.op) || !attestableOp(input.op, input.opShape)) throw actorNotAttested('op_not_attested', caller, { ...ctx, right });
  if (hasArgument && argument !== header) throw actorNotAttested('argument_mismatch', caller, ctx);
  const covered = await actorCoverage(engine, caller, { system: right.system, external_id: header }, input.transport);
  const actor: AttestedActor = { system: right.system, external_id: header, member: covered.member };
  const { [ACTOR_ARGUMENT]: _stripped, ...params } = input.params ?? {};
  return { actor, access: await attestedCallerAccess(engine, actor, covered.identity), params };
}

/**
 * HARN-1: acting_user with no header, on a credential bound to a member (no stdio, no on_behalf_of audience). The
 * member id, or a canonical id linked to it, is stripped and the call runs exactly as the credential; any other value
 * is argument_mismatch, so the argument never widens or switches whose notes are read, and never tells an existing id
 * from an unknown one. Every other caller is refused argument_without_attestation as before.
 */
async function ownMemberArgument(engine: Pick<BrainEngine, 'executeRaw'>, input: { params?: Record<string, unknown>; auth?: ActorCaller['auth']; transport?: string; audienceAsserted: boolean },
  argument: string, caller: ActorCaller, ctx: { op: string; transport?: string }): Promise<{ params: Record<string, unknown> }> {
  const own = input.transport === 'stdio' || input.audienceAsserted || !input.auth ? null
    : (await memberIdentityFor(engine, input.auth)).find(p => p.startsWith('member:'))?.slice('member:'.length) ?? null;
  if (!own) throw actorNotAttested('argument_without_attestation', caller, ctx);
  if (argument !== own && (await linkedMember(engine, 'qm', argument))?.member !== own) throw actorNotAttested('argument_mismatch', caller, { ...ctx, memberBound: true });
  const { [ACTOR_ARGUMENT]: _stripped, ...params } = input.params ?? {};
  return { params };
}

export interface MemberLink { system: string; external_id: string; member_id: string; created_at: string | null }

function linkInvalid(message: string, reason: string, suggestion: string): OperationError {
  return opError('access_member_invalid', message, suggestion, { reason, why: 'A link decides whose notes a trusted system reads for a person, so it is matched exactly and never guessed.' });
}

function assertExternalId(raw: unknown): string {
  if (typeof raw === 'string' && EXTERNAL_ID_RE.test(raw)) return raw;
  throw linkInvalid('The --qm id is not a canonical person id.', 'invalid_external_id',
    'Pass the id exactly as QM sends it in x-qm-actor: 1-256 visible ASCII characters, no spaces (for example U0ALICE or oidc:3f2a:alice-example).');
}

const iso = (v: unknown) => v == null ? null : v instanceof Date ? v.toISOString() : String(v);
const toLink = (r: Record<string, unknown>): MemberLink => ({ system: String(r.system), external_id: String(r.external_id), member_id: String(r.member_id), created_at: iso(r.created_at) });

async function linkRow(engine: Pick<BrainEngine, 'executeRaw'>, system: string, externalId: string): Promise<MemberLink | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT system, external_id, member_id, created_at FROM access_member_links WHERE system = $1 AND external_id = $2', [system, externalId]);
  return row ? toLink(row) : null;
}

/** Links a canonical id to an enabled member; refuses an invalid id, a member that is not enabled and an id already linked. */
export async function linkMember(engine: BrainEngine, rawMember: unknown, system: string, rawId: unknown, opts: { dryRun?: boolean } = {}): Promise<{ link: MemberLink; applied: boolean }> {
  const externalId = assertExternalId(rawId);
  const { member } = await memberIdentity(engine, rawMember);
  const existing = await linkRow(engine, system, externalId);
  if (existing) {
    throw linkInvalid(`That ${system} id is already linked to member "${existing.member_id}".`, 'link_exists',
      existing.member_id === member ? 'Nothing to do: the link exists.' : `Unlink it first (gbrain access member unlink --${system} <id>), then link it to ${member}.`);
  }
  if (opts.dryRun) return { link: { system, external_id: externalId, member_id: member, created_at: null }, applied: false };
  await engine.executeRaw('INSERT INTO access_member_links (system, external_id, member_id) VALUES ($1, $2, $3)', [system, externalId, member]);
  return { link: (await linkRow(engine, system, externalId))!, applied: true };
}

/** Removes one link; the next attested call naming the id is refused (actor_unlinked). */
export async function unlinkMember(engine: BrainEngine, system: string, rawId: unknown, opts: { dryRun?: boolean } = {}): Promise<{ link: MemberLink; applied: boolean }> {
  const externalId = assertExternalId(rawId);
  const existing = await linkRow(engine, system, externalId);
  if (!existing) throw linkInvalid(`That ${system} id is not linked to any member.`, 'unknown_link', 'List the links with gbrain access member links.');
  if (!opts.dryRun) await engine.executeRaw('DELETE FROM access_member_links WHERE system = $1 AND external_id = $2', [system, externalId]);
  return { link: existing, applied: !opts.dryRun };
}

export async function listMemberLinks(engine: BrainEngine, opts: { member?: string } = {}): Promise<MemberLink[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT system, external_id, member_id, created_at FROM access_member_links${opts.member ? ' WHERE member_id = $1' : ''} ORDER BY member_id, system, external_id`,
    opts.member ? [opts.member] : []);
  return rows.map(toLink);
}
