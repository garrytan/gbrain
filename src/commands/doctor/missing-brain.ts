/**
 * Doctor's pre-connect refusal for a configured PGLite or Rust brain that is not
 * there (unmounted drive, moved folder). Doctor must never create the thing it
 * checks: connecting to a missing PGLite path builds a new empty brain, which
 * a plain run then migrates and reports healthy, and a Rust connect creates a
 * new empty store directory (owner election and the store's `open_dir`). This reuses `gbrain serve`'s
 * status-only probe (`probeStatus`, src/mcp/status-mode.ts), file reads only,
 * so doctor and serve agree on what "missing" means.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getMountsPath, loadMounts } from '../../core/brain-registry.ts';
import { configPath, gbrainPath, loadConfig } from '../../core/config.ts';
import { opError, OperationError } from '../../core/ops/contract.ts';
import { installPgliteCreateGuard } from '../../core/pglite-create-guard.ts';
import { pgliteLockDirFor } from '../../core/pglite-lock.ts';
import { probeStatus, statusFix, type StatusModeState } from '../../mcp/status-mode.ts';

/**
 * True when a PGLite connect to `dir` would build a new datastore: the path is absent, or a folder without
 * PGLite's own `PG_VERSION` marker (an empty mount point an unmounted drive leaves, or a folder holding only
 * stray files). A path that is a plain file (a graduated brain's tombstone) is not this check's to judge.
 */
function connectWouldCreate(dir: string, engine: LocalEngine = 'pglite'): boolean {
  // One stat, no existence pre-test: a path that cannot be stat'ed (gone, or vanished mid-check as a drive unmounts) is
  // refused as missing, never read as "the brain is there".
  let st;
  try { st = statSync(dir); } catch { return true; }
  if (!st.isDirectory()) return false;
  // A Rust store directory holds its FORMAT file and its record file (rust/crates/gbrain-store/src/format.rs); a folder
  // with neither is what `open_dir` would turn into a new empty store.
  return engine === 'rust' ? !existsSync(join(dir, 'FORMAT')) && !existsSync(join(dir, 'records.redb')) : !existsSync(join(dir, 'PG_VERSION'));
}

/** The engines whose connect opens a local folder, which a connect to a missing path would create. */
type LocalEngine = 'pglite' | 'rust';

/**
 * The folder the connector opens for this engine config, or undefined when it opens no local folder (Postgres). A leftover
 * `database_url` does not change that. A Rust brain names its store directory in `database_path` (no default; a relative or
 * absent path is refused by the connector itself before anything is created).
 */
function localFolder(engine: string | undefined, databasePath: string | undefined, fallback?: string): string | undefined {
  if (engine === 'pglite') return databasePath ?? fallback;
  return engine === 'rust' && databasePath && isAbsolute(databasePath) ? databasePath : undefined;
}

interface MissingState extends Pick<StatusModeState, 'config_path' | 'brain_path'> { mount?: string; engine: LocalEngine }

/** The selected brain's PGLite folder, whether or not it is there; null when a connect opens no local folder or the probe leaves the case to doctor's own diagnostics. */
function selectedDatastore(brainId: string): MissingState | null {
  if (brainId !== 'host') {
    // The mount doctor really opens: BrainRegistry.getBrain resolves an enabled mount by its exact id (an alias never counts).
    let mount;
    // silent-read-ok: a mounts.json that does not load is not a missing brain; the registry loads the same file and fails with its own error before any folder is opened, so nothing can be created
    try { mount = loadMounts().find((m) => m.id === brainId && m.enabled !== false); } catch { return null; }
    const dir = mount && localFolder(mount.engine, mount.database_path);
    return mount && dir ? { config_path: getMountsPath(), brain_path: dir, mount: mount.id, engine: 'pglite' } : null;
  }
  const cfg = loadConfig();
  // probeStatus reads PGLite folders only: a Rust brain's store directory is judged here, with its own markers.
  if (cfg?.engine === 'rust') {
    const dir = localFolder(cfg.engine, cfg.database_path);
    return dir ? { config_path: configPath(), brain_path: dir, engine: 'rust' } : null;
  }
  const state = probeStatus();
  // Graduated, repair failed, no config: doctor's own diagnostics own those, and none of them connects. A lock reported held
  // still gets the folder test: an unreadable leftover lock reads as held while no process holds it, and the connect would
  // take that lock and build an empty brain in a folder with no PG_VERSION.
  if (state && state.reason !== 'missing_brain' && state.reason !== 'lock_held') return null;
  const dir = cfg && localFolder(cfg.engine, cfg.database_path, gbrainPath('brain.pglite'));
  return dir ? { config_path: configPath(), brain_path: dir, engine: 'pglite' } : null;
}

/** The selected brain's PGLite folder when a connect would create it; null for everything else. */
function missingState(brainId: string): MissingState | null {
  const found = selectedDatastore(brainId);
  return found?.brain_path && connectWouldCreate(found.brain_path, found.engine) ? found : null;
}

/** The refusal to render, or null when the selected brain is not configured-but-missing. */
export function missingBrainRefusal(brainId = 'host'): OperationError | null {
  const found = missingState(brainId);
  return found ? refusalFor(found) : null;
}

/** True for the refusal this module builds (`brain_missing`), however it reached the caller. */
export function isMissingBrainRefusal(e: unknown): e is OperationError {
  return e instanceof OperationError && e.code === 'brain_missing';
}

