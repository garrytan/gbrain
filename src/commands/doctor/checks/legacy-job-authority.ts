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
  const { status, message, details } = await legacyJobAuthorityCheck(connectedEngine(ctx));
  checks.push({ name: 'legacy_job_authority', status, message, details });
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
