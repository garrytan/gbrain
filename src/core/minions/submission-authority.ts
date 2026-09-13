/** Durable authority for queued work. Payloads and caller-spread options are never authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { AuthInfo, OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { normalizeSlugPrefix } from '../ops/context.ts';
import { hasScope } from '../scope.ts';
import { coerceLegacyPermissions, normalizeTokenScopes, parseLegacyTokenScope } from '../legacy-token-scope.ts';
import { isValidSourceId } from '../source-id.ts';
import { discoverGitRoot } from '../sync-git.ts';
import type { MinionJob } from './types.ts';
import { effectiveDelegation, snapshotFromJob } from './delegated-policy.ts';

export const REMOTE_JOB_NAMES = ['sync', 'import', 'lint', 'lint-fix'] as const;
export type RemoteJobName = typeof REMOTE_JOB_NAMES[number];
export type SubmissionAuthority = { version: 1; kind: 'application' } | RemoteJobAuthority | RemoteAgentAuthority;
export interface RemoteAgentAuthority {
  version: 1;
  kind: 'remote_agent';
  principal: { kind: 'oauth_client'; id: string };
  grant: { scopes: string[]; sourceId: string; sourceCreatedAt: string; allowedTools: string[]; allowedSlugPrefixes: string[] };
  payloadHash: string;
}
export interface RemoteJobAuthority {
  version: 1;
  kind: 'remote_generic';
  principal: NonNullable<AuthInfo['principal']>;
  grant: {
    scopes: string[];
    sourceId: string;
    sourceCreatedAt: string;
    canonicalRoot: string;
    worktreeRoot: string | null;
    jobName: RemoteJobName;
    allowedOperations?: string[] | null;
  };
  payloadHash: string;
}
export const APPLICATION_AUTHORITY: SubmissionAuthority = Object.freeze({ version: 1, kind: 'application' });
const executionAuthority = new AsyncLocalStorage<{ authority: SubmissionAuthority; signal?: AbortSignal }>();
export function currentSubmissionAuthority(): SubmissionAuthority | undefined { return executionAuthority.getStore()?.authority; }
export function currentRemoteJobAuthority(): RemoteJobAuthority | undefined {
  const a = executionAuthority.getStore()?.authority;
  return a?.kind === 'remote_generic' ? a : undefined;
}
export function currentJobSignal(): AbortSignal | undefined { return executionAuthority.getStore()?.signal; }
export function withSubmissionAuthority<T>(authority: SubmissionAuthority, fn: () => T, signal?: AbortSignal): T {
  return executionAuthority.run({ authority, signal }, fn);
}
function deny(message: string): never {
  throw new OperationError('permission_denied', `Queued job authorization: ${message}`);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
/** Stable digest also used by local legacy-review CAS; no credentials are hashed into payloads. */
export function authorityDigest(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : typeof v === 'bigint' ? v.toString()
    : v instanceof Date ? v.toISOString()
    : record(v) ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]))
    : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function parseSubmissionAuthority(value: unknown): SubmissionAuthority | null {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  const a = record(value);
  if (a?.version !== 1) return null;
  if (a.kind === 'application') return APPLICATION_AUTHORITY;
  const p = record(a.principal), g = record(a.grant);
  if (a.kind === 'remote_agent') {
    if (p?.kind !== 'oauth_client' || typeof p.id !== 'string' || !p.id || !g ||
        !Array.isArray(g.scopes) || !g.scopes.every(v => typeof v === 'string') ||
        typeof g.sourceId !== 'string' || !isValidSourceId(g.sourceId) || typeof g.sourceCreatedAt !== 'string' ||
        !Array.isArray(g.allowedTools) || !g.allowedTools.length || !g.allowedTools.every(v => typeof v === 'string' && v.length) ||
        !Array.isArray(g.allowedSlugPrefixes) || !g.allowedSlugPrefixes.every(v => typeof v === 'string') ||
        typeof a.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(a.payloadHash)) return null;
    return structuredClone(a) as unknown as RemoteAgentAuthority;
  }
  if (a.kind !== 'remote_generic' || !p || !g ||
      !['oauth_client', 'legacy_token'].includes(String(p.kind)) || typeof p.id !== 'string' || !p.id ||
      !Array.isArray(g.scopes) || !g.scopes.every(s => typeof s === 'string') ||
      (g.allowedOperations !== undefined && g.allowedOperations !== null &&
        (!Array.isArray(g.allowedOperations) || !g.allowedOperations.every(op => typeof op === 'string' && op.length))) ||
      typeof g.sourceId !== 'string' || !isValidSourceId(g.sourceId) ||
      typeof g.sourceCreatedAt !== 'string' || typeof g.canonicalRoot !== 'string' || !g.canonicalRoot ||
      !(g.worktreeRoot === null || typeof g.worktreeRoot === 'string') ||
      !REMOTE_JOB_NAMES.includes(g.jobName as RemoteJobName) || typeof a.payloadHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(a.payloadHash)) return null;
  return structuredClone(a) as unknown as RemoteJobAuthority;
}
export function assertSameAuthority(actual: unknown, expected: SubmissionAuthority): void {
  const parsed = parseSubmissionAuthority(actual);
  if (!parsed || authorityDigest(parsed) !== authorityDigest(expected)) deny('coalescing across submission authorities is forbidden');
}

