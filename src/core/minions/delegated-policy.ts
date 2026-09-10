import type { BrainEngine } from '../engine.ts';
import { readClientGrant, grantValidationContext, delegationReasons, type ClientGrant } from '../grants/service.ts';
import { validGrantPrefixes, normalizeGrantBrain } from '../grants/model.ts';
import { hasScope } from '../scope.ts';
import { normalizeSlugPrefix } from '../ops/context.ts';
import { UnrecoverableError } from './errors.ts';

/** Immutable submission ceiling. Current grants may narrow it, never enlarge it. */
export interface DelegationSnapshot {
  clientId: string;
  sourceId: string;
  brainId: string | null;
  tools: string[];
  /** Absent only on pre-snapshot jobs; null preserves legacy operation grants. */
  allowedOperations?: string[] | null;
  slugPrefixes: string[];
  namespace?: 'prefixes' | 'job';
  readSources: string[];
  scopes: string[];
  maxConcurrent: number;
  budgetUsdPerDay: string | null;
  /** Legacy payloads consult any ceiling frozen by in-place grant repair. */
  legacy?: boolean;
}

export class DelegationDeniedError extends UnrecoverableError {
  constructor(public readonly reasons: string[]) {
    super(`agent_bindings_invalid: ${reasons.join(', ')}. Repair with gbrain auth rescope-client; this job never changes its submitted source.`);
    this.name = 'DelegationDeniedError';
  }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.length > 0);
}

