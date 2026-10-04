/**
 * Doctor checks speak the agent operator contract (agent-first operator wave,
 * Lane E1/E2): every non-ok check carries a `fix` (Action) or a
 * `fix_unavailable_reason`, the generic "Could not check X" sites go through
 * `checkError()`, and a capability that is off by choice or not applicable is
 * reported `ok` + `severity: 'info'` + `readiness_state` with the enable
 * command as `fix` (information, never coaching).
 *
 * Stored checks carry `Action`; `finalizeCheckFixes` renders them for the
 * report's transport (CLI `gbrain doctor --json`, MCP `run_doctor`).
 */
import { cliRenderContext, redactForTransport, renderAction, type Action, type RenderContext, type RenderedAction } from '../../core/agent-output.ts';
import { embeddingEnablement, type ReadinessEntry, type ReadinessState } from '../../core/readiness.ts';
import { loadConfig } from '../../core/config.ts';
import { classifyPgAccessError } from '../../core/pg-access-classify.ts';
import { brainRoutingArgs } from '../../core/brain-resolver.ts';
import { repairForCheck } from '../../core/repair/registry.ts';
import type { Check } from '../doctor.ts';

/**
 * Why a non-ok check has no runnable `fix`:
 * - `check_errored`: the probe itself failed, so there is nothing to repair yet (message carries the error).
 * - `operator_judgement`: the finding needs a human decision about the data; the message explains it.
 * - `no_safe_automatic_fix`: a fix exists only as a manual, case-by-case repair.
 * - `unstructured`: legacy check whose guidance is still prose in `message` (shrinking; see check-fix tests).
 */
export type FixUnavailableReason = 'check_errored' | 'operator_judgement' | 'no_safe_automatic_fix' | 'unstructured';

/** Agent-contract fields every doctor Check may carry (additive; schema_version stays 2). */
export interface CheckAgentFields {
  /** Stored as an Action; rendered (RenderedAction: `next`, `command`, absolute `docs`) in reports. */
  fix?: Action | RenderedAction;
  fix_unavailable_reason?: FixUnavailableReason;
  /** `info`: status stays `ok`; the capability is off by choice or not applicable (readiness_state says which). */
  severity?: 'info';
  readiness_state?: ReadinessState;
}

interface CheckLike extends CheckAgentFields {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  details?: Record<string, unknown>;
}

/** The read-only verification every doctor fix points at. */
export function doctorVerify(check: string): { argv: string[] } {
  return { argv: ['gbrain', 'doctor', '--only', check, '--json'] };
}

/** A gbrain command the agent may run with no consent (read-only or a reversible local repair). */
export function agentFix(argv: string[], why: string, verifyCheck: string, extra: Partial<Action> = {}): Action {
  return { argv, consent: [], actor: 'agent', why, verify: doctorVerify(verifyCheck), requires_exclusive: false, ...extra };
}

/**
 * A low brain score's next step: the read-only remediation plan, which names
 * the job and repair steps that raise each score component, their cost, and
 * the highest score this brain can reach (a keyless brain's embed share stays 0).
 */
export function brainScorePlanFix(): Action {
  return agentFix(['gbrain', 'doctor', '--remediation-plan', '--json', ...brainRoutingArgs()],
    'The plan lists which steps raise each score component, what they cost and the reachable maximum; it changes nothing.', 'brain_score');
}

/**
 * Information, not a problem: status `ok`, `severity: 'info'`. Use for a
 * capability that is `disabled_by_choice` or `not_applicable` (keyless brain,
 * empty brain, no serve running). `fix` is the enable command, if any.
 */
export function infoCheck(name: string, message: string, state: ReadinessState, fix?: Action, details?: Record<string, unknown>): Check {
  return {
    name, status: 'ok' as const, message, severity: 'info' as const, readiness_state: state,
    ...(fix ? { fix } : {}), ...(details ? { details } : {}),
  };
}

/**
 * The one embedding-enable command (A7 `embeddingEnablement`: resolved
 * datastore, a keyed provider, pages and facts kept) for doctor checks on a
 * keyless brain. Undefined when there is no readable config.
 */
export function keylessEnablementFix(): Action | undefined {
  try {
    const cfg = loadConfig();
    return cfg ? embeddingEnablement(cfg) : undefined;
  } catch {
    return undefined;
  }
}

