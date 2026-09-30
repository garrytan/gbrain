/**
 * `gbrain skillpack-check`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  // Agent-readable health report. Shells out to doctor + apply-migrations
  // internally; does not need its own DB connection.
  const { runSkillpackCheck } = await import('../../commands/skillpack-check.ts');
  await runSkillpackCheck(args);
}
