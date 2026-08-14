/**
 * `gbrain bootstrap uninstall` — receipt-keyed removal of bootstrap-created
 * state [G2, S3#5, A2, CX2-12].
 *
 * Ownership model: uninstall is keyed to the MACHINE-LOCAL install receipt,
 * never to the repo-carried agent.json (template/attach clones inherit the
 * manifest but not the receipt). No receipt → nothing bootstrap-created on
 * this machine → refuse.
 *
 * Confinement invariants:
 *  - Removes EXACTLY `receipt.created_paths`, each validated with
 *    `isPathContained` under the gbrain home or the workspace. Anything that
 *    fails containment (including a symlink resolving outside) is SKIPPED with
 *    a reason, never followed.
 *  - Host registrations are returned as structured removal REQUESTS — the
 *    marker-keyed settings/TOML writers live in another module; this one never
 *    edits host config files.
 *  - NEVER wholesale-deletes the gbrain home: brain deletion removes only the
 *    PGLite data dir + the `bootstrap/` subdir + the receipt. Global
 *    config.json, clones/, and other sources SURVIVE [CX2-12].
 *  - Brain deletion runs ONLY when `deleteBrain` is requested AND the receipt
 *    says bootstrap created the brain [G2], behind a confirm whose message
 *    enumerates what is known WITHOUT opening an engine; a facts-export offer
 *    step is emitted first (facts are not derived state).
 *  - Refuses while a live process holds the PGLite data-dir lock (read-only
 *    lock-file probe — the engine is never opened) — "close your agent
 *    sessions first".
 *  - GBRAIN_HOME guard [S3#5]: with the env var set, requires an explicit
 *    home + containment in the workspace + the gbrain-home signature
 *    (config.json AND brain.pglite) before touching anything. A symlinked
 *    home is rejected via lstat.
 */

import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config.ts';
import { isPathContained, realpathOrResolve } from '../path-confine.ts';
import { isProcessAlive } from '../pglite-lock.ts';
import { readReceipt, receiptPath, type InstallReceipt } from './format.ts';
import { BootstrapError } from './lock.ts';
import type { ExecRunner } from './repo.ts';

// ---------------------------------------------------------------------------
// Read-only PGLite lock probe (never opens the engine)
// ---------------------------------------------------------------------------

export interface LiveHolder {
  pid: number;
  /** True when the lock file says the holder is `gbrain serve`. */
  serve: boolean;
}

/**
 * Probe `<dataDir>/.gbrain-lock/lock` for a LIVE holder. Mirrors
 * pglite-lock.ts's classification (subcommand field with command-string
 * fallback; only an affirmatively-dead PID reads as dead) without acquiring,
 * reaping, or opening anything. Unreadable/absent lock → null (no live holder
 * provable — uninstall proceeds; a dead holder's stale lock dir is inert).
 */
export function probeLivePgliteHolder(dataDir: string): LiveHolder | null {
  const lockPath = join(dataDir, '.gbrain-lock', 'lock');
  let raw: { pid?: unknown; subcommand?: unknown; command?: unknown };
  try {
    raw = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof raw;
  } catch {
    return null;
  }
  const pid = typeof raw.pid === 'number' ? raw.pid : NaN;
  if (!Number.isInteger(pid) || !isProcessAlive(pid)) return null;
  let serve = false;
  if (typeof raw.subcommand === 'string') {
    serve = raw.subcommand === 'serve';
  } else if (typeof raw.command === 'string') {
    const parts = raw.command.trim().split(/\s+/);
    serve = parts[0] === 'serve' || parts[1] === 'serve';
  }
  return { pid, serve };
}

/** The PGLite data dir for a gbrain home: config.json's database_path when it
 * is set and stays inside the home (fail-closed on escapes), else the default
 * `<home>/brain.pglite`. Read directly — never through an engine. */
export function resolveBrainDataDir(gbrainHomeDir: string): string {
  const fallback = join(gbrainHomeDir, 'brain.pglite');
  try {
    const parsed = JSON.parse(readFileSync(join(gbrainHomeDir, 'config.json'), 'utf8')) as { database_path?: unknown };
    if (typeof parsed.database_path === 'string' && parsed.database_path.length > 0) {
      // A custom path outside the home is not bootstrap-created state — never
      // a deletion target; the probe/deletion fall back to the home-local dir.
      if (isPathContained(parsed.database_path, gbrainHomeDir)) return parsed.database_path;
    }
  } catch { /* no config / unreadable — default */ }
  return fallback;
}

// ---------------------------------------------------------------------------
// uninstallWorkspace
// ---------------------------------------------------------------------------

export interface RegistrationRemovalRequest {
  host: 'claude-code' | 'codex';
  scope: string;
  detail?: string;
}

export interface UninstallStep {
  kind: 'facts_export_offer';
  description: string;
}