async function sourceBoundary(engine: BrainEngine, sourceId: string, jobName: RemoteJobName) {
  const [source] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT id, local_path, config, archived, created_at FROM sources WHERE id = $1', [sourceId]);
  if (!source || source.archived !== false || typeof source.local_path !== 'string' || !source.local_path) {
    deny('an active source with a registered filesystem root is required');
  }
  let config = source.config;
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch { deny('malformed source config'); } }
  if (!record(config) || record(config)!.kind != null) deny('generic filesystem jobs require an ordinary filesystem source; use the dedicated connector endpoint');
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(source.local_path);
    if (!statSync(canonicalRoot).isDirectory()) deny('registered source root must be a directory');
  } catch { deny('registered source root is unavailable or is not a directory'); }
  let worktreeRoot: string | null = null;
  try { worktreeRoot = realpathSync(discoverGitRoot(canonicalRoot)); }
  catch { if (jobName === 'sync') deny('remote sync requires an existing Git working tree; initialize or restore it locally'); }
  return { canonicalRoot, worktreeRoot, sourceCreatedAt: new Date(source.created_at as string).toISOString() };
}

async function assertCurrentPrincipal(engine: BrainEngine, authority: RemoteJobAuthority): Promise<void> {
  const { principal, grant } = authority;
  let scopes: string[], sourceId: string | undefined;
  if (principal.kind === 'oauth_client') {
    // No fallback projections: an incomplete auth schema cannot authorize background work.
    const [row] = await engine.executeRaw<Record<string, unknown>>(
      'SELECT client_id, deleted_at, scope, source_id, bound_slug_prefixes, surface, allowed_operations FROM oauth_clients WHERE client_id = $1', [principal.id]);
    if (!row || row.deleted_at != null) deny('OAuth client is missing or revoked');
    scopes = typeof row.scope === 'string' ? row.scope.split(/\s+/).filter(Boolean) : [];
    sourceId = typeof row.source_id === 'string' ? row.source_id : undefined;
    if (row.bound_slug_prefixes != null) deny('bulk filesystem jobs are unavailable to slug-bound clients');
    if (row.surface != null && row.surface !== 'full') deny('current client surface does not permit generic jobs');
    for (const operations of [grant.allowedOperations, row.allowed_operations]) {
      if (operations != null && (!Array.isArray(operations) || !operations.every(op => typeof op === 'string') || !operations.includes('submit_job'))) {
        deny('original and current operation grants must authorize submit_job');
      }
    }
  } else {
    const [row] = await engine.executeRaw<Record<string, unknown>>(
      'SELECT id, revoked_at, scopes, permissions FROM access_tokens WHERE id = $1', [principal.id]);
    if (!row || row.revoked_at != null) deny('legacy token is missing or revoked');
    scopes = normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin'];
    if (row.permissions != null && !coerceLegacyPermissions(row.permissions)) deny('malformed token permissions');
    sourceId = parseLegacyTokenScope(coerceLegacyPermissions(row.permissions)?.source_id).sourceId;
  }
  if (!hasScope(grant.scopes, 'admin') || !hasScope(scopes, 'admin') || sourceId !== grant.sourceId) {
    deny('the original grant and current principal must both authorize this source and admin operation');
  }
}

