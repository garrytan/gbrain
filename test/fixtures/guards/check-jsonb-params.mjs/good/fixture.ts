// Guard self-test fixture (known-GOOD): the text-hop positional spelling.
declare const engine: { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]> };
declare const x: Record<string, unknown>;
export async function good(): Promise<void> {
  await engine.executeRaw(`UPDATE op_checkpoints SET pin = $1::text::jsonb WHERE id = $2`, [JSON.stringify(x), 1]);
}
