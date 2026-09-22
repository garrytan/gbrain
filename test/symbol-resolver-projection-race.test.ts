import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { resolveSymbolEdgesIncremental } from '../src/core/chunkers/symbol-resolver.ts';
import { resolveCodeReadiness } from '../src/core/code-graph-readiness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function instrumentTransactions(engine: BrainEngine, wrap: (tx: BrainEngine) => BrainEngine): BrainEngine {
  const wrapped = Object.create(engine) as BrainEngine;
  wrapped.transaction = <T>(run: (tx: BrainEngine) => Promise<T>) => engine.transaction(tx => run(wrap(tx)));
  return wrapped;
}

describe('symbol resolver and projection replacement serialization', () => {
  let lite: PGLiteEngine;
  let pg: Awaited<ReturnType<typeof isolatedPersistencePostgres>> | undefined;

  beforeAll(async () => {
    lite = new PGLiteEngine();
    await lite.connect({});
    await lite.initSchema();
    if (process.env.DATABASE_URL) pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
  }, 120_000);

  afterAll(async () => {
    await lite?.disconnect();
    await pg?.close();
  }, 60_000);

  async function seed(engine: BrainEngine, sourceId: string) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const { slug } = await importCodeFile(engine, 'example.ts',
      'export function betaExample() { return 3; }\nexport function alphaExample() { return betaExample(); }\n',
      { sourceId, noEmbed: true });
    const snapshot = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const projection = await preparePageProjection(snapshot);
    return { slug, snapshot, projection };
  }

  async function edges(engine: BrainEngine, sourceId: string) {
    return engine.executeRaw<{ id: number; from_chunk_id: number; edge_metadata: Record<string, unknown> | null }>(
      'SELECT id,from_chunk_id,edge_metadata FROM code_edges_symbol WHERE source_id=$1 ORDER BY id', [sourceId]);
  }

  async function watermarks(engine: BrainEngine, sourceId: string) {
    return engine.executeRaw<{ id: number; edges_backfilled_at: Date | string | null }>(
      `SELECT cc.id,cc.edges_backfilled_at FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
       WHERE p.source_id=$1 ORDER BY cc.id`, [sourceId]);
  }

  async function replacementRace(engine: BrainEngine) {
    const sourceId = `resolver-race-${engine.kind}`;
    const { slug, snapshot, projection } = await seed(engine, sourceId);
    const originalEdges = await edges(engine, sourceId);
    expect(originalEdges).toHaveLength(1);
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    let transactionEntered = false;
    let guardsAcquired = false;
    let publisherEntered = false;
    let publisherCompleted = false;
    let resolverPid: number | undefined;
    const resolverEngine = instrumentTransactions(engine, tx => {
      transactionEntered = true;
      const wrapped = Object.create(tx) as BrainEngine;
      wrapped.lockPageKeys = async keys => {
        expect(keys.every(key => key.sourceId === sourceId && key.slug === slug)).toBe(true);
        await tx.lockPageKeys(keys);
        guardsAcquired = true;
        events.push('resolver-locked');
      };
      wrapped.executeRaw = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        const rows = await tx.executeRaw<T>(sql, params);
        if (sql.includes('SELECT id, from_chunk_id')) {
          expect(guardsAcquired).toBe(true);
          expect(rows).toHaveLength(1);
          if (engine.kind === 'postgres') {
            resolverPid = (await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0].pid;
          }
          entered.resolve();
          await bounded(release.promise, 'resolver release', 20_000);
        }
        if (sql.includes('SET edges_backfilled_at = NOW()')) events.push('resolver-stamped');
        return rows;
      };
      return wrapped;
    });
    const resolver = resolveSymbolEdgesIncremental(resolverEngine, { sourceId, maxChunks: snapshot.chunks.length });
    void resolver.catch(() => {});
    let publisher: Promise<void> | undefined;
    try {
      await bounded(entered.promise, 'resolver edge read');
      expect(transactionEntered).toBe(true);
      const publisherEngine = instrumentTransactions(engine, tx => {
        publisherEntered = true;
        const wrapped = Object.create(tx) as BrainEngine;
        wrapped.lockPageKeys = async keys => {
          if (engine.kind === 'postgres') {
            await tx.executeRaw("SELECT set_config('application_name',$1,true),set_config('lock_timeout','15s',true)", [sourceId]);
          }
          await tx.lockPageKeys(keys);
          events.push('publisher-locked');
        };
        return wrapped;
      });
      publisher = installPageProjection(publisherEngine, snapshot, projection.chunks,
        { seal: true, preserveEmbeddings: true, code: projection.code }).then(() => {
        publisherCompleted = true;
        events.push('publisher-completed');
      });
      void publisher.catch(() => {});
      if (engine.kind === 'postgres') {
        await bounded((async () => {
          const deadline = performance.now() + 8_000;
          while (performance.now() < deadline) {
            const rows = await engine.executeRaw<{ blocked: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
               WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'
                 AND $2::int=ANY(pg_blocking_pids(pid))) AS blocked`, [sourceId, resolverPid]);
            if (rows[0].blocked) return;
            await delay(20);
          }
          throw new Error('Publisher never reported a database lock wait');
        })(), 'publisher database lock receipt');
        expect(publisherEntered).toBe(true);
      } else {
        await delay(20);
        expect(publisherEntered).toBe(false);
      }
      expect(publisherCompleted).toBe(false);
      expect(events).toEqual(['resolver-locked']);
      release.resolve();
      expect((await bounded(resolver, 'resolver completion')).edges_resolved).toBe(1);
      await bounded(publisher, 'projection replacement');
      expect(events.slice(0, 2)).toEqual(['resolver-locked', 'resolver-stamped']);
      expect(events.slice(2, -1).length).toBeGreaterThan(0);
      expect(events.slice(2, -1).every(event => event === 'publisher-locked')).toBe(true);
      expect(events.at(-1)).toBe('publisher-completed');
      const replacedEdges = await edges(engine, sourceId);
      expect(replacedEdges).toHaveLength(1);
      expect(replacedEdges[0].id).not.toBe(originalEdges[0].id);
      expect(replacedEdges[0].edge_metadata?.resolved_chunk_id).toBeUndefined();
      const after = await watermarks(engine, sourceId);
      expect(after.map(chunk => chunk.id)).toEqual(snapshot.chunks.map(chunk => chunk.id));
      expect(after.every(chunk => chunk.edges_backfilled_at === null)).toBe(true);
      expect(await resolveCodeReadiness(engine, { sourceId, kind: 'edge', count: 0, remote: false }))
        .toMatchObject({ status: 'indexing', ready: false, pending_edges: true });
      const next = await resolveSymbolEdgesIncremental(engine, { sourceId });
      expect(next.chunks_walked).toBe(snapshot.chunks.length);
      expect(next.edges_resolved).toBe(1);
      expect(typeof (await edges(engine, sourceId))[0].edge_metadata?.resolved_chunk_id).toBe('number');
      expect(await resolveCodeReadiness(engine, { sourceId, kind: 'edge', count: 0, remote: false }))
        .toMatchObject({ status: 'ready', ready: true, pending_edges: false });
    } finally {
      release.resolve();
      await bounded(Promise.allSettled([resolver, ...(publisher ? [publisher] : [])]), 'race cleanup', 25_000);
    }
  }

  test('PGlite queues actual projection replacement behind the paused resolver transaction', async () => {
    await replacementRace(lite);
  }, 60_000);

  test.skipIf(!process.env.DATABASE_URL)('Postgres reports the actual publisher waiting on the resolver page guard', async () => {
    await replacementRace(pg!.engine);
  }, 60_000);

  test('a failure after edge updates rolls metadata and watermarks back together', async () => {
    for (const engine of [lite, ...(pg ? [pg.engine] : [])]) {
      const sourceId = `resolver-rollback-${engine.kind}`;
      await seed(engine, sourceId);
      const beforeEdges = await edges(engine, sourceId);
      const beforeWatermarks = await watermarks(engine, sourceId);
      let wroteMetadata = false;
      const failing = instrumentTransactions(engine, tx => {
        const wrapped = Object.create(tx) as BrainEngine;
        wrapped.executeRaw = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
          if (sql.includes('SET edges_backfilled_at = NOW()')) {
            expect(wroteMetadata).toBe(true);
            expect(typeof (await edges(tx, sourceId))[0].edge_metadata?.resolved_chunk_id).toBe('number');
            throw new Error('injected resolver watermark failure');
          }
          const result = await tx.executeRaw<T>(sql, params);
          if (sql.includes('UPDATE code_edges_symbol')) wroteMetadata = true;
          return result;
        };
        return wrapped;
      });
      await expect(resolveSymbolEdgesIncremental(failing, { sourceId })).rejects.toThrow('injected resolver watermark failure');
      expect(wroteMetadata).toBe(true);
      expect(await edges(engine, sourceId)).toEqual(beforeEdges);
      expect(await watermarks(engine, sourceId)).toEqual(beforeWatermarks);
      expect((await resolveSymbolEdgesIncremental(engine, { sourceId })).edges_resolved).toBe(1);
    }
  }, 60_000);

  test('candidates are revalidated under the page guard before any metadata or watermark update', async () => {
    for (const engine of [lite, ...(pg ? [pg.engine] : [])]) {
      for (const change of ['watermark', 'projection', 'archive', 'slug'] as const) {
        const sourceId = `resolver-stale-${engine.kind}-${change}`;
        const { snapshot } = await seed(engine, sourceId);
        const beforeEdges = await edges(engine, sourceId);
        let invalidated = false;
        let locked = false;
        let revalidated = false;
        let readEdges = false;
        const stale = instrumentTransactions(engine, tx => {
          const wrapped = Object.create(tx) as BrainEngine;
          wrapped.lockPageKeys = async keys => { await tx.lockPageKeys(keys); locked = true; };
          wrapped.executeRaw = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            const rows = await tx.executeRaw<T>(sql, params);
            if (!invalidated && sql.includes('SELECT cc.id, cc.page_id, p.slug') && sql.includes('LIMIT $3')) {
              expect(rows.length).toBeGreaterThan(0);
              invalidated = true;
              if (change === 'watermark') await tx.executeRaw("UPDATE content_chunks SET edges_backfilled_at='2099-01-01' WHERE page_id=$1", [snapshot.snapshot.page.id]);
              if (change === 'projection') await tx.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [snapshot.snapshot.page.id]);
              if (change === 'archive') await tx.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
              if (change === 'slug') await tx.executeRaw("UPDATE pages SET slug='moved-example' WHERE id=$1", [snapshot.snapshot.page.id]);
            }
            if (sql.includes('SELECT cc.id, cc.page_id, p.slug') && sql.includes('cc.id=ANY')) {
              expect(locked).toBe(true);
              revalidated = true;
            }
            if (sql.includes('SELECT id, from_chunk_id')) readEdges = true;
            return rows;
          };
          return wrapped;
        });
        expect(await resolveSymbolEdgesIncremental(stale, { sourceId })).toMatchObject({ chunks_walked: 0, edges_examined: 0, batches: 0 });
        expect(invalidated).toBe(true);
        expect(locked).toBe(true);
        expect(revalidated).toBe(true);
        expect(readEdges).toBe(false);
        expect(await edges(engine, sourceId)).toEqual(beforeEdges);
        const after = await watermarks(engine, sourceId);
        expect(after).toHaveLength(snapshot.chunks.length);
        expect(after.every(chunk => change === 'watermark'
          ? new Date(chunk.edges_backfilled_at!).getUTCFullYear() === 2099
          : chunk.edges_backfilled_at === null)).toBe(true);
      }
    }
  }, 60_000);
});
