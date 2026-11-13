/**
 * GST-363: on a brain that serves several people (two or more enabled members, or config access.serves = several;
 * ServesPolicy), a remote read must say whom it reads for. A connection does when it is bound to a member (the owner
 * included), when a shared agent names its audience on the call (may_act_for), or when a trusted system attests the
 * person (exempt in dispatch); the brain operator may also let one credential read unscoped on purpose
 * (reads_unscoped). Every other remote read is refused with requester_scope_required before any work.
 *
 * Deny by default: every operation not marked mutating: true, and every read-scope one (think), is covered except the
 * short list below, which reads no
 * page (the caller's own identity and the brain's health) or, for a token fenced to its own jobs, only its own jobs.
 * test/requester-scope.test.ts fails when a new read operation is neither refused nor listed here.
 *
 * Grace: a connection that existed when the brain started serving several people (config access.serves_since, set
 * once by the v309 trigger, or the upgrade that added it) keeps reading for 14 days with an in-band notice
 * (_meta.access.requester_scope); a stdio server and a credential with no creation time count as such. A credential
 * created after that point is refused at once. Hosted brains set access.requester_scope_enforce = false until their
 * control plane binds each connection to a member: every unscoped read then carries the notice and nothing is refused.
 * Writes are out of scope. Everything is database state, so a repo-less or keyless brain behaves the same.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type AuthInfo, type Operation, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { agentBlock } from '../agent-markers.ts';
import { readServesPolicy, type CallerAccess, type ServesPolicy } from '../search/private-visibility.ts';
import type { BindingPatch } from './members.ts';
import { hostFix, hostOnlyError } from '../ops/op-fix.ts';
import { hasScope } from '../scope.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { credentialScopeFields } from './token-binding.ts';
import { stdioBindRoute } from './stdio-bind-route.ts';
import { classifyPgAccessError } from '../pg-access-classify.ts';

/**
 * Read operations that read no page: the caller's own identity, the brain's identity and health, search mode names,
 * and the read-scope operations that only manage the caller's own shared-skills enrollment and tool catalog.
 */
export const REQUESTER_SCOPE_EXEMPT: ReadonlySet<string> = new Set(['whoami', 'get_brain_identity', 'get_status_snapshot', 'search_modes', 'get_health',
  'join_brain', 'leave_brain', 'sync_brain_skills', 'request_tools']);
/** Exempt only for a credential without admin scope, which sees only the jobs it owns (ops/jobs.ts agentOwnerFence). */
export const OWN_JOB_OPS: ReadonlySet<string> = new Set(['get_job', 'wait_job']);
export const REQUESTER_SCOPE_GRACE_DAYS = 14;
const GRACE_SECONDS = REQUESTER_SCOPE_GRACE_DAYS * 24 * 3600;
/** Whether `op` needs a scoped requester on a brain that serves several people. */
export function requiresRequesterScope(op: Pick<Operation, 'name' | 'mutating' | 'scope'> | undefined, auth?: Pick<AuthInfo, 'scopes'>): boolean {
  if (!op || (op.mutating === true && (op.scope ?? 'read') !== 'read') || REQUESTER_SCOPE_EXEMPT.has(op.name)) return false;
  return !(OWN_JOB_OPS.has(op.name) && auth && !hasScope(auth.scopes ?? [], 'admin'));
}

/** The in-band notice an unscoped read carries while it is still answered. */
export interface RequesterScopeNotice {
  state: 'grace' | 'not_enforced';
  connection: string;
  refuses_at: string | null;
  message: string;
  fix: Action;
}

type ScopeAuth = Pick<AuthInfo, 'clientName' | 'readsUnscoped' | 'createdAt' | 'scopes'> & { principal?: { kind: string; id: string } };

type Inputs = NonNullable<Action['inputs']>;

const MEMBER_INPUTS: Inputs = [{ name: 'MEMBER', how: 'The member this connection serves; gbrain access member list on the brain host names them. Ask the user which person it is.' }];

interface Connection { handle: string; argv: string[]; inputs: Inputs; check?: string[]; optOut?: string[]; route?: string }

