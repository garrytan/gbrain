/** Local-only, authenticated maintenance requests. No MCP or SQL surface. */
import { isAbsolute } from 'node:path';
import { isValidSourceId } from '../source-id.ts';
import type { HermesMaintenanceReport } from '../hermes-maintenance.ts';
import type { LocalRegistration } from '../persistence/identity.ts';

export interface DelegatedHermesOptions {
  stateDb: string;
  sourceId?: string;
  brainDir?: string;
  enrich?: boolean;
  windowSeconds?: number;
  limit?: number;
  sinceIso?: string;
  messagesSinceIso?: string;
  sessionSources?: string[];
}
export interface HermesStartRequest {
  kind: 'hermes_start'; protocol: 2; secret: string; clientToken: string;
  registration: LocalRegistration; options: DelegatedHermesOptions;
}
export interface HermesStatusRequest { kind: 'hermes_status'; protocol: 2; secret: string; jobId: string; }
export interface HermesAbortRequest { kind: 'hermes_abort'; protocol: 2; secret: string; jobId: string; }
export interface HermesStartResponse { ok: boolean; protocol: 2; jobId?: string; error?: string; }
export interface HermesWireReport extends HermesMaintenanceReport {
  wire_omitted: { files: number; touched_slugs: number; missing_slugs: number; cycle_detail_fields: number };
}
export interface HermesStatusResponse {
  ok: boolean; protocol: 2; error?: string;
  state?: 'running' | 'done' | 'error'; report?: HermesWireReport; jobError?: string;
}
export interface HermesAbortResponse { ok: boolean; protocol: 2; error?: string; }

export function validateDelegatedHermesOptions(raw: unknown):
  { ok: true; options: DelegatedHermesOptions } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid_options' };
  const rec = raw as Record<string, unknown>;
  const allowed = new Set(['stateDb', 'sourceId', 'brainDir', 'enrich', 'windowSeconds', 'limit', 'sinceIso', 'messagesSinceIso', 'sessionSources']);
  const bad = (key: string) => ({ ok: false as const, error: `invalid_options:${key}` });
  for (const key of Object.keys(rec)) if (!allowed.has(key)) return bad(key);
  for (const key of ['stateDb', 'brainDir']) {
    const v = rec[key];
    if (v === undefined && key !== 'stateDb') continue;
    if (typeof v !== 'string' || !isAbsolute(v) || v.length > 4096 || v.includes('\u0000')) return bad(key);
  }
  if (rec.sourceId !== undefined && !isValidSourceId(rec.sourceId)) return bad('sourceId');
  if (rec.enrich !== undefined && typeof rec.enrich !== 'boolean') return bad('enrich');
  for (const [key, max] of [['windowSeconds', 3600], ['limit', 10000]] as const) {
    const v = rec[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max)) return bad(key);
  }
  for (const key of ['sinceIso', 'messagesSinceIso']) {
    const v = rec[key];
    if (v !== undefined && (typeof v !== 'string' || v.length > 64 || !Number.isFinite(Date.parse(v)))) return bad(key);
  }
  if (rec.sessionSources !== undefined && (!Array.isArray(rec.sessionSources) || rec.sessionSources.length < 1 || rec.sessionSources.length > 16 ||
      rec.sessionSources.some(v => typeof v !== 'string' || !v || v.length > 128 || v.includes('\u0000')))) return bad('sessionSources');
  return { ok: true, options: { ...rec, ...(rec.sessionSources ? { sessionSources: [...rec.sessionSources as string[]] } : {}) } as unknown as DelegatedHermesOptions };
}

/** Keep counters truthful while bounding the local status frame. */
export function hermesReportForWire(report: HermesMaintenanceReport): HermesWireReport {
  const ingest = report.ingest;
  let cycleDetailFields = 0;
  const cycle = report.cycle ? { ...report.cycle, phases: report.cycle.phases.map(phase => {
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(phase.details)) {
      if (Object.keys(details).length < 50 && key.length < 128 && (value === null || typeof value === 'number' ||
          typeof value === 'boolean' || typeof value === 'string' && value.length < 1000)) details[key] = value;
      else cycleDetailFields++;
    }
    return { ...phase, summary: phase.summary.slice(0, 1000), details };
  }) } : null;
  return { ...report, reasons: report.reasons.map(r => r.slice(0, 1000)),
    cycle,
    ingest: ingest ? { ...ingest, files: [], slugsTouched: ingest.slugsTouched.slice(0, 100) } : null,
    validation: { ...report.validation, missing: report.validation.missing.slice(0, 100) },
    wire_omitted: { files: ingest?.files.length ?? 0, touched_slugs: Math.max(0, (ingest?.slugsTouched.length ?? 0) - 100),
      missing_slugs: Math.max(0, report.validation.missing.length - 100), cycle_detail_fields: cycleDetailFields } };
}
