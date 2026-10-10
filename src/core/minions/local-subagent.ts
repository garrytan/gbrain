/** Explicit CLI delegation. Wire descriptors are durable ceilings, never admission tokens. */
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { matchesSlugAllowList, normalizeSlugPrefix, slugUnderBoundPrefixes } from '../ops/context.ts';
import { verifiedLocalWriterFor, type LocalGrant } from '../persistence/identity.ts';
import type { SqlEngine, WriteAuthority } from '../persistence/model.ts';
import { BRAIN_TOOL_ALLOWLIST } from './tools/brain-tool-allowlist.ts';
import { authorityDigest } from './submission-authority.ts';

export interface LocalSubagentAuthority {
  version: 1; kind: 'local_subagent'; principal: { kind: 'local_cli'; id: string };
  brainId: string; parentRequestId: string; acceptedJobId?: number;
  grant: { sourceId: string; sourceIncarnation: string; parent: LocalGrant;
    allowedOperations: string[]; allowedSlugPrefixes: string[] };
  payloadHash: string;
}
export interface LocalSubagentReceipt extends LocalSubagentAuthority { acceptedJobId: number }
export interface LocalSubagentCapability { readonly kind: 'local_subagent_capability' }
const admissions = new WeakMap<object, { engine: BrainEngine; authority: LocalSubagentAuthority }>();
const executions = new WeakMap<object, { engine: BrainEngine; authority: LocalSubagentReceipt }>();
const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && !!s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function deny(message: string): never { throw opError('permission_denied', message, 'Submit new bounded work from the same active verified CLI registration.'); }
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
function grantValid(v: unknown): v is LocalGrant {
  return object(v) && strings(v.sourceIds) && strings(v.scopes) &&
    (v.operations === null || strings(v.operations)) && (v.slugPrefixes === null || strings(v.slugPrefixes));
}
export function parseLocalSubagent(value: unknown): LocalSubagentAuthority | null {
  if (!object(value) || value.version !== 1 || value.kind !== 'local_subagent' ||
      !object(value.principal) || value.principal.kind !== 'local_cli' || !uuid(value.principal.id) ||
      !uuid(value.brainId) || !uuid(value.parentRequestId) ||
      value.acceptedJobId !== undefined && (!Number.isSafeInteger(value.acceptedJobId) || Number(value.acceptedJobId) < 1) ||
      !object(value.grant) || typeof value.grant.sourceId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.grant.sourceId) ||
      !uuid(value.grant.sourceIncarnation) || !grantValid(value.grant.parent) ||
      !strings(value.grant.allowedOperations) || !value.grant.allowedOperations.length ||
      !value.grant.allowedOperations.every(op => BRAIN_TOOL_ALLOWLIST.has(op)) ||
      !strings(value.grant.allowedSlugPrefixes) || !value.grant.allowedSlugPrefixes.length ||
      !value.grant.allowedSlugPrefixes.every(p => /^[a-z0-9\/-]+(?:\/\*)?$/.test(p) && !p.endsWith('/')) ||
      typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash)) return null;
  return structuredClone(value) as unknown as LocalSubagentAuthority;
}
function containsBounds(parent: LocalGrant, a: LocalSubagentAuthority): boolean {
  return (parent.sourceIds.includes('*') || parent.sourceIds.includes(a.grant.sourceId)) &&
    parent.scopes.includes('read') && parent.scopes.includes('write') &&
    (parent.operations === null || a.grant.allowedOperations.every(op => parent.operations!.includes(op))) &&
    (parent.slugPrefixes === null || a.grant.allowedSlugPrefixes.every(prefix => {
      const requested = normalizeSlugPrefix(prefix);
      return parent.slugPrefixes!.some(p => { const base = normalizeSlugPrefix(p); return !!base &&
        (base.endsWith('/') ? requested.startsWith(base) : requested === base || requested.startsWith(`${base}/`)); });
    }));
}
/** Current parent and source checks also run inside publication's existing FOR SHARE locks. */
export async function assertLocalSubagentLive(engine: SqlEngine, a: LocalSubagentAuthority, lock = false): Promise<void> {
  const suffix = lock ? ' FOR SHARE' : '';
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(`SELECT incarnation,archived FROM sources WHERE id=$1${suffix}`, [a.grant.sourceId]);
  const [writer] = await engine.executeRaw<{ lane: string; revoked_at: unknown; grant_ceiling: unknown }>(
    `SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid${suffix}`, [a.principal.id]);
  if (brain?.brain_id !== a.brainId) deny('Local subagent engine binding changed.');
  if (!source || source.archived || source.incarnation !== a.grant.sourceIncarnation) deny('Local subagent source incarnation changed.');
  if (!writer || writer.lane !== 'cli' || writer.revoked_at != null) deny('Local CLI parent registration is revoked or changed.');
  if (!grantValid(writer.grant_ceiling) || !containsBounds(a.grant.parent, a) || !containsBounds(writer.grant_ceiling, a)) deny('Current local CLI grant was narrowed below the accepted subagent bounds.');
}
function payloadMatches(a: LocalSubagentAuthority, name: string, data: Record<string, unknown>): boolean {
  return name === 'subagent' && authorityDigest({ name, data }) === a.payloadHash && data.source_id === a.grant.sourceId &&
    authorityDigest(data.allowed_tools) === authorityDigest(a.grant.allowedOperations) &&
    authorityDigest(data.allowed_slug_prefixes) === authorityDigest(a.grant.allowedSlugPrefixes) && data.brain_id === undefined;
}
export async function prepareLocalSubagent(ctx: OperationContext, parentRequestId: string, name: string, data: Record<string, unknown>,
  allowedOperations: readonly string[], allowedSlugPrefixes: readonly string[]) {
  const writer = verifiedLocalWriterFor(ctx.engine);
  if (ctx.remote !== false || !writer || writer.remote || writer.principal.kind !== 'local_cli' || !uuid(parentRequestId) ||
      ctx.auth && (ctx.auth.principal || ctx.auth.clientId !== writer.principal.id || ctx.auth.sourceId !== ctx.sourceId ||
        ctx.auth.fenceProjectionDegraded || ctx.auth.grantProjectionDegraded || !ctx.auth.scopes.includes('read') || !ctx.auth.scopes.includes('write'))) {
    deny('Local subagent authority requires a verified local CLI identity and matching authenticated context.');
  }
  const [brain] = await ctx.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [ctx.sourceId]);
  const parent = structuredClone(writer.grant);
  // AuthInfo can narrow the verifier ceiling, never widen it.
  if (ctx.auth?.allowedOperations) parent.operations = parent.operations === null ? [...ctx.auth.allowedOperations]
    : parent.operations.filter(op => ctx.auth!.allowedOperations!.includes(op));
  if (ctx.auth?.boundSlugPrefixes) parent.slugPrefixes = [...ctx.auth.boundSlugPrefixes];
  const a: LocalSubagentAuthority = { version: 1, kind: 'local_subagent', principal: { kind: 'local_cli', id: writer.principal.id },
    brainId: brain?.brain_id, parentRequestId, grant: { sourceId: ctx.sourceId!, sourceIncarnation: source?.incarnation, parent,
      allowedOperations: [...allowedOperations], allowedSlugPrefixes: [...allowedSlugPrefixes] },
    payloadHash: authorityDigest({ name, data }) };
  if (!parseLocalSubagent(a) || !payloadMatches(a, name, data) || !containsBounds(writer.grant, a)) deny('Local subagent payload or bounds exceed the verified CLI grant.');
  await assertLocalSubagentLive(ctx.engine, a);
  const token = freeze({ submissionAuthority: freeze(structuredClone(a)), allowProtectedSubmit: true });
  admissions.set(token, { engine: ctx.engine, authority: freeze(structuredClone(a)) });
  return token;
}
/** Read the private immutable snapshot, not mutable fields on a public branded object. */
export function localSubagentAdmission(engine: BrainEngine, token: unknown): LocalSubagentAuthority | undefined {
  const accepted = object(token) ? admissions.get(token) : undefined;
  if (accepted && accepted.engine !== engine) deny('Local subagent admission is bound to another engine.');
  return accepted ? structuredClone(accepted.authority) : undefined;
}
export async function assertLocalSubagentExecution(engine: BrainEngine, a: LocalSubagentAuthority, name: string,
  data: Record<string, unknown>, jobId?: number): Promise<void> {
  if (!payloadMatches(a, name, data)) deny('Local subagent payload changed after admission.');
  if (jobId !== undefined) {
    if (a.acceptedJobId !== jobId) deny('Local subagent accepted job binding changed.');
    const [row] = await engine.executeRaw<{ name: string; data: Record<string, unknown>; submission_authority: unknown }>('SELECT name,data,submission_authority FROM minion_jobs WHERE id=$1', [jobId]);
    if (!row || row.name !== name || authorityDigest(row.data) !== authorityDigest(data) ||
        authorityDigest(row.submission_authority) !== authorityDigest(a)) deny('Local subagent stored job integrity changed.');
  } else if (a.acceptedJobId !== undefined) deny('Local subagent execution requires its accepted job.');
  await assertLocalSubagentLive(engine, a);
}
/** Rebuild an engine/job-bound capability from server-accepted durable work, including after restart. */
export async function localSubagentTools(engine: BrainEngine, jobId: number, data: Record<string, unknown>): Promise<LocalSubagentCapability | undefined> {
  const [row] = await engine.executeRaw<{ name: string; status: string; submission_authority: unknown }>('SELECT name,status,submission_authority FROM minion_jobs WHERE id=$1', [jobId]);
  if (!row || !object(row.submission_authority) || row.submission_authority.kind !== 'local_subagent') return undefined;
  const a = parseLocalSubagent(row.submission_authority);
  if (!a || row.status !== 'active' || a.acceptedJobId !== jobId) deny('Local subagent tools require the accepted executing job.');
  await assertLocalSubagentExecution(engine, a, row.name, data, jobId);
  const token: LocalSubagentCapability = Object.freeze({ kind: 'local_subagent_capability' });
  executions.set(token, { engine, authority: freeze(a as LocalSubagentReceipt) });
  return token;
}
export function localSubagentReadAuth(engine: BrainEngine, token: LocalSubagentCapability) {
  const accepted = executions.get(token);
  if (!accepted || accepted.engine !== engine) deny('Local subagent read capability binding changed.');
  const a = accepted.authority;
  return { token: '', clientId: a.principal.id, scopes: [...a.grant.parent.scopes], sourceId: a.grant.sourceId,
    allowedSources: [a.grant.sourceId], allowedOperations: [...a.grant.allowedOperations] };
}
export function localSubagentPrincipal(ctx: OperationContext) {
  if (!ctx.localSubagent) return undefined;
  const accepted = executions.get(ctx.localSubagent);
  if (!accepted || accepted.engine !== ctx.engine || accepted.authority.acceptedJobId !== ctx.jobId || ctx.subagentId !== ctx.jobId ||
      !ctx.viaSubagent || ctx.remote !== true || ctx.auth && (ctx.auth.principal || ctx.auth.clientId !== accepted.authority.principal.id || ctx.auth.sourceId !== accepted.authority.grant.sourceId) || ctx.sourceId !== accepted.authority.grant.sourceId) deny('Local subagent tool capability binding changed.');
  return { ...accepted.authority.principal };
}
export async function localSubagentWrite(ctx: OperationContext, operation: string, sourceId: string, sourceIncarnation: string): Promise<LocalSubagentReceipt> {
  localSubagentPrincipal(ctx);
  const accepted = executions.get(ctx.localSubagent!);
  if (!accepted || sourceId !== accepted.authority.grant.sourceId || sourceIncarnation !== accepted.authority.grant.sourceIncarnation ||
      !accepted.authority.grant.allowedOperations.includes(operation) || authorityDigest(ctx.allowedSlugPrefixes) !== authorityDigest(accepted.authority.grant.allowedSlugPrefixes)) deny('Local subagent tool exceeds its accepted bounds.');
  const [row] = await ctx.engine.executeRaw<{ name: string; status: string; data: Record<string, unknown> }>('SELECT name,status,data FROM minion_jobs WHERE id=$1', [ctx.jobId]);
  if (!row || row.status !== 'active') deny('Local subagent job is no longer executing.');
  await assertLocalSubagentExecution(ctx.engine, accepted.authority, row.name, row.data, ctx.jobId);
  return structuredClone(accepted.authority);
}
export async function checkLocalSubagentTool(ctx: OperationContext, operation: string): Promise<void> {
  const accepted = ctx.localSubagent && executions.get(ctx.localSubagent);
  if (!accepted) deny('Unrecognized local subagent tool capability.');
  await localSubagentWrite(ctx, operation, accepted.authority.grant.sourceId, accepted.authority.grant.sourceIncarnation);
}
/** Receipts retain accepted provenance. Publication/replay do not depend on private queue rows. */
export async function assertLocalSubagentReceipt(engine: SqlEngine, authority: WriteAuthority, operation: string, slug: string, lock: boolean): Promise<void> {
  const a = parseLocalSubagent(authority.localSubagent);
  if (!a || !a.acceptedJobId || authority.principal.kind !== 'local_cli' || authority.principal.id !== a.principal.id || !authority.remote ||
      authority.sourceId !== a.grant.sourceId || authority.sourceIncarnation !== a.grant.sourceIncarnation ||
      !a.grant.allowedOperations.includes(operation) || !matchesSlugAllowList(slug, a.grant.allowedSlugPrefixes) ||
      !authority.restrictedNamespace || authority.delegated || authorityDigest(authority.delegatedPrefixes) !== authorityDigest(a.grant.allowedSlugPrefixes) ||
      authorityDigest(authority.operations) !== authorityDigest(a.grant.allowedOperations) ||
      authorityDigest(authority.slugPrefixes) !== authorityDigest(a.grant.parent.slugPrefixes) ||
      authorityDigest(authority.scopes) !== authorityDigest(a.grant.parent.scopes) ||
      a.grant.parent.slugPrefixes !== null && !slugUnderBoundPrefixes(a.grant.parent.slugPrefixes, slug)) deny('Invalid durable local subagent write delegation.');
  await assertLocalSubagentLive(engine, a, lock);
}
