// Guard self-test fixture (known-BAD, multi-line): withRetry( on one line and
// the engine batch call two lines later — exercises the perl window pass
// (the single-line grep cannot see this shape).
declare const engine: { upsertChunks: (slug: string, chunks: unknown[]) => Promise<void> };
declare function withRetry<T>(fn: () => Promise<T>, opts?: unknown): Promise<T>;
declare const chunks: unknown[];
export async function badMultiline(): Promise<void> {
  await withRetry(
    async () =>
      engine.upsertChunks('slug', chunks),
  );
}
