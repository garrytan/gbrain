/**
 * `gbrain pglite-repair --legacy-lock` (GBRA-130 C-3): the preview-first exit
 * for a legacy (pre-kernel) PGLite lock whose owner cannot be proven dead.
 * Engine-free and pre-connect, like the WAL repair it sits beside.
 *
 *   --dry-run   read-only: the verdict, the advisory evidence and the plan_hash.
 *   apply       takes the stable sibling kernel lock (no kernel-v1 process can be
 *               live while it is held), re-inspects under it, refuses a live
 *               holder, a network filesystem or one whose locality it cannot
 *               read (`legacy_lock_removal_refused`), asks for consent bound
 *               to the plan hash (`--yes --expect`), inspects again after
 *               consent (a holder or change that appeared while the prompt
 *               waited refuses; a changed plan refuses `preview_changed`), then
 *               moves the legacy dir aside and writes the kernel-v1 marker
 *               (core/pglite-legacy-lock.ts).
 */
import { shellQuote, type Action } from '../core/agent-output.ts';
import { currentExitCode, writeJsonDocument } from '../core/cli-force-exit.ts';
import { consentGate } from '../core/consent-cli.ts';
import type { ConsentEnv } from '../core/consent.ts';
import { opError, OperationError } from '../core/ops/contract.ts';
import { acquireKernelLockOnly, PgliteBusyError, releaseLock, type LockHandle } from '../core/pglite-lock.ts';
import { applyLegacyLockRemoval, inspectLegacyLock, type LegacyLockInspection, type LegacyLockProbe } from '../core/pglite-legacy-lock.ts';
import { writeCliError } from '../cli/cli-error.ts';

const RISK = 'The legacy lock folder is moved into a sibling <data-dir>.legacy-lock-removed-<timestamp> folder with a receipt and the exact restore command; nothing is deleted. '
  + 'If the old gbrain is in fact still running (in another container, PID namespace or on another host sharing this folder), two writers can corrupt the brain.';

const previewArgv = (dataDir: string) => ['gbrain', 'pglite-repair', '--legacy-lock', '--path', dataDir, '--dry-run', '--json'];
const applyArgv = (dataDir: string) => ['gbrain', 'pglite-repair', '--legacy-lock', '--path', dataDir];
const previewFix = (dataDir: string): Action => ({ argv: previewArgv(dataDir), consent: [], actor: 'agent', requires_exclusive: false,
  why: 'Read-only: shows the legacy lock, the advisory evidence and the current plan_hash.' });

function userMessage(i: LegacyLockInspection): string {
  const pid = i.legacy_lock.metadata?.pid, scan = i.evidence?.fd_scan;
  const seen = scan?.method !== 'proc' ? 'gbrain could not check which processes on this computer have the brain open'
    : `no process gbrain could inspect on this computer has the brain open${scan.uninspectable ? ` (${scan.uninspectable} processes of other users could not be inspected)` : ''}`;
  return `Your gbrain brain at ${i.data_dir} has a lock left by an older gbrain${pid ? ` (process ${pid})` : ''} that gbrain cannot prove has stopped. `
    + `As far as this computer can tell, ${seen}, but that check cannot see other containers or other computers that share this folder. `
    + 'If no older gbrain is running anywhere that can reach this folder, I can move the stale lock aside (it is kept, not deleted) so gbrain can open the brain. Should I?';
}

function emit(doc: unknown): void { void writeJsonDocument(JSON.stringify(doc)); }
function emitText(doc: string): void { void writeJsonDocument(doc.trimEnd()); }

function printPreview(i: LegacyLockInspection, json: boolean): number {
  const { selection: _selection, ...shown } = i;
  const apply = i.removable && i.plan_hash ? [...applyArgv(i.data_dir), '--yes', '--expect', i.plan_hash] : null;
  if (json) {
    emit({ status: 'ok', action: 'dry-run', ...shown, ...(apply ? { apply_argv: apply, risk: RISK, user_message: userMessage(i) } : {}) });
    return 0;
  }
  const lock = i.legacy_lock, ev = i.evidence;
  console.log(`PGLite data dir: ${i.data_dir}`);
  console.log(`  Legacy lock: ${lock.verdict}${lock.reason ? ` (${lock.reason})` : ''}${lock.metadata?.pid ? `, recorded PID ${lock.metadata.pid}` : ''}`);
  if (ev) {
    console.log(`  kill -0: ${ev.pid_alive === null ? 'no PID recorded' : ev.pid_alive ? `running (${ev.pid_command ?? 'command unreadable'})` : 'not running here'}`);
    console.log(`  Open-file scan: ${ev.fd_scan.method === 'unavailable' ? 'unavailable on this platform' : `${ev.fd_scan.holders.length} holder(s)${ev.fd_scan.uninspectable ? `, ${ev.fd_scan.uninspectable} process(es) not inspectable` : ''}`}`);
    console.log(`  Filesystem: ${ev.filesystem.type ?? 'not checked'}`);
    console.log(`  ${ev.scope}`);
  }
  if (i.refusal) console.log(`  Removable: NO (${i.refusal.reason}): ${i.refusal.message}`);
  else if (apply) console.log(`  Removable: yes. ${RISK}\n  The removal is the user's decision. Once they agree: ${shellQuote(apply)}`);
  else console.log('  Nothing to do: no legacy lock blocks this data dir.');
  return 0;
}