/** A readiness entry rendered as a doctor info check (keeps its why and enable fix). */
export function readinessInfoCheck(name: string, entry: ReadinessEntry, message?: string): Check {
  return infoCheck(name, message ?? entry.why, entry.state, entry.fix);
}

/**
 * The one shape for "this check could not run": `warn`, the original
 * `Could not <what>: <error>` message, and either a DB-access fix (when the
 * error classifies as a database access problem) or
 * `fix_unavailable_reason: 'check_errored'`.
 */
export function checkError(name: string, what: string, err?: unknown, opts: { status?: 'warn' | 'fail'; details?: Record<string, unknown> } = {}): Check {
  const msg = err === undefined ? '' : err instanceof Error ? err.message : String(err);
  const message = msg ? `Could not ${what}: ${msg}` : `Could not ${what}`;
  let fix: Action | undefined;
  if (err !== undefined) {
    try {
      const d = classifyPgAccessError(err);
      if (d.reason !== 'unknown') {
        fix = agentFix(['gbrain', 'db-repair'], `The database refused the check (${d.reason}). \`gbrain db-repair\` diagnoses it without changing anything.`, name,
          { docs: 'docs/ENGINES.md#engine-detection-and-access-repair' });
      }
    } catch { /* classification is best-effort */ }
  }
  return {
    name, status: opts.status ?? 'warn', message,
    ...(fix ? { fix } : { fix_unavailable_reason: 'check_errored' as const }),
    ...(opts.details ? { details: opts.details } : {}),
  };
}

function isRendered(fix: Action | RenderedAction): fix is RenderedAction {
  return typeof (fix as RenderedAction).next === 'string';
}

/**
 * Report-time pass: render every stored `fix` for the caller's transport
 * (redacted on http: no local paths, PIDs or key names) and
 * mark any non-ok check that still has neither a fix nor a reason as
 * `unstructured` (its message is the guidance).
 */
export function finalizeCheckFixes<T extends CheckLike>(checks: readonly T[], render: RenderContext = cliRenderContext()): T[] {
  return checks.map((check) => {
    const c = render.transport === 'cli' ? withRepairPreviewFix(check) : check;
    if (c.fix) return isRendered(c.fix) ? c : { ...c, fix: redactForTransport(renderAction(c.fix, render), render.transport) };
    if (c.status === 'ok' || c.fix_unavailable_reason) return c;
    return { ...c, fix_unavailable_reason: 'unstructured' as const };
  });
}

/**
 * E1: a repairable finding on the local doctor carries its next step: the
 * read-only `gbrain repair <kind>` preview, which lists what the repair would
 * change and prints the exact apply command for the user to approve.
 */
function withRepairPreviewFix<T extends CheckLike>(check: T): T {
  if (check.status === 'ok' || check.fix || check.details?.health === 'unknown') return check;
  const kind = repairForCheck(check.name)?.kind;
  if (!kind) return check;
  return { ...check, fix: agentFix(['gbrain', 'repair', kind], 'Previews the repair without changing anything and prints the exact apply command; applying rewrites stored records, so ask the user first.', check.name) };
}

/** One-line human rendering of a check's fix (`Fix: <command>` / tool call), or null. */
export function fixLine(fix: CheckAgentFields['fix']): string | null {
  if (!fix) return null;
  const r = isRendered(fix) ? fix : renderAction(fix, cliRenderContext());
  const step = r.command ?? (r.mcp ? `${r.mcp.tool} ${JSON.stringify(r.mcp.arguments)}` : null);
  if (!step) return r.user_message ? `Ask the user: ${r.user_message}` : null;
  return r.next === 'run' ? step : `${step}  (${r.next.replace(/_/g, ' ')})`;
}

/**
 * E10: categories whose score is not evidence because their checks never ran.
 * When the `connection` check is present and not ok, no database check ran, so
 * a `brain` score of 100 would read as "healthy" — it is unknown.
 */
export function unknownScoreCategories(checks: readonly CheckLike[]): Array<'brain'> {
  const conn = checks.find((c) => c.name === 'connection');
  return conn && conn.status !== 'ok' ? ['brain'] : [];
}
