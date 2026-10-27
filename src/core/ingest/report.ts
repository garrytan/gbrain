/**
 * GBRA-215 L3: the ingest report. One JSON document answers ingest, ingest-show and the report page
 * (ingest/<attempt_id>, type ingest-report). The page carries the attempt's ownership evidence in frontmatter (every
 * created item's request id and principal) and a one-line summary as its body, so it names no claim and no entity in
 * text that search or link derivation reads, and the facts backstop never extracts from it.
 */
import type { OperationContext } from '../ops/contract.ts';
import { stringifyDataFrontmatter } from '../data-frontmatter.ts';
import type { IngestAttemptState, IngestStorage } from './checkpoint.ts';
import type { ProviderFailureReason } from './extract.ts';

export const INGEST_REPORT_TYPE = 'ingest-report';
export const INGEST_REPORT_PREFIX = 'ingest/';
export const reportSlugFor = (attemptId: string) => INGEST_REPORT_PREFIX + attemptId;

export type ItemStatus = 'created' | 'existing' | 'proposed' | 'support' | 'skipped' | 'held' | 'pending' | 'failed';
export interface ReportPage {
  name: string;
  slug: string;
  type: string;
  status: ItemStatus;
  reason?: string;
  near_names?: Array<{ slug: string; name: string; kind: string }>;
  request_id?: string;
  revision?: string;
}
export interface ReportCopy { entity_slug: string; status: ItemStatus; reason?: string; fact_id?: number; request_id?: string }
export interface ReportFact { fact: string; kind: string; status: ItemStatus; reason?: string; copies: ReportCopy[] }
export interface ReportAction {
  kind: string;
  next: 'run' | 'tell_user_to_run';
  argv: string[];
  mcp?: { tool: string; arguments: Record<string, unknown> };
  inputs?: Array<{ name: string; how: string }>;
  consent?: string[];
  why: string;
}
export interface ReportFailure {
  stage: 'validate' | 'extract' | 'plan' | 'commit';
  window?: number;
  reason: ProviderFailureReason | string;
  retryable: boolean;
  cause: string;
  model?: string;
  provider?: string;
  env_vars?: string[];
  gbrain_version: string;
  max_usd: number;
}
export type ReportStatus = 'complete' | 'incomplete' | 'pending' | 'failed';
export interface IngestReport {
  attempt_id: string;
  ingest_id: string;
  attempt: { extractor_version: string; model: string | null; created_at: string; resumed?: boolean };
  status: ReportStatus;
  complete: boolean;
  summary: string;
  storage: IngestStorage;
  source_page: { slug: string; status: ItemStatus; request_id?: string };
  report_page: string;
  visibility: 'world' | 'private';
  coverage: { chars_read: number; chars_total: number; windows_done: number; windows_total: number };
  spent_usd: number;
  max_usd: number;
  plan_basis?: 'keyless_candidates' | 'model';
  missing_capability?: { capability: 'chat'; why: string; check: string[] };
  pages: ReportPage[];
  facts: ReportFact[];
  write_requests: Array<{ slug: string; request_id: string; state: string }>;
  undo_window_days: number;
  failure?: ReportFailure;
  stop?: 'budget' | 'kill_switch' | 'interrupted' | 'provider';
  undo?: { state: 'undone'; at: string; retracted: number; deleted: number; skipped: number };
  actions: ReportAction[];
}

/** Failed beats pending beats incomplete beats complete. */
export function resolveStatus(parts: { failed: boolean; pending: boolean; incomplete: boolean }): ReportStatus {
  return parts.failed ? 'failed' : parts.pending ? 'pending' : parts.incomplete ? 'incomplete' : 'complete';
}

export function summarize(report: Pick<IngestReport, 'status' | 'pages' | 'facts' | 'coverage' | 'spent_usd'>): string {
  const count = (items: Array<{ status: ItemStatus }>, s: ItemStatus) => items.filter(i => i.status === s).length;
  const copies = report.facts.flatMap(f => f.copies);
  return [
    report.status === 'complete' ? 'Ingest complete' : report.status === 'pending' ? 'Ingest committed with writes pending'
      : report.status === 'failed' ? 'Ingest failed' : 'Ingest incomplete',
    ': ' + count(report.pages, 'created') + ' pages created, ' + count(report.pages, 'proposed') + ' proposed, ' + count(report.pages, 'existing') + ' existing; ',
    count(copies, 'created') + ' facts saved, ' + count(copies, 'support') + ' supporting saved facts, ' + report.facts.filter(f => f.status === 'skipped').length + ' skipped; ',
    'read ' + report.coverage.chars_read + ' of ' + report.coverage.chars_total + ' characters; spent $' + report.spent_usd.toFixed(4) + '.',
  ].join('');
}

