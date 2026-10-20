/**
 * legacy_job_authority (#5157, DX-O3(a)): the claim gate's population, read
 * with the gate's own predicate (`UNREVIEWED_LIVE_JOBS_WHERE`) so the two counts
 * never drift. Live rows whose authority is SQL NULL (authorizable with
 * `gbrain jobs authorize-legacy --select`) or unsupported non-NULL block
 * every worker, so the check fails and names the recovery order. Terminal
 * keyed SQL NULL rows are reported separately: application callers coalesce
 * onto completed or failed ones and dead or cancelled keys are released on
 * resubmission, so they need no operator step.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { ERROR_CATALOGUE } from '../../../core/error-catalogue.ts';
import { LIVE_LEGACY_PREVIEW, legacyRecoveryHint } from '../../../core/minions/legacy-selection.ts';
import { UNREVIEWED_LIVE_JOBS_WHERE, parseSubmissionAuthority } from '../../../core/minions/submission-authority.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export interface LegacyJobAuthorityState {
  /** Live rows with SQL NULL authority, by status. */
  authorizable: Record<string, number>;
  /** Live rows whose non-NULL authority is unsupported (first 10 ids). */
  unsupported_ids: number[];
  unsupported: number;
  /** Every active job (first 10 ids): legacy review needs none. */
  active_ids: number[];
  /** Terminal keyed SQL NULL rows, by status. */
  terminal_keyed: Record<string, number>;
}

export async function readLegacyJobAuthority(engine: BrainEngine): Promise<LegacyJobAuthorityState> {
  const live = (await engine.executeRaw<{ id: number; status: string; submission_authority: unknown; legacy_authority_is_null: boolean }>(
    `SELECT id, status, submission_authority, submission_authority IS NULL AS legacy_authority_is_null
       FROM minion_jobs WHERE ${UNREVIEWED_LIVE_JOBS_WHERE} ORDER BY id`))
    .filter(row => !parseSubmissionAuthority(row.submission_authority));
  const authorizable: Record<string, number> = {};
  for (const row of live) if (row.legacy_authority_is_null === true) authorizable[row.status] = (authorizable[row.status] ?? 0) + 1;
  const unsupported = live.filter(row => row.legacy_authority_is_null !== true);
  const active = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE status = 'active' ORDER BY id LIMIT 10");
  const terminal = await engine.executeRaw<{ status: string; count: number | string }>(
    `SELECT status, count(*) AS count FROM minion_jobs
      WHERE submission_authority IS NULL AND idempotency_key IS NOT NULL
        AND status IN ('completed','failed','dead','cancelled')
      GROUP BY status ORDER BY status`);
  return {
    authorizable,
    unsupported_ids: unsupported.slice(0, 10).map(row => Number(row.id)),
    unsupported: unsupported.length,
    active_ids: active.map(row => Number(row.id)),
    terminal_keyed: Object.fromEntries(terminal.map(row => [row.status, Number(row.count)])),
  };
}

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((n, c) => n + c, 0);

export interface QueuedSpendState {
  /** Queued paid jobs by spend basis (NULL rows of consent-gated producers count as `legacy_default`: the claim stamps them). */
  by_basis: Record<string, number>;
  /** Spend-authorized rows waiting longer than FENCED_ROW_WAIT_MS (first 10 ids). */
  long_waiting_ids: number[];
  long_waiting: number;
}

