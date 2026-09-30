/**
 * `gbrain bench`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  if (args[0] === 'publish') {
    const { runBenchPublish } = await import('../../commands/bench-publish.ts');
    await runBenchPublish(args.slice(1));
    return;
  }
  console.error('Usage: gbrain bench publish --from <captured.ndjson> --to <X.baseline.ndjson> [flags]');
  console.error('Run `gbrain bench publish --help` for the full flag list.');
  process.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 2);
}
