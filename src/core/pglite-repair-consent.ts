/**
 * The consent shape of `gbrain pglite-repair` (agent operator contract v1,
 * A4/C2), shared by the command itself and by the repair-failed gate in
 * `PGLiteEngine.connect()`: the same plan (data dir, WAL segments, stale
 * postmaster.pid) and plan_hash, so the fix the gate prints
 * (`gbrain pglite-repair --yes --expect <plan_hash>`) is exactly the command
 * the repair accepts once the user agrees.
 */
import { buildConsentRefusal, computePlanHash, type ConsentRefusal, type PlanSelection } from './consent.ts';
import { gbrainPath, loadConfig } from './config.ts';
import { HANDS_OFF_BRAIN_FILES, inspectPgliteDataDir, type RepairFailedMarker } from './pglite-repair.ts';

export const WAL_REPAIR_BACKUP_SUFFIX = '.wal-repair-backup-';

export const WAL_REPAIR_RISK = 'Data files are preserved; transactions not checkpointed before the corruption may be lost, and indexes are '
  + 'not rebuilt (run gbrain reindex --vectors afterwards). Before the reset the current pg_wal and postmaster.pid are moved, '
  + `and pg_control copied, into a sibling <data-dir>${WAL_REPAIR_BACKUP_SUFFIX}<timestamp> folder (or this incident's existing backup); nothing is deleted.`;

export { HANDS_OFF_BRAIN_FILES } from './pglite-repair.ts';

/** The diagnosed state an approval binds: the data dir, its WAL segments and the stale postmaster.pid. */
export function walRepairPlan(dataDir: string, d: { verdict: string; walSegments: string[]; postmasterPid: unknown }): { selection: PlanSelection; plan_hash: string } {
  const selection: PlanSelection = {
    brain: dataDir, source: null, operation: 'pglite-repair',
    records: [...d.walSegments.map(id => ({ id: `pg_wal/${id}` })), ...(d.postmasterPid ? [{ id: 'postmaster.pid' }] : [])],
    parameters: { verdict: d.verdict }, effects: ['destructive'],
  };
  return { selection, plan_hash: computePlanHash(selection) };
}

/** `--path <dir>` only when the brain is not the configured one, so the fix acts on this brain from anywhere. */
function pathArgs(dataDir: string): string[] {
  let configured: string | null = null;
  try {
    const cfg = loadConfig();
    configured = cfg?.engine === 'pglite' ? cfg.database_path || gbrainPath('brain.pglite') : null;
  } catch { configured = null; }
  return configured === dataDir ? [] : ['--path', dataDir];
}

/**
 * The refusal every brain-opening command gets while the repair-failed marker
 * is set: exit 3, effects `destructive`, the consented repair as the fix
 * (rendered `ask_user` on the CLI, `tell_user_to_run` over MCP) and its
 * read-only `--dry-run` preview. Reads the data dir; never writes it.
 */
export function repairFailedRefusal(dataDir: string, marker: RepairFailedMarker, detail?: string, diagnostic?: string): ConsentRefusal {
  const diagnosis = inspectPgliteDataDir(dataDir);
  const plan = walRepairPlan(dataDir, diagnosis);
  const path = pathArgs(dataDir);
  const when = marker.ts ? ` on ${new Date(marker.ts).toISOString()}` : '';
  const backup = marker.backup_path ? ` The automatic attempt's backup is at ${marker.backup_path}.` : '';
  const e = buildConsentRefusal({
    command: 'pglite-repair',
    effects: ['destructive'],
    actor: 'agent',
    what: `Opening the damaged PGLite brain at ${dataDir}`,
    why: `gbrain's automatic WAL repair of this brain failed${when} (${marker.repair}${detail || marker.detail ? `: ${(detail ?? marker.detail)!.split('\n')[0]}` : ''}), `
      + `so every command now refuses to open it and nothing writes to it until the user decides how to recover.${backup} ${HANDS_OFF_BRAIN_FILES}`,
    risk: `The repair rewrites the brain's write-ahead log. ${WAL_REPAIR_RISK} If the damage is in the catalog, WAL repair may not be enough; `
      + 'the other recoveries (restoring a backup the user has, or `gbrain reinit-pglite`, which rebuilds the brain and can lose database-only pages and facts) are also the user\'s decision.',
    user_message: `Your gbrain brain at ${dataDir} is damaged and gbrain's automatic repair did not fix it, so gbrain has stopped opening it to keep it from getting worse. `
      + 'I can run gbrain\'s repair (it keeps a backup, but changes from just before the crash may be lost), or you can restore it from a backup you have. '
      + 'I won\'t copy, move or edit the brain files myself. Which do you want?',
    argv: ['gbrain', 'pglite-repair', ...path],
    preview_argv: ['gbrain', 'pglite-repair', ...path, '--dry-run', '--json'],
    plan_hash: plan.plan_hash,
    args: [],
  });
  (e as ConsentRefusal & { reason?: string }).reason = 'pglite_repair_failed';
  // The open that just failed keeps its full init diagnostic on the thrown error (the CLI renders the payload).
  if (diagnostic) e.message = `${diagnostic}\n\n${e.message}`;
  return e;
}

export function isRepairFailedRefusal(e: unknown): e is ConsentRefusal {
  return (e as { reason?: unknown } | null)?.reason === 'pglite_repair_failed' && (e as { code?: unknown }).code === 'confirmation_required';
}
