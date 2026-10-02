import type { BrainEngine } from '../../../core/engine.ts';
import type { PageReadScope } from '../../../core/types.ts';
import { probeProjectionReadiness } from '../../../core/search/projection-readiness.ts';
import type { PersistenceProjectionStatus } from '../../../core/persistence/ipc.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/repair.md#projection-drain';
const UNCHANGED = 'No repair or embedding was started by this check.';
const CODE_REPAIR = 'For code metadata repair, run `gbrain reindex-code --force --no-embed`. If work stays pending, inspect the recorded source path.';

/**
 * #5401: `resident` is true when the caller runs inside a PGLite resident (the
 * run_doctor operation on a serving process), where the drain command would
 * refuse; the resident drains the backlog itself.
 */
export async function checkProjectionReadiness(engine: BrainEngine, scope: PageReadScope = {}, opts: { resident?: boolean } = {}): Promise<Check> {
  const readiness = await probeProjectionReadiness(engine, scope);
  return {
    name: 'text_projection_readiness',
    status: readiness.ready ? 'ok' : 'warn',
    message: readiness.status === 'ready'
      ? 'Visible text projections match their canonical revisions.'
      : readiness.status === 'projection_pending'
        ? `Visible pages have missing or stale text projections; search and code results may be incomplete. ${opts.resident
          ? 'The resident gbrain process that holds this PGLite brain is rebuilding queued Markdown and code projections (up to 100 pages per pass, fewer while writes wait). On the brain host, `gbrain doctor` shows the pending count and how to drain faster.'
          : 'Run `gbrain projections drain` to rebuild queued Markdown and code projections now; it is safe while `gbrain serve` runs on Postgres.'} ${CODE_REPAIR} ${UNCHANGED}`
        : 'Text projection readiness is unknown because its read-only probe failed; index completeness could not be verified.',
    details: { readiness: readiness.status, ready: readiness.ready },
  };
}

/** The doctor text when a PGLite resident holds the datastore, from its projection_status reply (null: it gave none). */
export function residentProjectionReadiness(pid: number | undefined, status: PersistenceProjectionStatus | null, steps: string): Pick<Check, 'status' | 'message' | 'details'> {
  const owner = `The resident gbrain process${pid ? ` (pid ${pid})` : ''} holds this PGLite brain`;
  if (!status) {
    return {
      status: 'warn',
      message: `${owner} and did not report its projection backlog, so it may predate the faster projection drain. Restart it on the upgraded gbrain so it drains up to 100 pages per pass. ${steps}`,
      details: { readiness: 'unknown', ready: false, owner_pid: pid ?? null, docs: DOCS },
    };
  }
  const details = { readiness: status.pending ? 'projection_pending' : 'ready', ready: status.pending === 0, owner_pid: pid ?? null, ...status, docs: DOCS };
  if (status.pending === 0) return { status: 'ok', message: `${owner} and reports no queued text projections.`, details };
  const age = status.oldest_age_seconds === null ? '' : `; the oldest was queued ${status.oldest_age_seconds}s ago`;
  const failed = status.failed ? `; ${status.failed} last failed and are retried after 30 seconds` : '';
  return {
    status: 'warn',
    message: `${owner} and is draining ${status.pending} queued text projections${age}${failed}. Search and code results may be incomplete until it finishes; it rebuilds up to 100 pages per pass, fewer while writes wait. Re-run \`gbrain doctor\` to watch the count. ${steps} ${UNCHANGED}`,
    details,
  };
}

async function runProjectionResident(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  if (ctx.engine || ctx.fastMode) return checks;
  const { loadConfig } = await import('../../../core/config.ts');
  const { getCliOptions } = await import('../../../core/cli-options.ts');
  const { resolveBrainId } = await import('../../../core/brain-resolver.ts');
  const { loadMounts } = await import('../../../core/brain-registry.ts');
  const { persistenceConfigForBrain } = await import('../../../core/persistence/local-client.ts');
  const { inspectLockHolder } = await import('../../../core/pglite-lock.ts');
  const { persistenceSocketPathForConfig, requestPersistenceProjectionStatus } = await import('../../../core/persistence/ipc.ts');
  const { residentDrainSteps } = await import('../../projections.ts');
  let config: ReturnType<typeof persistenceConfigForBrain>;
  let brainId: string;
  try {
    brainId = resolveBrainId(getCliOptions().brain, process.cwd());
    config = persistenceConfigForBrain(loadConfig(), brainId, brainId === 'host' ? [] : loadMounts());
  } catch { return checks; }
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url) return checks;
  const holder = inspectLockHolder(config.database_path);
  if (!holder.held) return checks;
  const socketPath = persistenceSocketPathForConfig(config);
  let status: PersistenceProjectionStatus | null = null;
  if (socketPath) {
    try { status = await requestPersistenceProjectionStatus(socketPath); } catch { /* an older resident, or none listening */ }
  }
  checks.push({ name: 'text_projection_readiness', ...residentProjectionReadiness(holder.pid, status, residentDrainSteps(holder.pid, brainId)) });
  return checks;
}

/**
 * Filesystem-lane entry (#5401, E-T1): when the engine did not open because a
 * PGLite resident holds the datastore, ask that resident for its projection
 * backlog over the read-only persistence IPC op.
 */
export const projectionResidentEntry: DoctorEntry = {
  name: 'text_projection_readiness',
  emits: ['text_projection_readiness'],
  run: runProjectionResident,
};
