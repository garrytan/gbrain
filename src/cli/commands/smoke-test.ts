/**
 * `gbrain smoke-test`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { cliModuleUrl } = ctx;
  // Run smoke tests — no DB connection needed, the script handles its own checks
  const { execSync } = await import('../../core/spawn.ts');
  const { resolve, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const scriptDir = dirname(fileURLToPath(cliModuleUrl));
  const scriptPath = resolve(scriptDir, '..', 'scripts', 'smoke-test.sh');
  try {
    execSync(`bash "${scriptPath}"`, { stdio: 'inherit', env: { ...process.env } });
  } catch (e: any) {
    // Non-zero exit = some tests failed (exit code = failure count)
    setCliExitVerdict(e.status ?? 1);
  }
}
