/**
 * Doctor's pre-connect refusal for a configured PGLite brain that is not there
 * (unmounted drive, moved folder). Doctor must never create the thing it
 * checks: connecting to a missing PGLite path builds a new empty brain, which
 * a plain run then migrates and reports healthy. This reuses `gbrain serve`'s
 * status-only probe (`probeStatus`, src/mcp/status-mode.ts), file reads only,
 * so doctor and serve agree on what "missing" means.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getMountsPath, loadMounts } from '../../core/brain-registry.ts';
import { configPath, gbrainPath, loadConfig } from '../../core/config.ts';
import { opError, type OperationError } from '../../core/ops/contract.ts';
import { probeStatus, statusFix, type StatusModeState } from '../../mcp/status-mode.ts';

/**
 * True when a PGLite connect to `dir` would build a new datastore: the path is absent, or a folder without
 * PGLite's own `PG_VERSION` marker (an empty mount point an unmounted drive leaves, or a folder holding only
 * stray files). A path that is a plain file (a graduated brain's tombstone) is not this check's to judge.
 */
function connectWouldCreate(dir: string): boolean {
  // One stat, no existence pre-test: a path that cannot be stat'ed (gone, or vanished mid-check as a drive unmounts) is
  // refused as missing, never read as "the brain is there".
  let st;
  try { st = statSync(dir); } catch { return true; }
  return st.isDirectory() && !existsSync(join(dir, 'PG_VERSION'));
}

/** The folder the connector opens for this engine config, or undefined when it opens no local folder (Postgres). A leftover `database_url` does not change that. */
function localFolder(engine: string | undefined, databasePath: string | undefined, fallback?: string): string | undefined {
  return engine === 'pglite' ? databasePath ?? fallback : undefined;
}

interface MissingState extends Pick<StatusModeState, 'config_path' | 'brain_path'> { mount?: string }

/** The selected brain's PGLite folder when a connect would create it; null for everything else. */
function missingState(brainId: string): MissingState | null {
  if (brainId !== 'host') {
    // The mount doctor really opens: BrainRegistry.getBrain resolves an enabled mount by its exact id (an alias never counts).
    let mount;
    // silent-read-ok: a mounts.json that does not load is not a missing brain; the registry loads the same file and fails with its own error before any folder is opened, so nothing can be created
    try { mount = loadMounts().find((m) => m.id === brainId && m.enabled !== false); } catch { return null; }
    const dir = mount && localFolder(mount.engine, mount.database_path);
    return mount && dir && connectWouldCreate(dir) ? { config_path: getMountsPath(), brain_path: dir, mount: mount.id } : null;
  }
  const state = probeStatus();
  if (state && state.reason !== 'missing_brain') return null; // lock held, graduated, repair failed, no config: doctor's own diagnostics own those
  const cfg = loadConfig();
  const dir = cfg && localFolder(cfg.engine, cfg.database_path, gbrainPath('brain.pglite'));
  return dir && connectWouldCreate(dir) ? { config_path: configPath(), brain_path: dir } : null;
}

/** The refusal to render, or null when the selected brain is not configured-but-missing. */
export function missingBrainRefusal(brainId = 'host'): OperationError | null {
  const found = missingState(brainId);
  if (!found) return null;
  const state = { reason: 'missing_brain' as const, config_path: found.config_path, brain_path: found.brain_path, checked_at: Date.now() };
  const where = state.brain_path ?? 'its configured path';
  const { fix } = statusFix({ ...state, recovered: false }, 'http');
  // `gbrain init` rewrites the HOST config, so it is only offered for the host brain, never as the way to recreate a mount.
  const recreate = found.mount
    ? `Creating a new empty datastore for mount \`${found.mount}\` is your decision (the old notes would not be in it); \`gbrain init\` is not the way, it rewrites the host brain's config.`
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

/** Render the refusal like every doctor structured error (`--json` envelope or text) and set the exit verdict. */
export async function refuseMissingBrain(args: string[], err: OperationError): Promise<void> {
  const { renderCliError } = await import('../../core/agent-output.ts');
  const { setCliExitVerdict, writeStdoutFinal } = await import('../../core/cli-force-exit.ts');
  const out = renderCliError(err, { json: args.includes('--json'), command: 'doctor', tty: !!process.stderr.isTTY });
  // Under the --json guard only writeStdoutFinal reaches fd 1; process.stdout.write is rerouted to stderr.
  if (out.stdout) await writeStdoutFinal(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  setCliExitVerdict(out.exitCode);
}
