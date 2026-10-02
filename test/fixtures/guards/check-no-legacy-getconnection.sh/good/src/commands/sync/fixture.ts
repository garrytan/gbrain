// Guard self-test fixture (known-GOOD): a sync phase uses ctx.engine.
declare const ctx: { engine: { executeRaw: (sql: string) => Promise<unknown[]> } };
export function probe(): Promise<unknown[]> {
  return ctx.engine.executeRaw('SELECT 1');
}