export async function prepareRemoteJob(
  ctx: OperationContext, name: string, input: unknown,
): Promise<{ data: Record<string, unknown>; authority: RemoteJobAuthority }> {
  if (!REMOTE_JOB_NAMES.includes(name as RemoteJobName)) deny('unsupported remote job; only sync, import, lint and lint-fix are available through remote submit_job');
  const principal = ctx.auth?.principal;
  const sourceId = ctx.auth?.sourceId;
  if (!principal || !sourceId || !isValidSourceId(sourceId) || ctx.sourceId !== sourceId || !hasScope(ctx.auth?.scopes ?? [], 'admin')) {
    deny('an authenticated persistent principal and scalar write source are required; use local CLI or a dedicated operation');
  }
  if (ctx.auth?.boundSlugPrefixes !== undefined || ctx.auth?.fenceProjectionDegraded) deny('bulk filesystem jobs require an unrestricted source grant');
  const raw = input === undefined ? {} : record(input);
  if (!raw) deny('job data must be an object');
  const allowed = name === 'sync' ? ['pull', 'noPull'] : [];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) deny('unsupported remote job parameter');
  for (const key of allowed) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') deny(`${key} must be a boolean`);
  if (raw.pull !== undefined && raw.noPull !== undefined) deny('supply only one of pull and noPull');
  const boundary = await sourceBoundary(ctx.engine, sourceId, name as RemoteJobName);
  const wholeWorktree = boundary.canonicalRoot === boundary.worktreeRoot;
  const pull = raw.pull ?? (raw.noPull !== undefined ? !raw.noPull : wholeWorktree);
  if (name === 'sync' && pull && !wholeWorktree) deny('pull is unavailable for a source nested inside another Git working tree');
  const data: Record<string, unknown> = name === 'sync'
    ? { repoPath: boundary.canonicalRoot, sourceId, noPull: !pull, noEmbed: true, noExtract: true, auto_embed_backfill: false }
    : { dir: boundary.canonicalRoot, sourceId, ...(name === 'import' ? { noEmbed: true } : {}) };
  const authority: RemoteJobAuthority = {
    version: 1, kind: 'remote_generic', principal: { ...principal },
    grant: { scopes: [...ctx.auth!.scopes], sourceId, ...boundary, jobName: name as RemoteJobName,
      allowedOperations: ctx.auth?.allowedOperations == null ? null : [...ctx.auth.allowedOperations] },
    payloadHash: authorityDigest(data),
  };
  await assertCurrentPrincipal(ctx.engine, authority);
  return { data, authority };
}

const toolName = (name: string) => name.replace(/^(?:brain_|mcp__gbrain__)/, '');

async function assertCurrentAgent(engine: BrainEngine, a: RemoteAgentAuthority, data: Record<string, unknown>, jobId?: number): Promise<void> {
  const [source] = await engine.executeRaw<Record<string, unknown>>('SELECT archived, created_at FROM sources WHERE id = $1', [a.grant.sourceId]);
  if (!source || source.archived !== false || new Date(source.created_at as string).toISOString() !== a.grant.sourceCreatedAt) deny('agent source is missing, archived, or was replaced');
  if (data.__delegation_grant !== undefined) {
    const submitted = snapshotFromJob(data);
    if (!submitted || submitted.clientId !== a.principal.id || submitted.sourceId !== a.grant.sourceId
      || authorityDigest(submitted.tools) !== authorityDigest(a.grant.allowedTools)
      || authorityDigest(submitted.slugPrefixes) !== authorityDigest(a.grant.allowedSlugPrefixes)
      || !hasScope(a.grant.scopes, 'agent')) deny('delegation snapshot differs from its accepted authority');
    // Direct and delegated namespaces are independent. The current grant may
    // narrow tools/paths, while the submitted snapshot remains the ceiling.
    await effectiveDelegation(engine, submitted, jobId);
    return;
  }
  // Preserve the older explicit authority shape for already accepted jobs.
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT deleted_at, scope, source_id, bound_tools, bound_source_id, bound_slug_prefixes FROM oauth_clients WHERE client_id = $1', [a.principal.id]);
  if (!row || row.deleted_at != null) deny('agent owner is missing or revoked');
  const scopes = typeof row.scope === 'string' ? row.scope.split(/\s+/) : [];
  if (!hasScope(a.grant.scopes, 'agent') || !hasScope(scopes, 'agent')) deny('original and current grants must include agent scope');
  if (row.source_id !== a.grant.sourceId || (row.bound_source_id != null && row.bound_source_id !== a.grant.sourceId)) deny('agent source grant changed');
  if (!Array.isArray(row.bound_tools) || !row.bound_tools.length ||
      !row.bound_tools.every(t => typeof t === 'string' && t.length && !['file_list', 'file_url'].includes(toolName(t)))) deny('current agent tool binding is empty or unsupported');
  const tools = row.bound_tools.map(t => toolName(t as string));
  if (a.grant.allowedTools.some(t => !tools.includes(toolName(t)))) deny('accepted agent tools are outside the current binding');
  const prefixes = row.bound_slug_prefixes;
  if (prefixes != null) {
    if (!Array.isArray(prefixes) || !prefixes.length || !prefixes.every(p => typeof p === 'string' && p.length) || !a.grant.allowedSlugPrefixes.length) deny('agent slug binding changed');
    for (const granted of a.grant.allowedSlugPrefixes) {
      const requested = normalizeSlugPrefix(granted);
      if (!prefixes.some(p => { const base = normalizeSlugPrefix(p as string); return base && (base.endsWith('/') ? requested.startsWith(base) : requested === base || requested.startsWith(`${base}/`)); })) deny('accepted agent slug grant is outside the current binding');
    }
  }
}

