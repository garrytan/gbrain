/**
 * Doctor's pre-connect refusal for a configured PGLite brain that is not there
 * (unmounted drive, moved folder). Doctor must never create the thing it
 * checks: connecting to a missing PGLite path builds a new empty brain, which
 * a plain run then migrates and reports healthy. This reuses `gbrain serve`'s
 * status-only probe (`probeStatus`, src/mcp/status-mode.ts), file reads only,
 * so doctor and serve agree on what "missing" means.
 */
import { opError, type OperationError } from '../../core/ops/contract.ts';
import { probeStatus, statusFix } from '../../mcp/status-mode.ts';

/** The refusal to render, or null when the brain is not configured-but-missing. */
export function missingBrainRefusal(): OperationError | null {
  const state = probeStatus();
  if (state?.reason !== 'missing_brain') return null;
  const where = state.brain_path ?? 'its configured path';
  const { fix } = statusFix({ ...state, recovered: false }, 'http');
  return opError('brain_missing',
    `The brain configured in ${state.config_path} is not at ${where} (an unmounted drive or a moved folder?), so doctor did not check it. Nothing was created there.`,
    `Mount or move the brain back, or point \`database_path\` in ${state.config_path} at where it lives now. Creating a new empty brain is \`gbrain init --pglite --no-embedding --path ${where}\`, which is your decision (the old notes would not be in it).`,
    {
      reason: 'missing_brain',
      fix: {
        ...fix,
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