function connectionOf(auth: Pick<ScopeAuth, 'clientName' | 'principal'> | undefined): Connection {
  const principal = auth?.principal;
  if (principal?.kind === 'legacy_token') {
    const target = auth?.clientName ? ['--token', auth.clientName] : ['--id', principal.id];
    return { handle: `token ${auth?.clientName ?? principal.id}`, argv: ['gbrain', 'auth', 'rescope', ...target, '--member', '<MEMBER>'], inputs: MEMBER_INPUTS,
      check: ['gbrain', 'access', 'check', ...target], optOut: ['gbrain', 'auth', 'rescope', ...target, '--reads-unscoped', '--yes'] };
  }
  if (principal?.kind === 'oauth_client') {
    return { handle: `OAuth client ${principal.id}`, argv: ['gbrain', 'auth', 'rescope', '--client', principal.id, '--member', '<MEMBER>'], inputs: MEMBER_INPUTS,
      check: ['gbrain', 'access', 'check', '--client', principal.id], optOut: ['gbrain', 'auth', 'rescope', '--client', principal.id, '--reads-unscoped', '--yes'] };
  }
  const route = stdioBindRoute();
  return { handle: 'this stdio server', argv: route.argv, inputs: [...route.inputs, ...MEMBER_INPUTS], route: route.text };
}

type Transport = 'stdio' | 'http' | undefined;

function why(policy: ServesPolicy): string {
  return policy?.from === 'config' ? 'config access.serves is several' : 'it has two or more enabled members';
}

function alternatives(c: Connection): string {
  if (!c.optOut) return `On the brain host (gbrain access member list names the members): ${c.route}`;
  return `On the brain host, see what the connection reads with ${c.check!.join(' ')}, then bind it to the person it serves: ${c.argv.join(' ')} (gbrain access member list names the members). `
    + `A shared agent instead lists whom it may act for (--may-act-for <members>) and names the person on each call (X-Gbrain-On-Behalf-Of). `
    + `Last resort, for a team that shares everything: ${c.optOut.join(' ')} lets it read every page no rule restricts for whoever is asking.`;
}

function fixFor(c: Connection, transport: Transport): Action {
  return { ...hostFix({ remote: true, transport }, c.argv, 'Binds this connection to one member, so it reads only what that person may read.'),
    inputs: c.inputs,
    ...(c.check ? { verify: { argv: c.check } } : {}) };
}

/**
 * The requester-scope decision for one remote read, after access resolved: null when it runs as before, a notice when
 * it runs with one (grace, or enforcement off), and a thrown requester_scope_required otherwise. Attested calls never
 * reach it. `auth` carries readsUnscoped and createdAt from the verifier (credentialScopeFor fills them otherwise).
 */
export function requesterScopeGate(op: Pick<Operation, 'name' | 'mutating'> | undefined, access: Partial<CallerAccess>, auth: ScopeAuth | undefined,
  via: string | undefined, nowMs = Date.now()): RequesterScopeNotice | null {
  if (!requiresRequesterScope(op, auth)) return null;
  const serves = access.remotePolicy?.serves;
  const unknown = access.remotePolicy?.servesUnknown === true;
  if (!serves?.several && !unknown) return null;
  const transport: Transport = via === 'http' ? 'http' : 'stdio';
  if (boundToSomeone(access)) return null;
  if (auth?.readsUnscoped) return null;
  const c = connectionOf(auth);
  if (unknown || !serves) throw requesterScopeUnknown(op!.name, c);
  const created = auth?.createdAt ?? null;
  const since = serves.since;
  const refusesAt = since === null ? null : since + GRACE_SECONDS;
  const now = Math.floor(nowMs / 1000);
  if (!serves.enforce) {
    return { state: 'not_enforced', connection: c.handle, refuses_at: null, fix: fixFor(c, transport),
      message: `This brain serves several people (${why(serves)}) and ${c.handle} is bound to nobody, so it reads every page no rule restricts for whoever is asking. ${alternatives(c)}` };
  }
  const old = since !== null && (created === null || created < since);
  if (old && refusesAt !== null && now < refusesAt) {
    const date = new Date(refusesAt * 1000).toISOString();
    return { state: 'grace', connection: c.handle, refuses_at: date, fix: fixFor(c, transport),
      message: `This brain serves several people (${why(serves)}) and ${c.handle} is bound to nobody. From ${date} its reads are refused (requester_scope_required). ${alternatives(c)}` };
  }
  throw requesterScopeRequired(op!.name, c, serves, transport, old ? 'grace_ended' : since === null ? 'since_unknown' : 'created_after');
}

