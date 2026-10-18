/**
 * #6803 (D1, D3): the extraction backlog as doctor's `links_extraction_lag`, the end-of-sync nudge and
 * `gbrain extract --stale` all report it. One statement reads the live page count, the actionable stale count
 * (attendance-blocked pages excluded: extraction cannot clear them) and the attendance-blocked count under a short
 * statement deadline; the mention-due read runs only when the mention pass is enabled. One verdict decides whether
 * doctor warns and the nudge prints, and one builder renders the default fix (plain `gbrain extract --stale`, the
 * cron default) plus the decision between both routes, with an estimate stated at its basis.
 */
import type { BrainEngine } from './engine.ts';
import { AGENT_TOOL_LIMIT_MS, type Action, type Decision } from './agent-output.ts';
import { cliRouting, pinRouting, type FixRouting } from './fix-routing.ts';
import { extractionLagStatement, heldLinkExtractionStatement } from './engine-sql/pages.ts';
import { effectiveLinkExtractorWatermark } from './link-extraction-watermark.ts';
import { previewMentionPass } from './mentions/stale.ts';
import { readMentionPolicy } from './mentions/policy.ts';
import { resolveEnvNumber, warnOnceForEnv } from './env-number.ts';
import { isMissingSchemaObject } from './utils.ts';
import { LINK_HOLD_THRESHOLD_RUNS, linkExtractionRetryFix } from './persistence/links-extraction-holds.ts';

/** Warn threshold (percent of live pages actionable-stale); `GBRAIN_EXTRACTION_LAG_WARN_PCT` overrides it. */
export const EXTRACTION_LAG_WARN_PCT_DEFAULT = 20;
/** Below this many live pages a brain-wide (unscoped) read is too small to grade. */
export const EXTRACTION_LAG_MIN_PAGES = 100;
/**
 * Wall-clock budget of one plain `gbrain extract --stale` run (default 30 min); `--catch-up` removes it.
 * The deferred-sweep submitters derive their job timeout from it.
 */
export const STALE_TIME_BUDGET_MS = Math.max(1000, Number(process.env.GBRAIN_EXTRACT_TIME_BUDGET_MS) || 30 * 60 * 1000);
/** Measured managed extraction throughput at 10 ms round-trip time (part-6 investigation); the estimates' basis. */
export const EXTRACTION_PAGES_PER_SECOND = 13.5;
export const EXTRACTION_ESTIMATE_BASIS = 'estimate at 10 ms RTT; measure your pooler RTT';

export interface ExtractionLag {
  total: number;
  /** Stale pages extraction can clear (attendance-blocked excluded). */
  actionable: number;
  attendance_blocked: number;
  /** GBRA-130 A-1: pages whose link extraction is held after repeated failures (excluded from `actionable`). */
  held?: number;
  /** Pages due for the mention pass; null when the pass is off. */
  mention_due: number | null;
  mention_last_pass_at: string | null;
}

export async function readExtractionLag(engine: BrainEngine, opts: { sourceId?: string; timeoutMs?: number } = {}): Promise<ExtractionLag> {
  const versionTs = await effectiveLinkExtractorWatermark(engine);
  const read = async (attendance: boolean, held: boolean) => {
    const { text, params } = extractionLagStatement({ sourceId: opts.sourceId, versionTs, attendance, held });
    return (await engine.executeRaw<{ total: number; stale: number; attendance_blocked: number; held: number }>(text, params, { timeoutMs: opts.timeoutMs ?? 10_000 }))[0];
  };
  let row;
  try { row = await read(true, true); } catch (e) {
    if (isMissingSchemaObject(e, 'column', 'links_extract_failure')) row = await read(true, false).catch(async inner => {
      if (!isMissingSchemaObject(inner, 'column', 'links_attendance_blocked_revision')) throw inner;
      return read(false, false);
    });
    else if (isMissingSchemaObject(e, 'column', 'links_attendance_blocked_revision')) row = await read(false, false);
    else throw e;
  }
  const mention = (await readMentionPolicy(engine)).enabled ? await previewMentionPass(engine, opts.sourceId) : null;
  return { total: Number(row?.total ?? 0), actionable: Number(row?.stale ?? 0), attendance_blocked: Number(row?.attendance_blocked ?? 0), held: Number(row?.held ?? 0),
    mention_due: mention ? mention.due : null, mention_last_pass_at: mention?.last_pass_at ?? null };
}

/**
 * GBRA-130 A-1: doctor's note for pages whose managed link extraction is held (failed
 * `LINK_HOLD_THRESHOLD_RUNS` runs in a row), naming the first five with their codes, and the fix that retries them
 * (`gbrain extract --stale [--source-id <id>] --retry-held`). Empty note and no fix when nothing is held.
 */
