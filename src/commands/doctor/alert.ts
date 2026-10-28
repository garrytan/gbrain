/**
 * W4: the doctor's alert verdict (`DoctorReport.alert`), what an agent cron
 * pages on instead of `health_score`.
 *
 * Only the page class pages (PAGE_CHECK_LEVELS in src/core/doctor-categories.ts):
 *   - act: a page-class check reported its paging status; each item keeps the
 *     check's own rendered fix (argv or MCP call, consent, actor, verify).
 *   - unknown: a page-class check did not run fresh in this run (over its
 *     budget, stopped at a bound, errored, served from its last known result,
 *     skipped by the tier, or the database checks did not run). Each item names
 *     the check, the budget it ran under and the command that measures it.
 *   - none: every page-class check ran fresh and none pages.
 * act dominates unknown, which dominates none; both item lists are kept.
 *
 * gbrain doctor --alert runs the page class alone (the alert tier: every
 * page-class entry, fresh, under ALERT_BUDGET_MS_DEFAULT), so a healthy brain
 * reaches none on every run. It keeps a consecutive-unknown counter per brain
 * on the file plane (doctor-alert-state.json under GBRAIN_HOME) so a cron can
 * page on the second unknown in a row. A remote report omits check messages
 * (they can carry local paths) and gives a host-admin step where no MCP fix exists.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../../core/atomic-write.ts';
import { cliRenderContext, redactForTransport, renderAction, type RenderContext, type RenderedAction } from '../../core/agent-output.ts';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import { PAGE_CHECK_LEVELS, PAGE_CHECK_NAMES } from '../../core/doctor-categories.ts';
import { DOCTOR_ALERT_ACT_EXIT_CODE, DOCTOR_ALERT_UNKNOWN_EXIT_CODE } from '../../core/exit-codes.ts';
import type { Check, DoctorReport } from '../doctor.ts';
import { fixLine } from './check-fix.ts';
import { writeJsonDocument } from '../../core/cli-force-exit.ts';
import { entryRunsAt } from './budget.ts';
import { agentFix, type FixUnavailableReason } from './check-fix.ts';
import type { DoctorTier } from './context.ts';
import { DOCTOR_CHECK_REGISTRY } from './registry.ts';

export type AlertLevel = 'none' | 'act' | 'unknown';
export type AlertUnknownReason = 'budget' | 'bound' | 'errored' | 'last_known' | 'not_run';

export interface AlertActItem {
  /** Stable: the check's own details.code when it has one, else the check name. */
  code: string;
  check: string;
  status: 'warn' | 'fail';
  /** The check's message; omitted on a remote report (it can name local paths). */
  message?: string;
  docs: string;
  fix?: RenderedAction;
  fix_unavailable_reason?: FixUnavailableReason;
}

export interface AlertUnknownItem {
  code: 'doctor_alert_unknown';
  check: string;
  reason: AlertUnknownReason;
  /** The budget the check ran under, when a budget stopped it. */
  budget_ms: number | null;
  message: string;
  /** Measures this check fresh (with a larger budget when a budget stopped it). */
  fix: RenderedAction;
  /** Set by doctor --alert: how many alert runs in a row (this one included) ended unknown. */
  consecutive_unknown_runs?: number;
}

export interface DoctorAlert {
  level: AlertLevel;
  items: AlertActItem[];
  unknown: AlertUnknownItem[];
  /** Set by doctor --alert: alert runs in a row ending unknown (0 after a none or act run); null when the state file can be neither read nor written. */
  consecutive_unknown?: number | null;
  docs: string;
}

/** The alert tier's default end-to-end budget (connect included); --budget-ms overrides it. */
export const ALERT_BUDGET_MS_DEFAULT = 30_000;
export const ALERT_DOCS = 'docs/guides/troubleshooting.md#doctor-alert';
const STATE_FILE = 'doctor-alert-state.json';

/** The arguments --alert runs with: the page class alone (unless --tier / --only is given) under the alert budget, skill checks skipped. */
export function alertRunArgs(args: readonly string[]): string[] {
  const has = (flag: string) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  const out = [...args];
  if (!has('--tier') && !has('--only')) out.push('--only', [...PAGE_CHECK_NAMES].join(','));
  if (!has('--budget-ms')) out.push('--budget-ms', String(ALERT_BUDGET_MS_DEFAULT));
  if (!args.includes('--scope=brain')) out.push('--scope=brain');
  return out;
}

