/** The live owner runs maintenance on its existing engine as the verified CLI. */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import type { OperationContext } from './ops/contract.ts';
import type { HermesMaintenanceOptions, HermesMaintenanceReport } from './hermes-maintenance.ts';
import { hermesReportForWire, validateDelegatedHermesOptions, type HermesStartResponse, type HermesStatusResponse, type HermesAbortResponse } from './context/hermes-ipc.ts';
import type { LocalRegistration, VerifiedLocalWriter } from './persistence/identity.ts';

interface Job {
  id: string; token: string; sourceId: string; registrationId: string; optionsKey: string; retainUntil: number;
  state: 'running' | 'done' | 'error'; abort: AbortController; settled: Promise<void>;
  report?: HermesMaintenanceReport; error?: string;
}
const jobs = new Map<BrainEngine, Job>();
const recentJobs = new Map<BrainEngine, Job[]>();
const closing = new WeakSet<BrainEngine>();

export interface HermesRunnerDependencies {
  verify(engine: BrainEngine, registration: LocalRegistration, task: (writer: VerifiedLocalWriter) => Promise<void>): Promise<void>;
  context(engine: BrainEngine, sourceId: string, writer: VerifiedLocalWriter): OperationContext;
  run(engine: BrainEngine, options: HermesMaintenanceOptions): Promise<HermesMaintenanceReport>;
}
async function nativeDependencies(): Promise<HermesRunnerDependencies> {
  const [{ withVerifiedLocalRegistration }, { buildOperationContext }, { runHermesMaintenance }] = await Promise.all([
    import('./persistence/identity.ts'), import('../mcp/dispatch.ts'), import('./hermes-maintenance.ts'),
  ]);
  return { verify: withVerifiedLocalRegistration, run: runHermesMaintenance,
    context: (engine, sourceId, writer) => buildOperationContext(engine, {}, { remote: false, sourceId,
      auth: { token: '', clientId: writer.principal.id, scopes: writer.grant.scopes, sourceId,
        allowedOperations: writer.grant.operations, allowedSources: writer.grant.sourceIds.includes('*') ? undefined : writer.grant.sourceIds } }) };
}

function permitsMaintenance(writer: VerifiedLocalWriter, sourceId: string, enrich = false): boolean {
  return !writer.remote && writer.principal.kind === 'local_cli' && writer.grant.scopes.includes('read') && writer.grant.scopes.includes('write') &&
    (writer.grant.sourceIds.includes('*') || writer.grant.sourceIds.includes(sourceId)) &&
    (!enrich || writer.grant.sourceIds.includes('*')) && // The existing facts drain is brain-wide.
    writer.grant.operations === null && writer.grant.slugPrefixes === null;
}

export async function startDelegatedHermesMaintenance(engine: BrainEngine, rawOptions: unknown, token: unknown,
  registration: LocalRegistration, boundSourceId: string, dependencies?: HermesRunnerDependencies): Promise<HermesStartResponse> {
  if (closing.has(engine)) return { ok: false, protocol: 2, error: 'shutting_down' };
  if (typeof token !== 'string' || !token || token.length > 128) return { ok: false, protocol: 2, error: 'invalid_client_token' };
  const parsed = validateDelegatedHermesOptions(rawOptions);
  if (!parsed.ok) return { ok: false, protocol: 2, error: parsed.error };
  const sourceId = parsed.options.sourceId ?? boundSourceId;
  const optionsKey = JSON.stringify(Object.entries(parsed.options).sort(([a], [b]) => a.localeCompare(b)));
  if (sourceId !== boundSourceId) return { ok: false, protocol: 2, error: 'source_mismatch' };
  if (!registration || registration.lane !== 'cli' || typeof registration.id !== 'string' || typeof registration.credential !== 'string') {
    return { ok: false, protocol: 2, error: 'permission_denied' };
  }
  const deps = dependencies ?? await nativeDependencies();
  let answer: HermesStartResponse = { ok: false, protocol: 2, error: 'permission_denied' };
  try {
    await deps.verify(engine, registration, async writer => {
      // This local-only orchestration cannot widen a revoked, source-, op- or slug-limited registration.
      if (!permitsMaintenance(writer, sourceId, parsed.options.enrich)) return;
      if (closing.has(engine)) { answer = { ok: false, protocol: 2, error: 'shutting_down' }; return; }
      const prior = jobs.get(engine);
      const recent = (recentJobs.get(engine) ?? []).filter(job => job.state === 'running' || job.retainUntil > Date.now());
      recentJobs.set(engine, recent);
      const retained = recent.find(job => job.token === token && job.registrationId === registration.id);
      if (retained) {
        if (retained.optionsKey !== optionsKey) { answer = { ok: false, protocol: 2, error: 'token_options_mismatch' }; return; }
        answer = { ok: true, protocol: 2, jobId: retained.id }; return;
      }
      if (prior?.state === 'running') { answer = { ok: false, protocol: 2, error: 'busy' }; return; }
      if (recent.length >= 20) { answer = { ok: false, protocol: 2, error: 'retained_jobs_full' }; return; }
      const job: Job = { id: randomUUID(), token, registrationId: registration.id, sourceId, optionsKey,
        retainUntil: Date.now() + ((parsed.options.windowSeconds ?? 300) + 60) * 1000,
        state: 'running', abort: new AbortController(), settled: Promise.resolve() };
      jobs.set(engine, job);
      recentJobs.set(engine, [...recent, job]);
      // Retain the verified registration context through every asynchronous mutation.
      job.settled = deps.verify(engine, registration, async freshWriter => {
        if (!permitsMaintenance(freshWriter, sourceId, parsed.options.enrich)) throw new Error('permission_denied');
        const context = deps.context(engine, sourceId, freshWriter);
        job.report = await deps.run(engine, { ...parsed.options, sourceId, context, signal: job.abort.signal });
        job.state = 'done';
      }).catch(error => { job.error = error instanceof Error ? error.message : String(error); job.state = 'error'; });
      answer = { ok: true, protocol: 2, jobId: job.id };
    });
  } catch { /* Failed credentials never disclose registration or imported content. */ }
  return answer;
}

export function getDelegatedHermesMaintenanceStatus(engine: BrainEngine, jobId: string, boundSourceId: string): HermesStatusResponse {
  const job = recentJobs.get(engine)?.find(job => job.id === jobId && job.sourceId === boundSourceId);
  if (!job) return { ok: false, protocol: 2, error: 'unknown_job' };
  return { ok: true, protocol: 2, state: job.state,
    ...(job.report ? { report: hermesReportForWire(job.report) } : {}), ...(job.error ? { jobError: job.error.slice(0, 1000) } : {}) };
}
export function abortDelegatedHermesMaintenance(engine: BrainEngine, jobId: string, boundSourceId: string): HermesAbortResponse {
  const job = recentJobs.get(engine)?.find(job => job.id === jobId && job.sourceId === boundSourceId);
  if (!job) return { ok: false, protocol: 2, error: 'unknown_job' };
  job.abort.abort(new Error('operator cancelled Hermes maintenance'));
  return { ok: true, protocol: 2 };
}
/** Both serve shutdown paths await this BEFORE disconnecting the engine. */
export async function shutdownDelegatedHermesMaintenance(engine: BrainEngine): Promise<void> {
  closing.add(engine);
  const job = jobs.get(engine);
  job?.abort.abort(new Error('serve shutting down'));
  await job?.settled;
  jobs.delete(engine);
  recentJobs.delete(engine);
}
