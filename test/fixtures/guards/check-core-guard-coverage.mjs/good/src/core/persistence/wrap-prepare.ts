type PreparedMutation = { observedRevision: string | null; exclusiveSources?: string[] };
declare function preparePageMutation(engine: unknown, row: unknown): Promise<PreparedMutation>;
export async function prepareWrap(engine: unknown, row: unknown): Promise<PreparedMutation> {
  const page = await preparePageMutation(engine, row);
  return { ...page };
}