/**
 * The page-class checks this run executed: none when the database checks did not run (no connection check that is
 * ok), else every page-class check whose entry runs at tier. A page-class check missing from such a run did not apply.
 */
export function alertRanChecks(checks: readonly Pick<Check, 'name' | 'status'>[], tier: DoctorTier): Set<string> {
  if (!checks.some((c) => c.name === 'connection' && c.status === 'ok')) return new Set();
  return new Set([...PAGE_CHECK_NAMES].filter((name) => DOCTOR_CHECK_REGISTRY.some((e) => e.emits.includes(name) && entryRunsAt(e.tier, tier))));
}

function unknownReason(c: Check): AlertUnknownReason | null {
  if (c.details?.last_known !== undefined) return 'last_known';
  if (c.details?.health === 'unknown') return c.details.reason === 'budget' ? 'budget' : c.details.reason === 'bound' ? 'bound' : 'errored';
  if (c.fix_unavailable_reason === 'check_errored') return 'errored';
  if (c.readiness_state === 'unknown' && c.status !== 'fail') return 'not_run';
  return null;
}

function pages(c: Check): boolean {
  return c.status === 'fail' || (c.status === 'warn' && PAGE_CHECK_LEVELS.get(c.name) === 'warn');
}

function isRendered(fix: Check['fix']): fix is RenderedAction {
  return !!fix && typeof (fix as RenderedAction).next === 'string';
}

const UNKNOWN_WHY: Record<AlertUnknownReason, string> = {
  budget: 'did not finish within its budget',
  bound: 'stopped at one of its own bounds before reading everything',
  errored: 'could not be checked',
  last_known: 'was reported from its last known result, not measured in this run',
  not_run: 'did not run (the database checks did not run, or this tier or report skips it)',
};

/**
 * The alert verdict of a finalized check list (computeDoctorReport calls it after rendering fixes). ran: the
 * page-class checks this run executed, so one it did not emit did not apply; without it a missing page-class check
 * is unknown (a focused or remote report that never runs it).
 */
export function computeAlert(checks: readonly Check[], opts: { ran?: ReadonlySet<string>; render?: RenderContext } = {}): DoctorAlert {
  const render = opts.render ?? cliRenderContext();
  const remote = render.transport !== 'cli';
  const items: AlertActItem[] = [];
  const unknown: AlertUnknownItem[] = [];
  for (const name of PAGE_CHECK_NAMES) {
    const found = checks.filter((c) => c.name === name);
    if (found.length === 0) {
      if (!opts.ran?.has(name)) unknown.push(unknownItem(name, 'not_run', null, render));
      continue;
    }
    const paging = found.find((c) => unknownReason(c) === null && pages(c));
    const stale = found.find((c) => unknownReason(c) !== null);
    if (paging) items.push(actItem(paging, remote, render));
    else if (stale) unknown.push(unknownItem(name, unknownReason(stale)!, stale, render));
  }
  const level: AlertLevel = items.length ? 'act' : unknown.length ? 'unknown' : 'none';
  const alert: DoctorAlert = { level, items, unknown, docs: ALERT_DOCS };
  return remote ? redactForTransport(alert, 'http') : alert;
}

function actItem(c: Check, remote: boolean, render: RenderContext): AlertActItem {
  const code = typeof c.details?.code === 'string' ? c.details.code : c.name;
  const docs = typeof c.details?.docs === 'string' ? c.details.docs : `${ALERT_DOCS}-act`;
  const fix = isRendered(c.fix) ? c.fix : remote
    ? renderAction({ argv: ['gbrain', 'doctor', '--only', c.name, '--json'], consent: [], actor: 'host_admin', requires_exclusive: false, docs,
      why: `Run on the brain host: the local report says what ${c.name} found and how to fix it.` }, render)
    : undefined;
  return {
    code, check: c.name, status: c.status as 'warn' | 'fail',
    ...(remote ? {} : { message: c.message }),
    docs,
    ...(fix ? { fix } : { fix_unavailable_reason: c.fix_unavailable_reason ?? 'unstructured' }),
  };
}

