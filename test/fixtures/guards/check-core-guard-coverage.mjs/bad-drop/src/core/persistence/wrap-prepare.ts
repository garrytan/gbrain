type PreparedMutation = { observedRevision: string | null };
declare function preparePageMutation(engine: unknown, row: unknown): Promise<PreparedMutation>;
export async function prepareWrap(engine: unknown, row: unknown): Promise<PreparedMutation> {
  const page = await preparePageMutation(engine, row);
  return { observedRevision: page.observedRevision };
}