/** Whether requesterScopeGate would refuse a read from this connection, for the ops it does not gate. */
export function requesterScopeRefuses(access: Partial<CallerAccess>, auth: ScopeAuth | undefined, via: string | undefined): boolean {
  try {
    requesterScopeGate({ name: 'search', mutating: false }, access, auth, via);
    return false;
  } catch (e) {
    if (/^requester_scope_(required|unknown)$/.test(String((e as { code?: unknown }).code))) return true;
    throw e;
  }
}

function boundToSomeone(access: Partial<CallerAccess>): boolean {
  return !!access.audience?.length || !!access.actor || (access.identity ?? []).some(p => p.startsWith('member:'));
}

/**
 * The access a requester-scope decision reads: unchanged unless whom the brain serves could not be read (servesUnknown)
 * and the call is from a connection bound to nobody, which gets one targeted re-read of the serves keys. A second
 * failure leaves it unknown, and requesterScopeGate refuses (requester_scope_unknown) rather than read it as one person.
 * A second failure the database-error envelope already names (the database unreachable, the schema missing) is
 * rethrown to it instead; a dropped connection or a timeout stays requester_scope_unknown, since the next read succeeds.
 */
export async function withServesReread<T extends Partial<CallerAccess>>(engine: Pick<BrainEngine, 'executeRaw'>, access: T, auth: Pick<ScopeAuth, 'readsUnscoped'> | undefined): Promise<T> {
  const policy = access.remotePolicy;
  if (!policy?.servesUnknown || boundToSomeone(access) || auth?.readsUnscoped) return access;
  try {
    return { ...access, remotePolicy: { ...policy, serves: await readServesPolicy(engine), servesUnknown: false } };
  } catch (e) {
    const reason = classifyPgAccessError(e).reason;
    if (reason !== 'unknown' && reason !== 'conn_dropped') throw e;
    return access;
  }
}

function requesterScopeUnknown(op: string, c: Connection): OperationError {
  return opError('requester_scope_unknown',
    `This brain's settings could not be read (whether it serves one person or several; the config read failed twice), so ${op} from ${c.handle}, which is bound to no member, was not answered and nothing was read. This is not an access decision: the same call can succeed once the database answers.`,
    'Retry the same call in a few seconds. If it keeps failing, the brain host\'s operator checks the database with gbrain doctor --json.',
    { retryable: true, detail: 'retry_after_ms=2000',
      fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'provider', requires_exclusive: false,
        why: 'Nothing was read. Repeat the same call after about 2 s (retry_after_ms=2000); this read-only command shows whether the database is answering.',
        verify: { argv: ['gbrain', 'access', 'serves', '--json'] } } });
}

function requesterScopeRequired(op: string, c: Connection, serves: ServesPolicy, transport: Transport, reason: string): OperationError {
  const e = hostOnlyError({ remote: true, transport }, 'requester_scope_required',
    `This brain serves several people (${why(serves)}) and ${c.handle} is bound to nobody, so ${op} was refused and nothing was read.`,
    c.argv, 'Binds this connection to one member, so it reads only what that person may read.',
    { suggestion: `The fix runs on the brain host. ${alternatives(c)}`, reason });
  e.fix = fixFor(c, transport);
  return e;
}

/**
 * readsUnscoped and createdAt for `auth`: the verifier's values when it set them (no query), else a live lookup from
 * the stored principal (an agent job's delegated credential). Unreadable or unknown: not opted out, creation unknown.
 */
export async function credentialScopeFor<T extends ScopeAuth>(engine: Pick<BrainEngine, 'executeRaw'>, auth: T): Promise<T> {
  if (auth.readsUnscoped !== undefined) return auth;
  const principal = auth.principal;
  try {
    if (principal?.kind === 'legacy_token') {
      const [row] = await engine.executeRaw<{ reads_unscoped: unknown; created_at: unknown }>('SELECT reads_unscoped, created_at FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL', [principal.id]);
      return { ...auth, ...credentialScopeFields(row?.reads_unscoped, row?.created_at) };
    }
    if (principal?.kind === 'oauth_client') {
      const [row] = await engine.executeRaw<{ reads_unscoped: unknown; client_id_issued_at: unknown }>('SELECT reads_unscoped, client_id_issued_at FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL', [principal.id]);
      return { ...auth, ...credentialScopeFields(row?.reads_unscoped, row?.client_id_issued_at) };
    }
  } catch { /* unreadable: not opted out, creation unknown */ }
  return { ...auth, readsUnscoped: false, createdAt: null };
}

