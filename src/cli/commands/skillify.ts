/**
 * `gbrain skillify`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  const { runSkillify } = await import('../../commands/skillify.ts');
  // `args` here is subArgs (command already stripped by caller), so
  // args[0] is the subcommand (scaffold|check).
  await runSkillify(args);
}
