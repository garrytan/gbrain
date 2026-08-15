/**
 * `gbrain embed --stale --dry-run --background` ran for real.
 *
 * The CLI serializes the flag into the job payload (`dryRun:
 * cleanArgs.includes('--dry-run')` in embed.ts's job-args builder), but the
 * registered `embed` worker handler never read it back, so `runEmbedCore` was
 * invoked without `dryRun`. A backgrounded preview therefore called the
 * embedding provider and wrote vectors — API spend and NULL→vector mutation
 * from an invocation whose whole point was to do neither.
 *
 * Fourth instance of the class in #3594 ("fixing them one at a time will not
 * stop the fourth"), and a different shape from the three listed there: the
 * guard is neither late nor defaulted wrong, it is simply not wired to the
 * flag the CLI already sends. Same test shape as
 * jobs-unify-types-default-dryrun.test.ts (#1575).
 *
 * Behavioral pin: a job whose data carries dryRun must not embed or write.
 */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

/**
 * Hermetic transport. Without it the guard is only sound where no embedding
 * provider is configured: runEmbedCore catches provider failures into
 * `failures` and writes nothing, so an unfixed handler pointed at a broken
 * provider would also leave the count unchanged and pass. Counting calls
 * removes that window — a real run must call embedBatch, a dry run must not.
 */
let embedCalls = 0;
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedCalls++;
    return texts.map(() => new Float32Array(1536));
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function embedHandler() {
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine);
  const handler = (worker as unknown as {
    handlers: Map<string, (j: unknown) => Promise<unknown>>;
  }).handlers.get('embed');
  if (!handler) throw new Error('embed handler not registered');
  return handler;
}

/** Chunks that exist and carry no embedding — the input a real run consumes. */
async function seedStalePage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: 'note' as never,
    compiled_truth: 'body long enough to chunk and to survive any contentless backstop guard',
    timeline: '',
    frontmatter: {},
    source_path: `${slug}.md`,
  });
  // putPage alone leaves no chunks, and countStaleChunks would then return 0 —
  // the dry-run path would short-circuit and the write assertion below would
  // hold vacuously. Write the chunks directly, with no embedding, so the run
  // has real work to skip.
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: 'first chunk of the page', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'second chunk of the page', chunk_source: 'compiled_truth' },
  ]);
}

async function staleChunkCount(): Promise<number> {
  return await engine.countStaleChunks({});
}

async function embeddedChunkCount(): Promise<number> {
  const rows = (await engine.executeRaw(
    'SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL',
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

describe('embed worker honours dryRun from the job payload (#3594 class)', () => {
  it('a dryRun job embeds nothing', async () => {
    embedCalls = 0;
    await seedStalePage('bg-dryrun-check');
    // Coverage: without real stale chunks the dry-run path short-circuits and
    // every assertion below would hold for the wrong reason.
    expect(await staleChunkCount()).toBeGreaterThan(0);
    const before = await embeddedChunkCount();

    const handler = await embedHandler();
    // Exactly what `embed --stale --dry-run --background` queues.
    const result = (await handler({
      id: 1,
      data: { stale: true, dryRun: true },
      updateProgress: async () => {},
    })) as { embedded: number; dry_run: boolean; would_embed: number };

    // The job result must not claim work it did not do: `gbrain jobs get`
    // showed `embedded: true` for a dry run.
    expect(result.dry_run).toBe(true);
    expect(result.embedded).toBe(0);
    expect(result.would_embed).toBeGreaterThan(0);

    // The call counter is the primary signal: a real run must reach the
    // transport, a dry run must not. The write count is the secondary one —
    // #3594's point is that a dry-run test asserting only the return value
    // passes while the side effect happens underneath.
    expect(embedCalls).toBe(0);
    expect(await embeddedChunkCount()).toBe(before);
  }, 60_000);
});