function unknownItem(name: string, reason: AlertUnknownReason, c: Check | null, render: RenderContext): AlertUnknownItem {
  const budgetMs = typeof c?.details?.budget_ms === 'number' ? c.details.budget_ms : null;
  const fix = reason === 'budget' && isRendered(c?.fix) ? c!.fix as RenderedAction
    : renderAction(agentFix(['gbrain', 'doctor', '--only', name, '--budget-ms', '0', '--json'],
      'Measures only this check now, with no overall budget; read-only.', name, { docs: ALERT_DOCS }), render);
  const budget = budgetMs !== null ? ` (budget ${budgetMs} ms)` : '';
  const step = fix.command ?? (fix.mcp ? `the ${fix.mcp.tool} tool` : 'the fix');
  return {
    code: 'doctor_alert_unknown', check: name, reason, budget_ms: budgetMs,
    message: `${name} ${UNKNOWN_WHY[reason]}${budget}, so its health is unknown, not clear. Measure it with ${step}, `
      + 'run the full tier (gbrain doctor --alert --tier standard --json) or raise the alert budget (--budget-ms).',
    fix,
  };
}

/** The brain this home's alert state is kept for: a hash of its database URL or path, never the value itself. */
function brainKey(): string {
  let id = 'default';
  try {
    const cfg = loadConfig();
    id = cfg?.database_url ?? cfg?.database_path ?? 'default';
  } catch { /* unreadable config: one shared key */ }
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

/**
 * doctor --alert: count this run into the brain's consecutive-unknown streak (reset by a none or act run), stamp the
 * count on the alert and its unknown items, and persist it atomically. A home that cannot be written (read-only)
 * still gets this run's count from what it read; null only when it could neither read nor write the state.
 */
export function recordAlertStreak(alert: DoctorAlert, now = new Date()): DoctorAlert {
  const path = gbrainPath(STATE_FILE);
  type BrainState = { consecutive_unknown: number; last_level: AlertLevel; updated_at: string };
  let brains: Record<string, BrainState> = {};
  let readable = true;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed.brains === 'object' && parsed.brains) brains = parsed.brains;
  } catch (err) {
    readable = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
  const key = brainKey();
  const prev = Number(brains[key]?.consecutive_unknown ?? 0);
  const count = alert.level === 'unknown' ? (Number.isSafeInteger(prev) && prev > 0 ? prev : 0) + 1 : 0;
  brains[key] = { consecutive_unknown: count, last_level: alert.level, updated_at: now.toISOString() };
  let written = true;
  try {
    atomicWriteFileSync(path, JSON.stringify({ schema_version: 1, brains }, null, 2) + '\n', { mode: 0o600 });
  } catch {
    written = false;
  }
  if (!readable && !written) return { ...alert, consecutive_unknown: null };
  return {
    ...alert,
    consecutive_unknown: count,
    unknown: alert.unknown.map((u) => ({ ...u, consecutive_unknown_runs: count, message: `${u.message} Unknown for ${count} consecutive alert run(s).` })),
  };
}

/** The exit status of a doctor --alert run: 0 none, 17 act, 18 unknown. */
export function alertExitCode(level: AlertLevel): number {
  return level === 'act' ? DOCTOR_ALERT_ACT_EXIT_CODE : level === 'unknown' ? DOCTOR_ALERT_UNKNOWN_EXIT_CODE : 0;
}

/** `gbrain doctor --alert`: print the verdict (with this brain's consecutive-unknown count) and return the exit code. */
export function printAlertReport(report: DoctorReport, json: boolean): number {
  const alert = recordAlertStreak(report.alert!);
  if (json) {
    void writeJsonDocument(JSON.stringify({ ...report, alert }));
    return alertExitCode(alert.level);
  }
  const streak = alert.level === 'unknown' && alert.consecutive_unknown ? ` (${alert.consecutive_unknown} consecutive unknown run(s))` : '';
  console.log(`Alert: ${alert.level}${streak}`);
  for (const item of alert.items) {
    console.log(`  [ACT] ${item.check}: ${item.message ?? item.code}`);
    const fix = fixLine(item.fix);
    if (fix) console.log(`    Fix: ${fix}`);
  }
  for (const item of alert.unknown) console.log(`  [UNKNOWN] ${item.check}: ${item.message}`);
  console.log(`Health score: ${report.health_score}/100 (context only; page on the alert level).`);
  return alertExitCode(alert.level);
}