function prefixContains(parent: string, child: string): boolean {
  const p = normalizeSlugPrefix(parent);
  const c = normalizeSlugPrefix(child);
  return p !== '' && (c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`));
}

export function intersectDelegatedPrefixes(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set(a.flatMap(left => b.flatMap(right =>
    prefixContains(left, right) ? [right] : prefixContains(right, left) ? [left] : [],
  )))].map(p => p.endsWith('/') ? `${p}*` : p);
}

export async function currentDelegationGrant(engine: BrainEngine, clientId: string, servingBrainId?: string): Promise<ClientGrant> {
  const grant = await readClientGrant(engine, clientId);
  const reasons = delegationReasons(grant, await grantValidationContext(engine, servingBrainId));
  if (grant.allowedOperations !== null && !grant.allowedOperations.includes('submit_agent')) reasons.push('delegation_operation_withdrawn');
  if (reasons.length) throw new DelegationDeniedError(reasons);
  return grant;
}

export function submissionSnapshot(grant: ClientGrant, requested: Record<string, unknown>, authenticatedSource?: string): DelegationSnapshot {
  if (authenticatedSource !== undefined && grant.sourceId !== authenticatedSource) throw new DelegationDeniedError(['authenticated_source_changed']);
  if (grant.allowedOperations !== null && !grant.allowedOperations.includes('submit_agent')) throw new DelegationDeniedError(['delegation_operation_withdrawn']);
  const availableTools = grant.boundTools?.filter(tool => grant.allowedOperations === null || grant.allowedOperations.includes(tool));
  const tools = requested.allowed_tools === undefined ? availableTools : requested.allowed_tools;
  const jobNamespace = grant.delegatedNamespace === 'job';
  if (jobNamespace && requested.allowed_slug_prefixes !== undefined) throw new DelegationDeniedError(['job_namespace_cannot_be_overridden']);
  const prefixes = jobNamespace ? ['wiki/agents/{job_id}/*'] : requested.allowed_slug_prefixes === undefined ? grant.delegatedSlugPrefixes : requested.allowed_slug_prefixes;
  if (!strings(tools) || tools.some(t => !availableTools?.includes(t))) throw new DelegationDeniedError(['delegated_tools_invalid']);
  if (!strings(prefixes) || (!jobNamespace && (!validGrantPrefixes(prefixes) || prefixes.some(p => !grant.delegatedSlugPrefixes?.some(bound => prefixContains(bound, p)))))) throw new DelegationDeniedError(['delegated_prefixes_invalid']);
  return {
    clientId: grant.clientId, sourceId: grant.sourceId!, brainId: grant.boundBrainId,
    tools: [...tools], slugPrefixes: prefixes.map(p => p.endsWith('/') ? `${p}*` : p),
    allowedOperations: grant.allowedOperations === null ? null : [...grant.allowedOperations],
    namespace: jobNamespace ? 'job' : 'prefixes',
    readSources: grant.federatedRead.filter(id => id === grant.boundSourceId), scopes: [...grant.scopes],
    maxConcurrent: grant.boundMaxConcurrent, budgetUsdPerDay: grant.budgetUsdPerDay,
  };
}

/** Legacy jobs retain their explicit submitted bounds; missing/empty is never full. */
export function snapshotFromJob(data: Record<string, unknown>): DelegationSnapshot | null {
  const clientId = data.__owner_client_id;
  if (clientId === undefined) return null;
  if (typeof clientId !== 'string' || !clientId) throw new DelegationDeniedError(['owner_invalid']);
  const stored = data.__delegation_grant;
  if (stored !== undefined) {
    if (!stored || typeof stored !== 'object') throw new DelegationDeniedError(['snapshot_invalid']);
    const s = stored as DelegationSnapshot;
    if (s.clientId !== clientId || typeof s.sourceId !== 'string' || !s.sourceId
      || (s.brainId !== null && (typeof s.brainId !== 'string' || !s.brainId))
      || (s.namespace !== undefined && s.namespace !== 'job' && s.namespace !== 'prefixes')
      || !strings(s.tools) || !strings(s.slugPrefixes)
      || (s.allowedOperations !== undefined && s.allowedOperations !== null
        && (!Array.isArray(s.allowedOperations) || !s.allowedOperations.every(op => typeof op === 'string' && op.length > 0)))
      || !strings(s.readSources) || !strings(s.scopes) || !Number.isSafeInteger(s.maxConcurrent) || s.maxConcurrent < 1
      || (s.budgetUsdPerDay !== null && (!/^\d+(?:\.\d{1,2})?$/.test(s.budgetUsdPerDay)))) {
      throw new DelegationDeniedError(['snapshot_invalid']);
    }
    return s;
  }
  if (!strings(data.allowed_tools) || typeof data.source_id !== 'string' || !data.source_id) {
    throw new DelegationDeniedError(['legacy_snapshot_missing']);
  }
  const prefixes = data.allowed_slug_prefixes;
  const jobNamespace = prefixes === undefined || prefixes === null || (Array.isArray(prefixes) && prefixes.length === 0);
  if (!jobNamespace && (!strings(prefixes) || !validGrantPrefixes(prefixes))) throw new DelegationDeniedError(['legacy_snapshot_invalid']);
  return {
    clientId, sourceId: data.source_id, brainId: typeof data.brain_id === 'string' ? data.brain_id : null,
    tools: [...data.allowed_tools], slugPrefixes: jobNamespace ? ['wiki/agents/{job_id}/*'] : [...prefixes as string[]],
    namespace: jobNamespace ? 'job' : 'prefixes', legacy: true,
    readSources: [data.source_id], scopes: ['read', 'write', 'agent'],
    maxConcurrent: Number.MAX_SAFE_INTEGER, budgetUsdPerDay: null,
  };
}

export async function effectiveDelegation(engine: BrainEngine, snapshot: DelegationSnapshot, jobId?: number): Promise<DelegationSnapshot> {
  if (snapshot.legacy && jobId !== undefined) {
    const rows = await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id=$1', [jobId]);
    const stored = rows[0]?.data;
    if (stored?.__delegation_grant !== undefined) {
      const frozen = snapshotFromJob(stored);
      if (!frozen || frozen.clientId !== snapshot.clientId) throw new DelegationDeniedError(['owner_changed']);
      snapshot = frozen;
    }
  }
  snapshot = { ...snapshot, brainId: normalizeGrantBrain(snapshot.brainId) };
  // A submitted brain ID is not proof of which host this worker serves.
  // Only serving-brain aliases are supported until host identity is independently known.
  const current = await currentDelegationGrant(engine, snapshot.clientId);
  if (snapshot.allowedOperations != null && !snapshot.allowedOperations.includes('submit_agent')) throw new DelegationDeniedError(['submitted_delegation_operation_missing']);
  if (current.sourceId !== snapshot.sourceId || current.boundSourceId !== snapshot.sourceId || current.boundBrainId !== snapshot.brainId) {
    throw new DelegationDeniedError(['submitted_source_or_brain_changed']);
  }
  const tools = snapshot.tools.filter(t => current.boundTools!.includes(t)
    && (snapshot.allowedOperations == null || snapshot.allowedOperations.includes(t))
    && (current.allowedOperations === null || current.allowedOperations.includes(t)));
  const jobPrefix = `wiki/agents/${jobId ?? '{job_id}'}/*`;
  const submittedPrefixes = snapshot.namespace === 'job' ? [jobPrefix] : snapshot.slugPrefixes;
  const currentPrefixes = current.delegatedNamespace === 'job' ? [jobPrefix] : current.delegatedSlugPrefixes!;
  const slugPrefixes = intersectDelegatedPrefixes(submittedPrefixes, currentPrefixes);
  const context = await grantValidationContext(engine);
  const readSources = snapshot.readSources.filter(id => id === current.boundSourceId
    && current.federatedRead.includes(id) && context.activeSourceIds.has(id));
  const scopes = ['read', 'write', 'agent'].filter(scope => hasScope(snapshot.scopes, scope) && hasScope(current.scopes, scope));
  if (!tools.length || !slugPrefixes.length || !readSources.includes(snapshot.sourceId) || !scopes.includes('agent')) {
    throw new DelegationDeniedError(['submitted_grant_no_longer_usable']);
  }
  const budgetUsdPerDay = snapshot.budgetUsdPerDay === null ? current.budgetUsdPerDay
    : current.budgetUsdPerDay === null ? snapshot.budgetUsdPerDay
    : String(Math.min(Number(snapshot.budgetUsdPerDay), Number(current.budgetUsdPerDay)));
  return { ...snapshot, tools, slugPrefixes, readSources, scopes,
    maxConcurrent: Math.min(snapshot.maxConcurrent, current.boundMaxConcurrent), budgetUsdPerDay };
}
