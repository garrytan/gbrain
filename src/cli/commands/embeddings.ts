/**
 * `gbrain embeddings`: pre-connect dispatch (opens the selected brain's own
 * engine), run by handleCliOnly before the connectEngine() terminator. The
 * record lives in src/cli/command-table.ts.
 */
export async function run(args: string[]): Promise<void> {
  const { runEmbeddings } = await import('../../commands/embeddings.ts');
  await runEmbeddings(args);
}