export interface UninstallOptions {
  /** Request brain deletion (still gated on receipt.brain_created_by_bootstrap). */
  deleteBrain?: boolean;
  /** Interactive confirmation for brain deletion. Absent → treated as
   * declined (fail-closed): the rest of the uninstall proceeds, the brain
   * survives. */
  confirm?: (msg: string) => Promise<boolean>;
  /** Exec seam (reserved for the dispatcher's facts-export wiring; uninstall
   * itself runs no subprocesses). */
  runner?: ExecRunner;
  /** The gbrain home holding the receipt (default: configDir()). */
  gbrainHomeDir?: string;
  /** The dispatcher sets this when the user passed an explicit --home;
   * required whenever the GBRAIN_HOME env var is set [S3#5]. */
  homeExplicit?: boolean;
  /** Optional engine-free stats provider for the confirm message (page count
   * enumeration). Default: counts reported unavailable. */
  brainStats?: () => Promise<{ sources: string[]; pages: number } | null>;
}

export interface UninstallResult {
  /** created_paths actually removed. */
  removed_paths: string[];
  /** created_paths NOT removed, with the reason (absent / containment). */
  skipped_paths: Array<{ path: string; reason: string }>;
  /** Marker-keyed host-registration removals for the dispatcher to execute. */
  registration_removals: RegistrationRemovalRequest[];
  /** Steps the dispatcher should surface/run (facts-export offer). */
  steps: UninstallStep[];
  brain_deleted: boolean;
  receipt_removed: boolean;
}

