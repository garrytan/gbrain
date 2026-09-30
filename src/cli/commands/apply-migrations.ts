/**
 * `gbrain apply-migrations`: pre-connect dispatch (opens its own engine), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  // Does not need connectEngine — each phase (schema, smoke, host-rewrite)
  // manages its own subprocess or file-layer access directly. Avoids
  // connecting a second time when the orchestrator shells out to
  // `gbrain init --migrate-only` and `gbrain jobs smoke`.
  const { runApplyMigrations } = await import('../../commands/apply-migrations.ts');
  await runApplyMigrations(args);
}
