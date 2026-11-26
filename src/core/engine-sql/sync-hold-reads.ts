

/** The engine's own executeRaw, so a statement fault a test injects on the engine reaches the hold read. */
export interface HoldRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}