export async function heldExtractionReport(engine: BrainEngine, held: number, sourceId?: string): Promise<{ note: string; fix?: Action }> {
  if (!held) return { note: '' };
  const { text, params } = heldLinkExtractionStatement({ sourceId, versionTs: await effectiveLinkExtractorWatermark(engine), limit: 5 });
  const sample = (await engine.executeRaw<{ slug: string; source_id: string; code: string }>(text, params, { timeoutMs: 10_000 }))
    .map(row => `${row.source_id}:${row.slug} (${row.code})`);
  const fix = linkExtractionRetryFix(sourceId, true);
  return { fix, note: `. ${held} page(s) failed link extraction ${LINK_HOLD_THRESHOLD_RUNS} runs in a row and are held (${sample.join(', ')}${held > sample.length ? ', ...' : ''}); `
    + `fix the cause the code names, then run ${fix.argv!.join(' ')}` };
}

export interface ExtractionLagVerdict { status: 'ok' | 'warn' | 'fail'; skipped: boolean; pct: number; warn_pct: number; fail_pct: number | null }

/** Doctor warns, and the sync nudge prints, exactly when this says warn or fail. */
export function extractionLagVerdict(lag: Pick<ExtractionLag, 'total' | 'actionable'>, sourceId?: string): ExtractionLagVerdict {
  const warnPct = resolveEnvNumber('GBRAIN_EXTRACTION_LAG_WARN_PCT', EXTRACTION_LAG_WARN_PCT_DEFAULT, { unit: '%' });
  // Hard-fail is off unless GBRAIN_EXTRACTION_LAG_FAIL_PCT is set: a just-upgraded brain warns, it never breaks a cron gate.
  let failPct: number | null = null;
  const failRaw = process.env.GBRAIN_EXTRACTION_LAG_FAIL_PCT;
  if (failRaw !== undefined && failRaw !== '') {
    const n = Number(failRaw);
    if (Number.isFinite(n) && n > 0) failPct = n;
    else warnOnceForEnv('GBRAIN_EXTRACTION_LAG_FAIL_PCT', `[gbrain] Ignoring invalid GBRAIN_EXTRACTION_LAG_FAIL_PCT=${failRaw}; hard-fail stays disabled.`);
  }
  const skipped = lag.total === 0 || (lag.total < EXTRACTION_LAG_MIN_PAGES && !sourceId);
  const pct = lag.total ? (lag.actionable / lag.total) * 100 : 0;
  const status = skipped ? 'ok' : failPct !== null && pct > failPct ? 'fail' : pct > warnPct ? 'warn' : 'ok';
  return { status, skipped, pct, warn_pct: warnPct, fail_pct: failPct };
}

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export interface ExtractionRoute { id: 'plain' | 'catch_up'; argv: string[]; label: string; estimate_seconds: number; runs: number }

/**
 * The default fix (plain `gbrain extract --stale`: 30 minutes per run, resumes; the cron default), verified by the
 * scoped dry run, and one decision between both routes. A fix expected to outlast an agent tool call
 * (`AGENT_TOOL_LIMIT_MS`) is the user's (`host_admin` on a remote brain): `tell_user_to_run`. Option argv are pinned to
 * the selected brain (the CLI's routing unless given; none on a remote brain); a brain-wide run never gets a source
 * pinned onto it.
 */