/**
 * Doctor's second look, for as long as the returned function has not been called. Connecting waits for the datastore's
 * kernel lock, and the folder can be moved or unmounted during that wait; `acquireLock` runs this once it holds the
 * lock and before it creates anything, so a missing datastore is refused (the lock is released on the throw). The
 * datastore is the one this run is about to open, read once now: a `database_path` edited, or a symlink that stops
 * resolving, while doctor waits does not change which lock is ours. Locks on any other folder are not this guard's to judge.
 */
export function guardMissingBrainAtLock(brainId = 'host'): () => void {
  const target = selectedDatastore(brainId);
  // The kernel-lock guard is PGLite's: a Rust connect takes the owner lock (owner-ipc/election.ts), not this one, so a Rust
  // store moved during the connect itself is not seen here; the pre-connect refusal above covers a store already gone.
  if (!target?.brain_path || target.engine === 'rust') return () => {};
  // pgliteLockDirFor names a datastore the way acquireLock does (canonical path + the lock folder), so the two spellings compare equal.
  const ours = pgliteLockDirFor(target.brain_path);
  return installPgliteCreateGuard((lockedDir) => {
    if (join(lockedDir, '.gbrain-lock') === ours && connectWouldCreate(lockedDir)) throw refusalFor(target);
  });
}

function refusalFor(found: MissingState): OperationError {
  const state = { reason: 'missing_brain' as const, config_path: found.config_path, brain_path: found.brain_path, checked_at: Date.now() };
  const where = state.brain_path ?? 'its configured path';
  const { fix } = statusFix({ ...state, recovered: false }, 'http');
  // `gbrain init` rewrites the HOST config, so it is only offered for the host brain, never as the way to recreate a mount.
  const recreate = found.mount
    ? `Creating a new empty datastore for mount \`${found.mount}\` is your decision (the old notes would not be in it); \`gbrain init\` is not the way, it rewrites the host brain's config.`
    : found.engine === 'rust'
      ? `Creating a new empty store there is your decision (the old notes would not be in it): the next command that opens this brain creates it.`
      : `Creating a new empty brain is \`gbrain init --pglite --no-embedding --path ${where}\`, which is your decision (the old notes would not be in it).`;
  const subject = found.mount ? `The datastore of mount \`${found.mount}\`` : 'The brain';
  return opError('brain_missing',
    `${subject} configured in ${state.config_path} is not at ${where} (an unmounted drive or a moved folder?), so doctor did not check it. Nothing was created there.`,
    `Mount or move the brain back, or point \`database_path\` in ${state.config_path} at where it lives now. ${recreate}`,
    {
      reason: 'missing_brain',
      fix: {
        ...fix,
        // Only the user can bring the brain back; an agent must stop and ask, not rerun doctor.
        ask_user: true,
        why: `Mount or reconnect the drive that holds ${where}, or point \`database_path\` in ${state.config_path} at where the brain lives now; then run the verify command. Doctor created nothing, and a new empty datastore is only ever created on the user's say-so.`,
      },
    });
}

/** Render the refusal like every doctor structured error (`--json` envelope or text) and set the exit verdict. Under `--alert` it is the alert contract instead. */
export async function refuseMissingBrain(args: string[], err: OperationError): Promise<void> {
  const { renderCliError } = await import('../../core/agent-output.ts');
  const { setCliExitVerdict, writeStdoutFinal } = await import('../../core/cli-force-exit.ts');
  if (args.includes('--alert')) { await alertMissingBrain(err, args.includes('--json')); return; }
  const out = renderCliError(err, { json: args.includes('--json'), command: 'doctor', tty: !!process.stderr.isTTY });
  // Under the --json guard only writeStdoutFinal reaches fd 1; process.stdout.write is rerouted to stderr.
  if (out.stdout) await writeStdoutFinal(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  setCliExitVerdict(out.exitCode);
}

/**
 * `doctor --alert` on a missing brain: the datastore cannot be connected to, so the page-class `connection` check pages (act, exit 17),
 * never the bare error exit 1 a cron cannot tell from a crash. The item's code is brain_missing, its fix the refusal's own (ask the user).
 * The brain_missing envelope a caller already reads stays at the top of the `--json` document, with `alert` beside it.
 */
async function alertMissingBrain(err: OperationError, json: boolean): Promise<void> {
  const { renderCliError } = await import('../../core/agent-output.ts');
  const { ALERT_DOCS, alertExitCode, recordAlertStreak } = await import('./alert.ts');
  const { fixLine } = await import('./check-fix.ts');
  const { setCliExitVerdict, writeStdoutFinal } = await import('../../core/cli-force-exit.ts');
  const envelope = JSON.parse(renderCliError(err, { json: true, command: 'doctor', tty: false }).stdout!) as Record<string, any>;
  const item = { code: 'brain_missing', check: 'connection', status: 'fail' as const, message: envelope.message as string, docs: envelope.docs as string, fix: envelope.fix };
  const alert = recordAlertStreak({ level: 'act', items: [item], unknown: [], docs: ALERT_DOCS });
  if (json) {
    await writeStdoutFinal(JSON.stringify({ ...envelope, alert }));
  } else {
    console.log('Alert: act');
    console.log(`  [ACT] connection (brain_missing): ${item.message}`);
    const fix = fixLine(item.fix);
    if (fix) console.log(`    Fix: ${fix}`);
  }
  setCliExitVerdict(alertExitCode(alert.level));
}
