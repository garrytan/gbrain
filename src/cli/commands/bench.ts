/**
 * `gbrain bench`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { jsonRequested } from '../../core/cli-force-exit.ts';
import { usageError, writeCliRefusal } from '../cli-error.ts';

export async function run(args: string[]): Promise<void> {
  if (args[0] === 'publish') {
    const { runBenchPublish } = await import('../../commands/bench-publish.ts');
    await runBenchPublish(args.slice(1));
    return;
  }
  const usage = 'Usage: gbrain bench publish --from <captured.ndjson> --to <X.baseline.ndjson> [flags]';
  if (args[0] === '--help' || args[0] === '-h') {
    console.error(usage);
    console.error('Run `gbrain bench publish --help` for the full flag list.');
    process.exit(0);
  }
  process.exit(writeCliRefusal(usageError(args[0] && !args[0].startsWith('-') ? `Unknown bench subcommand: ${args[0]}.` : 'gbrain bench needs a subcommand (publish).',
    'Run `gbrain bench publish --help` for the full flag list.'), 'bench',
  { json: jsonRequested(args), human: `${usage}\nRun \`gbrain bench publish --help\` for the full flag list.` }));
}
