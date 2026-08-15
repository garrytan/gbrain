// Guard self-test fixture (known-BAD): positional $N::jsonb + JSON.stringify
// in the same call span — the #2339 shape that aborted every sync.
declare const engine: { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]> };
declare const x: Record<string, unknown>;
export async function bad(): Promise<void> {
  await engine.executeRaw(`UPDATE op_checkpoints SET pin = $1::jsonb WHERE id = $2`, [JSON.stringify(x), 1]);
}
