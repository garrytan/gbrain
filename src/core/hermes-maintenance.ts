/** Trusted-local, one-engine Hermes import and maintenance orchestration.
 * An explicit invocation authorizes importing the selected transcript store.
 * Scheduling capture is a separate opt-in; no provider or consent config is set here.
 */
import type { BrainEngine } from './engine.ts';
import type { OperationContext } from './ops/contract.ts';
import type { CycleOpts, CycleReport, CyclePhase } from './cycle.ts';
import type { TranscriptsIngestOpts, TranscriptsIngestResult } from './transcripts/ingest.ts';
import type { VerifiedLocalWriter } from './persistence/identity.ts';

export interface HermesMaintenanceOptions {
  stateDb: string;
  sourceId: string;
  context: OperationContext;
  brainDir?: string | null;
  enrich?: boolean;
  windowSeconds?: number;
  limit?: number;
  sinceIso?: string;
  sessionSources?: string[];
  messagesSinceIso?: string;
  signal?: AbortSignal;
}

export interface HermesMaintenanceDependencies {
  ingest(engine: BrainEngine, options: TranscriptsIngestOpts): Promise<TranscriptsIngestResult>;
  cycle(engine: BrainEngine, options: CycleOpts): Promise<CycleReport>;
  /** In-process test seam; production reads the credential verifier's ALS. */
  currentVerifiedLocalWriter?(): VerifiedLocalWriter | undefined;
}

export interface HermesMaintenanceReport {
  schema_version: 1;
  status: 'ok' | 'partial' | 'failed';
  source_id: string;
  duration_ms: number;
  ingest: TranscriptsIngestResult | null;
  cycle: CycleReport | null;
  validation: { checked: number; missing: string[] };
  reasons: string[];
}

export async function runHermesMaintenance(
  engine: BrainEngine,
  options: HermesMaintenanceOptions,
  dependencies?: HermesMaintenanceDependencies,
): Promise<HermesMaintenanceReport> {
  // A missing local coordinator must never silently take the legacy writer lane.
  if (options.context.remote !== false) throw new Error('Hermes maintenance requires a trusted-local operation context');
  if (options.context.engine !== engine) throw new Error('Hermes maintenance context must use the same engine');
  // runCycle's existing facts drain is brain-wide. A selected destination is
  // routing, while an authenticated source grant is an authority ceiling.
  // AuthInfo.allowedSources contains concrete read-source IDs, not wildcard
  // writer authority. Only the verifier's retained local registration proves
  // an authenticated caller may run this existing brain-wide mutation.
  if (options.enrich && options.context.auth) {
    const writer = dependencies?.currentVerifiedLocalWriter
      ? dependencies.currentVerifiedLocalWriter()
      : (await import('./persistence/identity.ts')).currentVerifiedLocalWriter();
    if (!writer || writer.remote || writer.principal.kind !== 'local_cli' ||
      writer.principal.id !== options.context.auth.clientId ||
      !writer.grant.sourceIds.includes('*') || !writer.grant.scopes.includes('read') ||
      !writer.grant.scopes.includes('write') || writer.grant.operations !== null ||
      writer.grant.slugPrefixes !== null) {
      throw new Error('Hermes enrichment requires a verified unrestricted local CLI writer grant because the facts drain is brain-wide; use import-only maintenance with the existing source-limited grant');
    }
  }
  const seconds = options.windowSeconds ?? 300;
  const limit = options.limit ?? 100;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('window must be 1..3600 seconds');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be 1..10000 sessions');
  const started = Date.now();
  const deadlineAtMs = started + seconds * 1000;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('maintenance deadline reached')), seconds * 1000);
  const report: HermesMaintenanceReport = {
    schema_version: 1, status: 'ok', source_id: options.sourceId, duration_ms: 0,
    ingest: null, cycle: null, validation: { checked: 0, missing: [] }, reasons: [],
  };
  try {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('maintenance aborted');
    const deps = dependencies ?? {
      ingest: (await import('./transcripts/ingest.ts')).runTranscriptsIngest,
      cycle: (await import('./cycle.ts')).runCycle,
    };
    report.ingest = await deps.ingest(engine, {
      paths: [options.stateDb], format: 'hermes', sourceId: options.sourceId,
      context: options.context, embed: false, limit, sinceIso: options.sinceIso,
      ...(options.sessionSources?.length ? { sessionSources: options.sessionSources } : {}),
      ...(options.messagesSinceIso ? { messagesSinceIso: options.messagesSinceIso } : {}),
      signal: controller.signal,
    });
    if (!report.ingest.cleanScan) report.reasons.push('ingest_incomplete');
    if (report.ingest.sessionsSeen === 0) report.reasons.push('no_sessions');
    else if (report.ingest.slugsTouched.length === 0) report.reasons.push('no_matching_input');
    // Do not synthesize an incomplete input range or fabricate a clean nightly run.
    if (options.enrich && report.ingest.cleanScan && report.ingest.slugsTouched.length > 0 && !controller.signal.aborted) {
      const phases: CyclePhase[] = ['facts_drain'];
      const enabled = await engine.getConfig('dream.synthesize.enabled');
      const pages = await engine.getConfig('dream.synthesize.conversation_pages');
      if (enabled === 'true' && pages === 'true' && options.brainDir) phases.unshift('synthesize');
      else report.reasons.push('synthesis_not_configured');
      report.cycle = await deps.cycle(engine, {
        brainDir: options.brainDir ?? null, sourceId: options.sourceId,
        phases, pull: false, signal: controller.signal, deadlineAtMs,
      });
      if (report.cycle.status !== 'ok' && report.cycle.status !== 'clean') {
        report.reasons.push(report.cycle.reason ?? 'cycle_incomplete');
      }
      if (report.cycle.phases.some(p => p.status === 'warn' || p.status === 'fail' ||
        (p.phase === 'facts_drain' && typeof p.details?.backlog_after === 'number' && p.details.backlog_after > 0))) {
        report.reasons.push('enrichment_incomplete');
      }
      if (report.cycle.phases.some(p => p.status === 'skipped')) report.reasons.push('enrichment_skipped');
    }
    for (const slug of report.ingest.slugsTouched) {
      if (controller.signal.aborted) break;
      const page = await engine.getPage(slug, { sourceId: options.sourceId });
      report.validation.checked++;
      if (!page) report.validation.missing.push(slug);
    }
    if (report.validation.missing.length) report.reasons.push('imported_pages_missing');
    if (controller.signal.aborted) report.reasons.push('deadline_or_abort');
    if (report.reasons.length) report.status = 'partial';
    if (report.validation.missing.length || report.cycle?.status === 'failed' ||
      (report.ingest.pages.errored > 0 && report.ingest.pages.imported === 0 && report.ingest.pages.skipped === 0)) report.status = 'failed';
  } catch (error) {
    report.status = 'failed';
    report.reasons.push(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    report.duration_ms = Date.now() - started;
  }
  return report;
}