/** An action the caller runs itself when its surface can call the op, otherwise one the user runs from the CLI. */
export function reportAction(ctx: Pick<OperationContext, 'remote' | 'isCallable'>, a: Omit<ReportAction, 'next'> & { ownerOnly?: boolean }): ReportAction {
  const { ownerOnly, ...rest } = a;
  const callable = ctx.remote === false || (!ownerOnly && !!a.mcp && ctx.isCallable?.(a.mcp.tool) !== false);
  return callable ? { next: 'run', ...rest, ...(ctx.remote === false ? { mcp: undefined } : {}) } : { next: 'tell_user_to_run', ...rest, mcp: undefined };
}

export function reportActions(ctx: Pick<OperationContext, 'remote' | 'isCallable'>, state: IngestAttemptState, report: IngestReport): ReportAction[] {
  const id = state.attempt_id;
  const out: ReportAction[] = [];
  const proposed = report.pages.filter(p => p.status === 'proposed').map(p => p.slug);
  if (proposed.length) out.push(reportAction(ctx, { kind: 'approve_proposed', ownerOnly: true,
    argv: ['gbrain', 'extraction-review', 'promote', '--slugs', proposed.join(',')],
    why: 'Turns the proposed entity pages into real pages; only the brain owner decides this. Reject them with extraction-review reject instead.' }));
  if (!report.complete && report.status !== 'failed' || report.failure?.retryable) out.push(reportAction(ctx, { kind: 'resume',
    argv: ['gbrain', 'ingest', '--resume', '--file', '<document>'], mcp: { tool: 'ingest', arguments: { attempt_id: id, resume: true, content: '<document>' } },
    inputs: [{ name: 'document', how: 'the same document text this attempt read (its hash must match)' }],
    why: 'Continues from the stored windows under your current grants; finished windows are never paid for again.' }));
  out.push(reportAction(ctx, { kind: 'status', argv: ['gbrain', 'ingest-show', id], mcp: { tool: 'ingest', arguments: { attempt_id: id } },
    why: 'Shows this report again; read-only, no provider calls.' }));
  if (state.phase !== 'undone' && report.write_requests.length) out.push(reportAction(ctx, { kind: 'undo_preview',
    argv: ['gbrain', 'ingest-undo', id], mcp: { tool: 'ingest_undo', arguments: { attempt_id: id } },
    why: 'Previews what undo would retract (writes nothing) and returns the plan_hash the apply step needs.' }));
  return out;
}

/** The report as a caller may see it: pages it cannot read are withheld by slug, never named. */
export function filterReportForCaller(report: IngestReport, visible: (slug: string) => boolean): IngestReport {
  const pages = report.pages.map(p => p.slug && !visible(p.slug) ? { ...p, name: '[withheld]', slug: '[withheld]', near_names: undefined } : p);
  const facts = report.facts.map(f => f.copies.some(c => !visible(c.entity_slug)) ? { ...f, fact: '[withheld]', copies: f.copies.map(c => visible(c.entity_slug) ? c : { ...c, entity_slug: '[withheld]' }) } : f);
  return { ...report, pages, facts, write_requests: report.write_requests.filter(w => visible(w.slug)) };
}

const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Ownership evidence, written as each item commits and read by undo after the journal retention lapses. */
export interface ReportEvidence {
  attempt_id: string;
  principal: string;
  source_id: string;
  source_slug: string;
  source_created: boolean;
  storage: IngestStorage;
  created_pages: Array<{ slug: string; request_id: string; revision: string | null; proposed: boolean }>;
  created_facts: Array<{ id: number; entity_slug: string; request_id: string }>;
  support_fact_ids: number[];
  status: ReportStatus;
  undone_at?: string;
}

export function reportPageContent(attemptId: string, visibility: 'world' | 'private', summary: string, evidence: ReportEvidence): string {
  return stringifyDataFrontmatter(summary + '\n', clean({
    type: INGEST_REPORT_TYPE,
    title: 'Ingest report ' + attemptId,
    dream_generated: true,
    facts_backstop: false,
    raw_trace_exempt: true,
    raw_trace_exempt_reason: 'ingest attempt record; provenance is the attempt id',
    ...(visibility === 'private' ? { visibility: 'private' } : {}),
    ingest: evidence,
  }));
}
