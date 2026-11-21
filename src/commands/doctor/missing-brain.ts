/**
 * Doctor's pre-connect refusal for a configured PGLite brain that is not there
 * (unmounted drive, moved folder). Doctor must never create the thing it
 * checks: connecting to a missing PGLite path builds a new empty brain, which
 * a plain run then migrates and reports healthy. This reuses `gbrain serve`'s
 * status-only probe (`probeStatus`, src/mcp/status-mode.ts), file reads only,
 * so doctor and serve agree on what "missing" means.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { getMountsPath, loadMounts } from '../../core/brain-registry.ts';
import { configPath, loadConfig } from '../../core/config.ts';
import { opError, type OperationError } from '../../core/ops/contract.ts';
import { brainPathFor, probeStatus, statusFix, type StatusModeState } from '../../mcp/status-mode.ts';

/** A folder with nothing in it: where an unmounted drive's mount point leaves the brain's path. */
function isEmptyDir(path: string): boolean {
  try { return statSync(path).isDirectory() && readdirSync(path).length === 0; } catch { return false; }
}

/** The selected brain's PGLite folder when it is not there (or is an empty mount point); null for everything else. */
function missingState(brainId: string): Pick<StatusModeState, 'config_path' | 'brain_path'> | null {
  if (brainId !== 'host') {
    // A mounted PGLite brain: connecting to a missing database_path would create a new empty datastore there.
    let mount;
    try { mount = loadMounts().find((m) => m.id === brainId || m.alias === brainId); } catch { return null; }
    if (!mount || mount.database_url || !mount.database_path) return null; // only a local-folder (PGLite) mount has a path to create
    return !existsSync(mount.database_path) || isEmptyDir(mount.database_path)
      ? { config_path: getMountsPath(), brain_path: mount.database_path } : null;
  }
  const state = probeStatus();
  if (state?.reason === 'missing_brain') return { config_path: state.config_path, brain_path: state.brain_path };
  if (state !== null) return null; // another blocking reason (lock held, graduated, repair failed): doctor's own diagnostics own it
  const dir = brainPathFor(loadConfig());
  return dir && isEmptyDir(dir) ? { config_path: configPath(), brain_path: dir } : null;
}

/** The refusal to render, or null when the selected brain is not configured-but-missing. */
export function missingBrainRefusal(brainId = 'host'): OperationError | null {
  const found = missingState(brainId);
  if (!found) return null;
  const state = { reason: 'missing_brain' as const, config_path: found.config_path, brain_path: found.brain_path, checked_at: Date.now() };
  const where = state.brain_path ?? 'its configured path';
  const { fix } = statusFix({ ...state, recovered: false }, 'http');
  return opError('brain_missing',
    `The brain configured in ${state.config_path} is not at ${where} (an unmounted drive or a moved folder?), so doctor did not check it. Nothing was created there.`,
    `Mount or move the brain back, or point \`database_path\` in ${state.config_path} at where it lives now. Creating a new empty brain is \`gbrain init --pglite --no-embedding --path ${where}\`, which is your decision (the old notes would not be in it).`,
    {
      reason: 'missing_brain',
      fix: {
        ...fix,
        // Only the user can bring the brain back; an agent must stop and ask, not rerun doctor.
        ask_user: true,
        why: `Mount or reconnect the drive that holds ${where}, or point \`database_path\` in ${state.config_path} at where the brain lives now; then run the verify command. Doctor created nothing, and a new empty brain is \`gbrain init\`, only on the user's say-so.`,
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
