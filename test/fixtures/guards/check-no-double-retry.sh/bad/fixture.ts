// Guard self-test fixture (known-BAD): the CANONICAL banned shape — the exact
// arrow-fn form the pre-W0 regex could not match ([^)]* stopped at `() =>`).
declare const engine: { addLinksBatch: (rows: unknown[]) => Promise<void> };
declare function withRetry<T>(fn: () => Promise<T>, opts?: unknown): Promise<T>;
declare const rows: unknown[];
declare const BULK_RETRY_OPTS: unknown;
export async function bad(): Promise<void> {
  await withRetry(() => engine.addLinksBatch(rows), BULK_RETRY_OPTS);
}