export function extractionRoutes(lag: Pick<ExtractionLag, 'actionable'>, opts: { sourceId?: string; remote?: boolean; routing?: FixRouting } = {}): { fix: Action; decision: Decision; routes: ExtractionRoute[] } {
  const scope = opts.sourceId ? ['--source-id', opts.sourceId] : [];
  const selected = opts.routing ?? (opts.remote ? undefined : cliRouting());
  const routing = selected ? { ...(selected.brain ? { brain: selected.brain } : {}), ...(opts.sourceId ? { source: opts.sourceId } : {}) } : undefined;
  const catchUpSeconds = lag.actionable / EXTRACTION_PAGES_PER_SECOND;
  const runs = Math.max(1, Math.ceil((catchUpSeconds * 1000) / STALE_TIME_BUDGET_MS));
  const runMinutes = Math.round(STALE_TIME_BUDGET_MS / 60_000);
  const long = Math.min(catchUpSeconds * 1000, STALE_TIME_BUDGET_MS) > AGENT_TOOL_LIMIT_MS;
  const plainArgv = ['gbrain', 'extract', '--stale', ...scope];
  const catchUpArgv = ['gbrain', 'extract', '--stale', '--catch-up', ...scope];
  const routes: ExtractionRoute[] = [
    { id: 'plain', argv: pinRouting(plainArgv, routing), estimate_seconds: Math.ceil(catchUpSeconds), runs,
      label: `${lag.actionable} page(s): about ${runs} run(s) of up to ${runMinutes} min (${EXTRACTION_ESTIMATE_BASIS}); each run resumes where the last stopped (the cron default)` },
    { id: 'catch_up', argv: pinRouting(catchUpArgv, routing), estimate_seconds: Math.ceil(catchUpSeconds), runs: 1,
      label: `${lag.actionable} page(s): about ${duration(catchUpSeconds)} in one run (${EXTRACTION_ESTIMATE_BASIS}); finishes, safe to interrupt, each page commits alone` },
  ];
  const fix: Action = {
    argv: plainArgv, consent: [], actor: long ? (opts.remote ? 'host_admin' : 'user') : 'agent', requires_exclusive: false,
    why: `Derives links and timeline entries for ${lag.actionable} stale page(s); each run stops after ${runMinutes} minutes and the next resumes where it stopped; it changes no page content.`,
    ...(long ? { user_message: `Run on the brain host, in a terminal rather than an agent tool call: ${routes[0]!.argv.join(' ')} (${routes[0]!.label}), or ${routes[1]!.argv.join(' ')} (${routes[1]!.label}).` } : {}),
    verify: { argv: ['gbrain', 'extract', '--stale', '--dry-run', '--json', ...scope] },
    docs: 'docs/guides/troubleshooting.md#symptom-table',
  };
  const decision: Decision = {
    id: 'extraction_route', question: 'How should the link-extraction backlog finish?',
    options: routes.map(route => ({ id: route.id, label: `${route.argv.join(' ')}: ${route.label}`, argv: route.argv })),
    default: 'plain', default_reason: `Bounded runs fit cron and never hold the brain longer than ${runMinutes} minutes; the catch-up run finishes in one go.`,
  };
  return { fix, decision, routes };
}

/** The end-of-sync nudge's lines: the count doctor reports, then both commands with duration and resume text. */
export function extractionNudgeLines(lag: ExtractionLag, opts: { sourceId?: string; routing?: FixRouting } = {}): string[] {
  const { fix, routes } = extractionRoutes(lag, opts);
  const blocked = lag.attendance_blocked ? `; ${lag.attendance_blocked} more wait on unresolved attendees and are not counted` : '';
  const mentions = lag.mention_due ? `; ${lag.mention_due} page(s) await the mention pass` : '';
  const where = fix.actor === 'agent' ? '' : ' Run it on the brain host, not inside an agent tool call.';
  return [`[sync] ${lag.actionable} page(s) have un-extracted edges (doctor: links_extraction_lag${blocked}${mentions}). Two ways to finish:${where}`,
    ...routes.map(route => `[sync]   ${route.argv.join(' ')} — ${route.label}`)];
}

export interface StaleExtractionCounts { actionable: number; attendance_blocked: number; held: number; mention_due: number | null; complete: boolean }

/** The terminal counts `extract --stale` reports: done when `actionable` is 0 and, with mentions on, `mention_due` is 0. */
export async function staleExtractionCounts(engine: BrainEngine, sourceId?: string): Promise<StaleExtractionCounts> {
  const lag = await readExtractionLag(engine, { sourceId });
  return { actionable: lag.actionable, attendance_blocked: lag.attendance_blocked, held: lag.held ?? 0, mention_due: lag.mention_due,
    complete: lag.actionable === 0 && (lag.mention_due ?? 0) === 0 };
}

/** One human line for the counts; raw totals elsewhere in the report include blocked pages and are not a completion signal. */
export function formatStaleCounts(c: StaleExtractionCounts): string {
  return `Actionable: ${c.actionable} page(s) still need link/timeline extraction` +
    (c.attendance_blocked ? `; ${c.attendance_blocked} attendance-blocked page(s) wait on unresolved attendees (extraction cannot clear them)` : '') +
    (c.held ? `; ${c.held} held page(s) failed extraction ${LINK_HOLD_THRESHOLD_RUNS} runs in a row (gbrain extract --stale --retry-held retries them)` : '') +
    (c.mention_due === null ? '' : `; ${c.mention_due} page(s) due for the mention pass`) +
    (c.complete ? '. Extraction is complete (raw stale totals are not a completion signal).' : '. Raw stale totals include blocked pages; done when actionable is 0' + (c.mention_due === null ? '.' : ' and mention-due is 0.'));
}