/** The informational spend-basis census plus the long-waiting fenced rows, read-only. */
export async function readQueuedSpend(engine: BrainEngine): Promise<QueuedSpendState> {
  const { paidJobNames } = await import('../../jobs/shared.ts');
  const { FENCED_ROW_WAIT_MS, LEGACY_SPEND_KEY_PREFIXES } = await import('../../../core/minions/spend-authorization.ts');
  const legacy = Object.entries(LEGACY_SPEND_KEY_PREFIXES)
    .map(([name, prefixes]) => `(name = '${name}' AND (${prefixes.map(p => `idempotency_key LIKE '${p}%'`).join(' OR ')}))`).join(' OR ');
  const rows = await engine.executeRaw<{ name: string; basis: string; n: number | string }>(
    `SELECT name, CASE WHEN spend_authorization IS NOT NULL THEN spend_authorization->>'kind'
                       WHEN ${legacy} THEN 'legacy_default' ELSE 'unrecorded' END AS basis, count(*) AS n
       FROM minion_jobs WHERE status IN ('waiting','delayed','paused','waiting-children')
      GROUP BY 1, 2`);
  const paid = new Set(await paidJobNames(rows.map(r => r.name)));
  const by_basis: Record<string, number> = {};
  for (const r of rows) if (paid.has(r.name)) by_basis[r.basis] = (by_basis[r.basis] ?? 0) + Number(r.n);
  const waiting = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE status = 'waiting' AND spend_authorization IS NOT NULL
        AND updated_at < now() - ($1::double precision * interval '1 millisecond') ORDER BY id`, [FENCED_ROW_WAIT_MS]);
  return { by_basis, long_waiting_ids: waiting.slice(0, 10).map(r => Number(r.id)), long_waiting: waiting.length };
}

export async function legacyJobAuthorityCheck(engine: BrainEngine): Promise<Check> {
  const state = await readLegacyJobAuthority(engine);
  const authorizable = sum(state.authorizable);
  const terminal = sum(state.terminal_keyed);
  const live = authorizable + state.unsupported;
  const details = { ...state, live, authorizable_total: authorizable, terminal_keyed_total: terminal, docs: ERROR_CATALOGUE.legacy_job_authority.docs };
  if (!live) {
    return {
      name: 'legacy_job_authority', status: 'ok', details,
      message: terminal
        ? `${terminal} finished job row(s) from before the upgrade still hold idempotency keys; resubmissions reuse completed or failed ones and release dead or cancelled ones, so no action is needed.`
        : 'No queued job predates submission authority.',
    };
  }
  const unsupported = state.unsupported
    ? ` ${state.unsupported} carry unsupported non-NULL authority: run matching application and database versions, or cancel them (${state.unsupported_ids.map(id => `gbrain jobs cancel ${id}`).join('; ')}).`
    : '';
  return {
    name: 'legacy_job_authority', status: 'fail', details,
    message: `${live} queued job(s) predate submission authority and block every worker (${authorizable} authorizable with SQL NULL authority, ${state.unsupported} unsupported). `
      + `${legacyRecoveryHint(state.active_ids)}${unsupported} See ${ERROR_CATALOGUE.legacy_job_authority.docs}.`,
  };
}

async function runLegacyJobAuthority(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  const { status, message, details } = await legacyJobAuthorityCheck(engine);
  const spend = await readQueuedSpend(engine).catch(() => null);
  // null: the worker registry is unreadable, so the live-worker count is unknown (never zero).
  let workers: number | null = 0;
  let registryFailure: { errno: string; path: string | null } | null = null;
  if (spend?.long_waiting) {
    const registry = await import('../../../core/minions/worker-registry.ts');
    try {
      workers = registry.readWorkers().length;
    } catch (e) {
      workers = null;
      registryFailure = registry.workerRegistryReadFailure(e);
    }
  }
  const census = spend && Object.keys(spend.by_basis).length
    ? ` Queued paid jobs by spend basis: ${Object.entries(spend.by_basis).map(([b, n]) => `${b} ${n}`).join(', ')}.` : '';
  if (status === 'ok' && spend?.long_waiting && workers !== null && workers > 0) {
    checks.push({ name: 'legacy_job_authority', status: 'warn', details: { ...details, queued_spend: spend, live_workers: workers },
      message: `${spend.long_waiting} spend-authorized job(s) (${spend.long_waiting_ids.join(', ')}) have waited over 10 minutes while ${workers} worker(s) run: `
        + `an un-upgraded worker may be fenced off; un-upgraded workers stop claiming at a fenced row. Upgrade gbrain on every worker host and restart the workers (gbrain jobs supervisor stop, then gbrain jobs supervisor start, or your service manager).${census}`,
      fix: { argv: ['gbrain', 'jobs', 'list', '--status', 'waiting', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows the waiting rows and their spend records; fenced rows run once every worker runs the upgraded binary.' } });
    return checks;
  }
  const unknownWorkers = registryFailure
    ? { live_workers: null, worker_registry_unreadable: true, worker_registry_errno: registryFailure.errno, worker_registry_path: registryFailure.path } : {};
  checks.push({ name: 'legacy_job_authority', status, message: `${message}${census}`, details: spend ? { ...details, queued_spend: spend, ...unknownWorkers } : details });
  return checks;
}

export const legacyJobAuthorityEntry: DoctorEntry = {
  name: 'legacy_job_authority',
  emits: ['legacy_job_authority'],
  run: runLegacyJobAuthority,
};

/** `gbrain post-upgrade` banner line when live legacy rows block workers (read-only commands only). */
export async function legacyJobAuthorityBannerNote(engine: BrainEngine): Promise<string | null> {
  const state = await readLegacyJobAuthority(engine);
  const authorizable = sum(state.authorizable);
  if (!authorizable && !state.unsupported) return null;
  return `legacy_job_authority: ${authorizable + state.unsupported} queued job(s) from before v0.50 block every worker. `
    + `Stop producers (gbrain serve, gbrain autopilot) and workers, cancel active jobs, then preview with: ${LIVE_LEGACY_PREVIEW}`
    + `${state.unsupported ? `; ${state.unsupported} unsupported row(s) need matching versions or gbrain jobs cancel <id>` : ''}. Recipe: ${ERROR_CATALOGUE.legacy_job_authority.docs}`;
}

/** `gbrain post-upgrade` banner line when queued paid jobs will run under the legacy default cap. */
export async function legacyDefaultSpendBannerNote(engine: BrainEngine): Promise<string | null> {
  const n = (await readQueuedSpend(engine)).by_basis.legacy_default ?? 0;
  if (!n) return null;
  return `spend: ${n} queued paid job(s) (book-mirror chapters or enrich runs) were queued before submit-time authorization and run under a $5 default cap each. `
    + 'To authorize a different amount, re-run the command that queued them with --max-usd <usd>; inspect them with: gbrain jobs list --status waiting --json';
}

