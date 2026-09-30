// Guard self-test fixture (known-BAD, refactor wave 1 module dir): positional
// $N::jsonb + JSON.stringify (the #2339 shape) inside src/commands/sync/.
declare const engine: { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]> };
declare const x: Record<string, unknown>;
export async function bad(): Promise<void> {
  await engine.executeRaw(`UPDATE op_checkpoints SET pin = $1::jsonb WHERE id = $2`, [JSON.stringify(x), 1]);
}
