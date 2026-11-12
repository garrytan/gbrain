/**
 * Child process for test/persistence-stuck-head-9227.test.ts: one `put_page` that stops at a named fault seam and
 * waits there, so the parent can SIGKILL the process at that point and read what the death leaves behind.
 * Argument: a JSON config file. Prints one JSON line per event on stdout: `{event:'boundary', point}` when it reaches
 * the seam for its own request, then nothing more (the parent kills it); without a seam, `{event:'done', state, ms}` or
 * `{event:'failure', code, message}`.
 * GBRAIN_HOME is the parent's, so both processes are the same host.
 */
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operations } from '../../src/core/operations.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';

export interface StuckHeadWorkerConfig {
  engine: 'pglite' | 'postgres';
  databasePath?: string;
  databaseUrl?: string;
  sourceId: string;
  slug: string;
  content: string;
  requestId: string;
  /** Absent: the write runs to its end and the worker reports its state and how long it took. */
  point?: FaultPoint;
  /** The reply deadline (default 30000, the most a write may wait). */
  waitMs?: number;
  /** A remote OAuth caller instead of the local CLI writer. */
  auth?: Record<string, unknown>;
}

const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (import.meta.main) {
  const config: StuckHeadWorkerConfig = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
  const engine = config.engine === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
  try {
    await engine.connect(config.engine === 'pglite' ? { engine: 'pglite', database_path: config.databasePath } : { database_url: config.databaseUrl, poolSize: 4 });
    if (config.point) installFaultHook(async (point, detail) => {
      if (point !== config.point || detail.requestId !== config.requestId) return;
      emit({ event: 'boundary', point });
      await new Promise(() => {});
    });
    const put = operations.find(op => op.name === 'put_page')!;
    const started = performance.now();
    const out = await put.handler({ engine, config: { engine: config.engine, embedding_disabled: true } as never, logger: { info() {}, warn() {}, error() {} },
      dryRun: false, remote: config.auth !== undefined, sourceId: config.sourceId, ...(config.auth ? { auth: config.auth as never } : {}) },
    { slug: config.slug, content: config.content, request_id: config.requestId, wait_ms: config.waitMs ?? 30_000 });
    emit({ event: 'done', state: (out as { state?: string }).state ?? null, ms: Math.round(performance.now() - started) });
    process.exit(0);
  } catch (error) {
    emit({ event: 'failure', code: (error as { code?: string }).code ?? null, message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}