/**
 * GST-363: creating a credential bound to nobody on a brain that serves several people is refused
 * (credential_scope_required): it names a member, a may_act_for audience, the attest right, or --reads-unscoped.
 * Off while enforcement is off (hosted), like the read refusal.
 */
export async function assertCredentialScoped(engine: Pick<BrainEngine, 'executeRaw'>, patch: BindingPatch | null, kind: 'token' | 'client', name: string): Promise<void> {
  if (patch?.member || patch?.mayActFor?.length || patch?.attestActor || patch?.readsUnscoped) return;
  const serves = await readServesPolicy(engine);
  if (!serves.several || !serves.enforce) return;
  const create = kind === 'token' ? ['gbrain', 'auth', 'create', name] : ['gbrain', 'auth', 'register-client', name];
  throw opError('credential_scope_required',
    `This brain serves several people (${why(serves)}), so the ${kind === 'token' ? 'token' : 'OAuth client'} ${name} was not created bound to nobody; nothing was created.`,
    `Bind it to the person it serves: ${create.join(' ')} --member followed by that member's id (gbrain access member list names the members). A shared agent passes --may-act-for <members>; --reads-unscoped --yes creates one that reads every page no rule restricts for any asker.`,
    { fix: { argv: [...create, '--member', '<MEMBER>'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Creates the credential bound to one member, so it reads only what that person may read.',
      inputs: [{ name: 'MEMBER', how: 'The member it serves; gbrain access member list names them. Ask the user which person it is.' }],
      verify: { argv: ['gbrain', 'access', 'member', 'list', '--json'] } } });
}

/**
 * whoami's view of the requester-scope gate for the calling connection (whoami itself is exempt, so an unbound
 * connection can learn why its reads are refused): not_required on a one-person brain, scoped, reads_unscoped, unknown
 * when whom the brain serves could not be read (even after one re-read), or the
 * state a read would get, with the command that binds the connection.
 */
export async function requesterScopeView(engine: Pick<BrainEngine, 'executeRaw'>, access: Partial<CallerAccess>, auth: ScopeAuth | undefined, transport: string | undefined): Promise<{ state: string; refuses_at?: string | null; reason?: string; argv?: string[] }> {
  const policy = access.remotePolicy;
  if (!policy?.serves?.several && !policy?.servesUnknown) return { state: 'not_required' };
  if (boundToSomeone(access)) return { state: 'scoped' };
  const scoped = auth ? await credentialScopeFor(engine, auth) : undefined;
  if (scoped?.readsUnscoped) return { state: 'reads_unscoped' };
  const resolved = await withServesReread(engine, access, scoped);
  if (!resolved.remotePolicy?.servesUnknown && !resolved.remotePolicy?.serves?.several) return { state: 'not_required' };
  try {
    const notice = requesterScopeGate({ name: 'search', mutating: false }, resolved, scoped, transport);
    return { state: notice!.state, refuses_at: notice!.refuses_at, argv: notice!.fix.argv };
  } catch (e) {
    const err = e as OperationError;
    if (err.code === 'requester_scope_unknown') return { state: 'unknown' };
    return { state: 'refused', reason: err.reason, argv: err.fix?.argv };
  }
}

/** One credential bound to nobody on a brain that serves several people, as doctor and post-upgrade list it. */
export interface UnscopedConnection {
  connection: string;
  /** grace: still reads until refuses_at; refused: every read is refused; not_enforced: hosted, reads with a notice; reads_unscoped: opted out on purpose. */
  state: 'grace' | 'refused' | 'not_enforced' | 'reads_unscoped';
  refuses_at: string | null;
  argv: string[];
}

/**
 * GST-363: whom the brain serves and every live credential bound to nobody (no member, no may_act_for audience, no
 * attest right), each with the state the requester-scope gate gives its reads and the one command that binds it.
 * Null when the brain serves one person.
 */
export async function unscopedConnections(engine: Pick<BrainEngine, 'executeRaw'>, nowMs = Date.now()): Promise<{ serves: ServesPolicy; connections: UnscopedConnection[] } | null> {
  const serves = await readServesPolicy(engine);
  if (!serves.several) return null;
  const unbound = 'member_id IS NULL AND COALESCE(cardinality(may_act_for), 0) = 0 AND attest_actor IS NULL';
  const [tokens, clients] = await Promise.all([
    engine.executeRaw<{ id: string; name: string; created: unknown; reads_unscoped: unknown }>(`SELECT id::text AS id, name, created_at AS created, reads_unscoped FROM access_tokens WHERE revoked_at IS NULL AND ${unbound} ORDER BY name, id`),
    engine.executeRaw<{ id: string; name: string; created: unknown; reads_unscoped: unknown }>(`SELECT client_id AS id, client_name AS name, client_id_issued_at AS created, reads_unscoped FROM oauth_clients WHERE deleted_at IS NULL AND ${unbound} ORDER BY client_id`),
  ]);
  const refusesAt = serves.since === null ? null : serves.since + GRACE_SECONDS;
  const now = Math.floor(nowMs / 1000);
  const entry = (c: Connection, row: { created: unknown; reads_unscoped: unknown }): UnscopedConnection => {
    const { readsUnscoped, createdAt } = credentialScopeFields(row.reads_unscoped, row.created);
    const old = serves.since !== null && (createdAt === null || createdAt < serves.since);
    const state = readsUnscoped ? 'reads_unscoped' : !serves.enforce ? 'not_enforced' : old && refusesAt !== null && now < refusesAt ? 'grace' : 'refused';
    return { connection: c.handle, state, refuses_at: state === 'grace' ? new Date(refusesAt! * 1000).toISOString() : null, argv: c.argv };
  };
  return { serves, connections: [
    ...tokens.map(t => entry(connectionOf({ principal: { kind: 'legacy_token', id: t.id }, clientName: t.name }), t)),
    ...clients.map(c => entry(connectionOf({ principal: { kind: 'oauth_client', id: c.id } }), c)),
  ] };
}

/** `gbrain post-upgrade`: each credential whose reads are (or will be) refused, with its one command. Best effort. */
export async function printUnscopedReadsUpgradeNotice(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  try {
    const found = await unscopedConnections(engine);
    const pending = found?.connections.filter(c => c.state !== 'reads_unscoped') ?? [];
    if (!found || !pending.length) return;
    console.log('');
    console.log(agentBlock({
      why: `This brain serves several people (${why(found.serves)}), and ${pending.length} connection(s) are bound to nobody. Their reads are refused (requester_scope_required) ${found.serves.enforce ? 'after the grace shown' : 'once access.requester_scope_enforce is on'}.`,
      actor: 'user',
      next: 'Relay the list below to the user. Each command runs on the brain host; MEMBER is the person the connection serves (gbrain access member list names them). A team that shares everything may mark one connection with --reads-unscoped --yes on gbrain auth rescope instead.',
      verify: 'gbrain doctor --only unscoped_shared_reads --json',
    }).trimEnd());
    for (const c of pending) console.log(`  ${c.connection}: ${c.state}${c.refuses_at ? ` until ${c.refuses_at}` : ''}. Fix: ${c.argv.join(' ')}`);
  } catch { /* cosmetic; never blocks the upgrade */ }
}

/** One change to a credential's reads_unscoped, as ~/.gbrain/audit/access-reads-unscoped-YYYY-Www.jsonl records it. */
export interface ReadsUnscopedAuditEvent { ts: string; credential: string; reads_unscoped: boolean; by: string }

const audit = createAuditWriter<ReadsUnscopedAuditEvent>({ featureName: 'access-reads-unscoped', errorLabel: 'access-reads-unscoped-audit', errorTrailer: '; continuing' });

export function logReadsUnscopedChange(event: Omit<ReadsUnscopedAuditEvent, 'ts'>): void {
  audit.log({ ts: new Date().toISOString(), ...event });
}

export function readReadsUnscopedChanges(): ReadsUnscopedAuditEvent[] {
  return audit.readRecent();
}
