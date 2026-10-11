/** The take-embedding installer must lock source/page rows before take rows. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { embedStaleTakes } from '../../src/core/embed-takes.ts';
import { getEmbeddingDimensions } from '../../src/core/ai/gateway.ts';
import { getEngine, hasDatabase, setupLegacyEmbeddingDB, teardownDB } from './helpers.ts';

const run = hasDatabase() ? describe : describe.skip;
const settle = <T>(promise: Promise<T>) => promise.then(
  value => ({ ok: true as const, value }),
  error => ({ ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }),
);

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Postgres did not show the expected lock wait');
}

run('take embedding page-before-take lock order (Postgres)', () => {
  let monitor: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await setupLegacyEmbeddingDB();
    monitor = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  });
  afterAll(async () => {
    await monitor?.end();
    await teardownDB();
  });

  test('a concurrent canonical claim update commits while embedding waits on its page', async () => {
    const engine = getEngine();
    const [{ database }] = await engine.executeRaw<{ database: string }>('SELECT current_database() AS database');
    const [{ before }] = await engine.executeRaw<{ before: number }>(
      'SELECT deadlocks::int AS before FROM pg_stat_database WHERE datname = current_database()',
    );
    const rounds = 10;
    for (let round = 0; round < rounds; round++) {
      const page = await engine.putPage(`notes/take-lock-order-${round}`, {
        title: `Take lock order ${round}`, type: 'note', compiled_truth: 'A synthetic stale take claim.',
      });
      await engine.addTakesBatch([{
        page_id: page.id, row_num: 1, claim: `Original synthetic claim ${round}`,
        kind: 'fact', holder: 'world', weight: 1,
      }]);

      let embeddingReady!: () => void;
      const ready = new Promise<void>(resolve => { embeddingReady = resolve; });
      let allowInstall!: () => void;
      const installAllowed = new Promise<void>(resolve => { allowInstall = resolve; });
      let writerHasPage!: (pid: number) => void;
      const pageHeld = new Promise<number>(resolve => { writerHasPage = resolve; });
      let allowWriter!: () => void;
      const writerAllowed = new Promise<void>(resolve => { allowWriter = resolve; });
      let installerAtGuard!: (pid: number) => void;
      const installerGuarded = new Promise<number>(resolve => { installerAtGuard = resolve; });

      const embedding = settle(embedStaleTakes(engine, {
        sourceId: 'default',
        embedFn: async texts => {
          expect(texts).toEqual([`Original synthetic claim ${round}`]);
          embeddingReady();
          await installAllowed;
          return texts.map(() => new Float32Array(getEmbeddingDimensions()).fill(0.25));
        },
        assertOwned: async tx => {
          await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
          const [{ pid }] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          installerAtGuard(Number(pid));
        },
      }));

      let writer: ReturnType<typeof settle<unknown>> | undefined;
      try {
        await ready;
        writer = settle(engine.transaction(async tx => {
          await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
          await tx.executeRaw('SELECT id FROM sources WHERE id = $1 FOR SHARE', ['default']);
          await tx.executeRaw('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [page.id]);
          const [{ pid }] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          writerHasPage(Number(pid));
          await writerAllowed;
          await tx.executeRaw('UPDATE takes SET claim = $1 WHERE page_id = $2 AND row_num = 1', [`Changed synthetic claim ${round}`, page.id]);
        }));
        const writerPid = await pageHeld;
        allowInstall();
        const installerPid = await installerGuarded;
        await waitFor(async () => {
          const [row] = await monitor<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity
             WHERE pid = ${installerPid} AND wait_event_type = 'Lock'
               AND ${writerPid} = ANY(pg_blocking_pids(pid))`;
          return row ? true : undefined;
        });
        allowWriter();

        const [writeResult, embeddingResult] = await Promise.all([writer, embedding]);
        expect(writeResult.ok).toBe(true);
        expect(embeddingResult.ok).toBe(true);
        if (!embeddingResult.ok) continue;
        expect(embeddingResult.value).toMatchObject({ total_stale: 1, embedded: 0, discarded: 1, failures: 0 });
        const [take] = await engine.executeRaw<{ claim: string; embedding: string | null }>(
          'SELECT claim, embedding::text AS embedding FROM takes WHERE page_id = $1 AND row_num = 1', [page.id],
        );
        expect(take).toEqual({ claim: `Changed synthetic claim ${round}`, embedding: null });
        await engine.executeRaw('DELETE FROM takes WHERE page_id = $1', [page.id]);
      } finally {
        allowInstall();
        allowWriter();
        await Promise.all([embedding, ...(writer ? [writer] : [])]);
      }
    }

    const [{ after }] = await engine.executeRaw<{ after: number }>(
      'SELECT deadlocks::int AS after FROM pg_stat_database WHERE datname = $1', [database],
    );
    expect(Number(after) - Number(before)).toBe(0);
  }, 120_000);
});