function refuse(i: LegacyLockInspection, json: boolean): number {
  const refusal = i.refusal!;
  const hint = refusal.reason === 'filesystem_unverified'
    ? 'If the folder is on a network or shared mount, stop every gbrain on every host that mounts it. Otherwise run the preview and the repair on a Linux or macOS host where this folder is on a local disk. Where gbrain cannot check locality (another system, an unrecognised filesystem), only the user can confirm that no gbrain on any computer reaches this folder and move the lock folder aside themselves.'
    : 'Stop the process named in the message (on a shared filesystem: every gbrain on every host that mounts it), then run the preview again.';
  const e = opError('legacy_lock_removal_refused', `${refusal.message} The legacy lock at ${i.legacy_lock.dir} was left in place.`, hint,
    { reason: refusal.reason, fix: previewFix(i.data_dir) });
  return writeCliError(e, 'pglite-repair', { json, emit: emitText });
}

interface LegacyLockRepairOpts { dryRun: boolean; json: boolean; args: readonly string[]; consentEnv?: ConsentEnv; probe?: LegacyLockProbe }

async function applyUnderKernelLock(dataDir: string, opts: LegacyLockRepairOpts): Promise<number> {
  const { json, args } = opts;
  const inspection = inspectLegacyLock(dataDir, opts.probe);
  if (!inspection.legacy_lock.legacy) {
    emit({ status: 'ok', action: 'none', data_dir: inspection.data_dir, verdict: inspection.legacy_lock.verdict });
    return 0;
  }
  if (inspection.refusal) return refuse(inspection, json);
  const auth = await consentGate({
    command: 'pglite-repair', effects: ['destructive'], actor: 'agent',
    what: `Move the legacy PGLite lock of ${inspection.data_dir} aside`,
    why: `A lock folder from an older gbrain blocks every open of this brain and gbrain cannot prove its owner stopped (${inspection.legacy_lock.reason ?? inspection.legacy_lock.verdict}). ${inspection.evidence?.scope ?? ''}`,
    risk: RISK, user_message: userMessage(inspection),
    argv: applyArgv(inspection.data_dir), preview_argv: previewArgv(inspection.data_dir),
    plan_hash: inspection.plan_hash!, selection: inspection.selection, args,
  }, { json, env: opts.consentEnv });
  if (!auth) return currentExitCode();
  const fresh = inspectLegacyLock(dataDir, opts.probe);
  if (fresh.refusal) return refuse(fresh, json);
  if (fresh.plan_hash !== inspection.plan_hash) {
    throw opError('preview_changed', `The legacy lock of ${inspection.data_dir} changed while consent was pending (approved plan ${inspection.plan_hash}, current plan ${fresh.plan_hash ?? 'none'}); nothing was changed.`,
      'Preview again, show the user the new plan, and re-run with the new --expect value only if they approve it.', { fix: previewFix(inspection.data_dir) });
  }
  const receipt = applyLegacyLockRemoval(fresh);
  if (json) emit({ status: 'ok', ...receipt, next_command: 'gbrain doctor --json' });
  else console.log(`Moved the legacy lock of ${receipt.data_dir} to ${receipt.moved_to} and wrote the kernel-v1 marker.\n  Undo (once no process has the brain open): ${receipt.restore_command}\n  Next: gbrain doctor --json`);
  return 0;
}

export async function runLegacyLockRepair(dataDir: string, opts: LegacyLockRepairOpts): Promise<number> {
  const inspection = inspectLegacyLock(dataDir, opts.probe);
  if (opts.dryRun) return printPreview(inspection, opts.json);
  if (!inspection.legacy_lock.legacy) {
    if (opts.json) emit({ status: 'ok', action: 'none', data_dir: inspection.data_dir, verdict: inspection.legacy_lock.verdict });
    else console.log(`Nothing to do: no legacy lock blocks ${inspection.data_dir}.`);
    return 0;
  }
  let kernel: LockHandle;
  try {
    kernel = await acquireKernelLockOnly(inspection.data_dir, { lockDir: inspection.legacy_lock.dir, timeoutMs: 5_000 });
  } catch (error) {
    if (!(error instanceof PgliteBusyError)) throw error;
    const e = opError('pglite_busy', `A running gbrain holds the kernel lock of ${inspection.data_dir}, so the legacy lock is not what blocks it; nothing was changed.`,
      'Wait for that gbrain command or server to finish, then run the preview again. Do not remove a live lock.', { reason: 'timeout', fix: previewFix(inspection.data_dir) });
    return writeCliError(e, 'pglite-repair', { json: opts.json, emit: emitText });
  }
  try {
    return await applyUnderKernelLock(inspection.data_dir, opts);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return writeCliError(error, 'pglite-repair', { json: opts.json, emit: emitText });
  } finally {
    await releaseLock(kernel);
  }
}