export async function uninstallWorkspace(workspaceDir: string, opts: UninstallOptions = {}): Promise<UninstallResult> {
  const gbrainHomeDir = opts.gbrainHomeDir ?? configDir();

  // --- Home guards, before touching ANYTHING under it -----------------------
  let homeLstat;
  try {
    homeLstat = lstatSync(gbrainHomeDir);
  } catch {
    throw new BootstrapError('NO_RECEIPT', `nothing bootstrap-created on this machine (no gbrain home at ${gbrainHomeDir})`);
  }
  if (homeLstat.isSymbolicLink()) {
    throw new BootstrapError(
      'HOME_GUARD',
      `refusing to uninstall through a symlinked gbrain home (${gbrainHomeDir}) — point at the real directory`,
    );
  }
  if (process.env.GBRAIN_HOME?.trim()) {
    if (!opts.homeExplicit) {
      throw new BootstrapError(
        'HOME_GUARD',
        'GBRAIN_HOME is set — uninstall refuses an ambient home override. Re-run with an explicit --home to confirm the target.',
      );
    }
    if (!isPathContained(gbrainHomeDir, workspaceDir)) {
      throw new BootstrapError(
        'HOME_GUARD',
        `the explicit home (${gbrainHomeDir}) is not inside the workspace (${workspaceDir}) — an isolated bootstrap home always is; refusing.`,
      );
    }
    const hasSignature = existsSync(join(gbrainHomeDir, 'config.json')) && existsSync(join(gbrainHomeDir, 'brain.pglite'));
    if (!hasSignature) {
      throw new BootstrapError(
        'HOME_GUARD',
        `${gbrainHomeDir} does not look like a gbrain home (missing config.json and/or brain.pglite) — refusing to remove anything under it.`,
      );
    }
  }

  // --- Ownership: the machine-local receipt [CX2-12] ------------------------
  const receipt: InstallReceipt | null = readReceipt(gbrainHomeDir);
  if (receipt === null) {
    throw new BootstrapError(
      'NO_RECEIPT',
      'nothing bootstrap-created on this machine (no install receipt) — if this workspace was bootstrapped elsewhere, the repo stays yours; there is nothing to uninstall here.',
    );
  }
  const resolvedWs = realpathOrResolve(workspaceDir);
  if (realpathOrResolve(receipt.workspace_dir) !== resolvedWs) {
    throw new BootstrapError(
      'RECEIPT_MISMATCH',
      `this machine's install receipt belongs to a different workspace (${receipt.workspace_dir}) — run uninstall from there.`,
      { details: { receipt_workspace: receipt.workspace_dir } },
    );
  }

  // --- Brain-deletion gate BEFORE any removal [G2] ---------------------------
  const deleteBrainRequested = opts.deleteBrain === true;
  if (deleteBrainRequested && !receipt.brain_created_by_bootstrap) {
    throw new BootstrapError(
      'DELETE_BRAIN_REFUSED',
      'bootstrap did not create this brain (it adopted an existing one), so uninstall will not delete it. Re-run without --delete-brain; remove the brain yourself if you really mean to.',
    );
  }

  // --- Live-holder refusal (read-only probe; the engine is never opened) ----
  const dataDir = resolveBrainDataDir(gbrainHomeDir);
  const holder = probeLivePgliteHolder(dataDir);
  if (holder !== null) {
    throw new BootstrapError(
      'LIVE_SERVE',
      holder.serve
        ? `a live \`gbrain serve\` (pid ${holder.pid}) has the brain open — close your agent sessions first, then re-run uninstall.`
        : `a live gbrain process (pid ${holder.pid}) has the brain open — close your agent sessions first, then re-run uninstall.`,
      { details: { pid: holder.pid, serve: holder.serve } },
    );
  }

  const steps: UninstallStep[] = [];
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let brainDeleted = false;
  let brainDeletionFailed = false;

  // --- Brain deletion (confirm-gated, surgical) [G2, CX2-12] ----------------
  if (deleteBrainRequested) {
    // Facts export offered FIRST — facts are user knowledge, not derived state.
    steps.push({
      kind: 'facts_export_offer',
      description: 'export facts before deletion (gbrain facts export) — the brain DB is about to be removed and facts are not derived state',
    });
    const stats = opts.brainStats ? await opts.brainStats() : null;
    const inventory =
      stats !== null
        ? `sources: ${stats.sources.join(', ') || '(none)'}; pages: ${stats.pages}`
        : `source '${receipt.source_id}' (page count unavailable without opening the brain)`;
    const msg =
      `Delete the brain database at ${dataDir}? This removes ${inventory}. ` +
      'The workspace repo and its files remain yours. This cannot be undone.';
    const confirmed = opts.confirm ? await opts.confirm(msg) : false;
    if (confirmed) {
      // brain_deleted is only ever true after the rm SUCCEEDED and the dir is
      // verifiably gone — a containment failure or rm error reports a reason
      // and keeps the receipt + telemetry so a retry stays possible.
      if (!isPathContained(dataDir, gbrainHomeDir)) {
        brainDeletionFailed = true;
        skipped.push({
          path: dataDir,
          reason: 'brain deletion skipped: data dir is outside the gbrain home (or symlinks out) — refusing; remove it yourself if you really mean to',
        });
      } else {
        let rmError: Error | null = null;
        try {
          rmSync(dataDir, { recursive: true, force: true });
        } catch (e) {
          rmError = e as Error;
        }
        if (rmError === null && !existsSync(dataDir)) {
          brainDeleted = true;
        } else {
          brainDeletionFailed = true;
          skipped.push({
            path: dataDir,
            reason: `brain deletion failed${rmError ? `: ${rmError.message}` : ': directory still present after rm'} — receipt kept so uninstall --delete-brain can be retried`,
          });
        }
      }
    }
  }

  // --- created_paths: remove EXACTLY these, each containment-checked --------
  for (const p of receipt.created_paths) {
    let exists = false;
    try {
      lstatSync(p);
      exists = true;
    } catch { /* absent */ }
    if (!exists) {
      skipped.push({ path: p, reason: 'already absent' });
      continue;
    }
    // isPathContained realpaths both sides — a created_path symlinked outside
    // the allowed roots resolves outside and is skipped, never followed.
    if (!isPathContained(p, gbrainHomeDir) && !isPathContained(p, resolvedWs)) {
      skipped.push({ path: p, reason: 'outside the gbrain home and workspace (or symlinks out) — refusing' });
      continue;
    }
    try {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (e) {
      skipped.push({ path: p, reason: `removal failed: ${(e as Error).message}` });
    }
  }

  // --- Registrations: structured requests for the host-config writers -------
  const registrationRemovals: RegistrationRemovalRequest[] = receipt.registrations.map((r) => ({
    host: r.host,
    scope: r.scope,
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
  }));

  // --- Receipt (and, on brain deletion, the bootstrap/ subdir) --------------
  let receiptRemoved = false;
  if (brainDeleted) {
    // The bootstrap/ subdir (receipt + install/verify telemetry) goes with the
    // brain. Global config.json, clones/, other sources SURVIVE [CX2-12].
    try {
      rmSync(join(gbrainHomeDir, 'bootstrap'), { recursive: true, force: true });
      receiptRemoved = true;
    } catch { /* best-effort */ }
  } else if (brainDeletionFailed) {
    // A confirmed deletion that FAILED keeps the bootstrap/ subdir AND the
    // receipt: consuming the receipt here would strand the brain (uninstall
    // is receipt-keyed, so a retry would refuse with NO_RECEIPT).
  } else {
    // Plain uninstall: the receipt alone is consumed (this machine no longer
    // claims bootstrap-created state); telemetry stays for post-mortems.
    try {
      rmSync(receiptPath(gbrainHomeDir), { force: true });
      receiptRemoved = true;
    } catch { /* best-effort */ }
  }

  return {
    removed_paths: removed,
    skipped_paths: skipped,
    registration_removals: registrationRemovals,
    steps,
    brain_deleted: brainDeleted,
    receipt_removed: receiptRemoved,
  };
}