export async function prepareRemoteAgent(ctx: OperationContext, data: Record<string, unknown>): Promise<RemoteAgentAuthority> {
  const principal = ctx.auth?.principal;
  if (principal?.kind !== 'oauth_client' || principal.id !== ctx.auth?.clientId || !hasScope(ctx.auth?.scopes ?? [], 'agent') ||
      typeof data.source_id !== 'string' || data.source_id !== ctx.auth?.sourceId || !isValidSourceId(data.source_id)) deny('submit_agent requires a verified OAuth principal and scalar source grant');
  const [source] = await ctx.engine.executeRaw<Record<string, unknown>>('SELECT archived, created_at FROM sources WHERE id = $1', [data.source_id]);
  if (!source || source.archived !== false) deny('agent source must be active');
  const authority: RemoteAgentAuthority = {
    version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: principal.id },
    grant: { scopes: [...ctx.auth!.scopes], sourceId: data.source_id, sourceCreatedAt: new Date(source.created_at as string).toISOString(),
      allowedTools: [...data.allowed_tools as string[]], allowedSlugPrefixes: [...data.allowed_slug_prefixes as string[]] },
    payloadHash: authorityDigest(data),
  };
  if (!parseSubmissionAuthority(authority)) deny('invalid agent grant');
  await assertCurrentAgent(ctx.engine, authority, data);
  return authority;
}

/** Runs in BOTH inline and isolated workers, immediately before the handler. */
export async function authorizeJobExecution(engine: BrainEngine, job: Pick<MinionJob, 'name' | 'data' | 'submission_authority'> & Partial<Pick<MinionJob, 'id'>>): Promise<SubmissionAuthority> {
  const a = parseSubmissionAuthority(job.submission_authority);
  if (!a) deny('missing or unsupported submission authority; review locally with jobs authorize-legacy');
  if (a.kind === 'application') return a;
  if (a.kind === 'remote_agent') {
    if (job.name !== 'subagent' || authorityDigest(job.data) !== a.payloadHash) deny('agent payload differs from its accepted grant');
    await assertCurrentAgent(engine, a, job.data, job.id);
    return a;
  }
  if (job.name !== a.grant.jobName || authorityDigest(job.data) !== a.payloadHash) deny('job data or name differs from its accepted grant');
  await assertCurrentPrincipal(engine, a);
  const boundary = await sourceBoundary(engine, a.grant.sourceId, a.grant.jobName);
  for (const key of ['canonicalRoot', 'worktreeRoot', 'sourceCreatedAt'] as const) {
    if (boundary[key] !== a.grant[key]) deny('source registration or filesystem root changed; submit a new job');
  }
  return a;
}

export async function assertRemoteJobControl(ctx: OperationContext, job: MinionJob, overrides?: unknown): Promise<void> {
  if (ctx.remote === false) return;
  const a = parseSubmissionAuthority(job.submission_authority);
  if (!a || a.kind === 'application' || !ctx.auth?.principal ||
      authorityDigest(a.principal) !== authorityDigest(ctx.auth.principal)) deny('only the submitting principal may restart a generic remote job');
  if (overrides !== undefined && (!record(overrides) || Object.keys(overrides as object).length)) deny('replay overrides are unavailable remotely; submit a new job');
  if (!hasScope(ctx.auth.scopes, 'admin') || ctx.auth.sourceId !== a.grant.sourceId) deny('current request is outside the original grant');
  await authorizeJobExecution(ctx.engine, job);
}

/** Startup and claim gate: do not let sweeps silently destroy unresolved legacy dependency graphs. */
export async function assertNoUnreviewedJobs(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<{ id: number; submission_authority: unknown }>(
    `SELECT id, submission_authority FROM minion_jobs
      WHERE status IN ('waiting','active','delayed','waiting-children','paused')
        AND submission_authority IS DISTINCT FROM '{"version":1,"kind":"application"}'::jsonb`);
  const invalid = rows.filter(row => !parseSubmissionAuthority(row.submission_authority));
  if (invalid.length) deny(`${invalid.length} legacy jobs have missing or unsupported authority; stop producers/workers. Review SQL NULL rows with jobs authorize-legacy --ids ...; unsupported non-NULL authority requires matching application/database versions or explicit local cancellation before workers start`);
}
