/**
 * `gbrain notability-eval`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.31.2: notability gate eval suite. Two subcommands:
  //   gbrain notability-eval mine    — sample paragraphs, write candidates
  //   gbrain notability-eval review  — TTY hand-confirm tiers
  const { runNotabilityEval } = await import('../../commands/notability-eval.ts');
  const subcmd = args[0] || 'help';
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  // sync.repo_path resolution (matches dream phase pattern).
  let repoPath: string | undefined;
  try {
    repoPath = (flags.repo as string) || (await engine.getConfig('sync.repo_path')) || undefined;
  } catch { /* engine may not be connected for help */ }
  await runNotabilityEval({ cmd: subcmd, flags, engine, repoPath });
}
