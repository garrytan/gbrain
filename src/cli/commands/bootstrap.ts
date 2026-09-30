/**
 * `gbrain bootstrap`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

export async function run(args: string[]): Promise<void> {
  // Agent-bootstrap dispatcher (plan D3/ENG-2): ENGINE-FREE by contract —
  // a live serve may hold the PGLite lock mid-install. The `verify`
  // subcommand manages its OWN engine inside bootstrap.ts (cache.ts
  // pattern) precisely when no serve is live [CX2-5].
  const { runBootstrap } = await import('../../commands/bootstrap.ts');
  setCliExitVerdict(await runBootstrap(args));
}
