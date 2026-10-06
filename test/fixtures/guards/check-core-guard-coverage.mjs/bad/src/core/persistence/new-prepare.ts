type PreparedMutation = { observedRevision: string | null };
export async function prepareNew(): Promise<PreparedMutation> {
  return { observedRevision: null };
}
