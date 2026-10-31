/**
 * PR 4 E round 2 (gbrain-evals#180): the per-page embedding lease (src/core/page-embedding-lease.ts) under contention.
 *
 * 1. Protects: a path that finds a page's lease held gives up at its deadline (or after one TTL) with a busy lease
 *    instead of waiting forever; a holder whose lease was taken over during its provider call installs nothing;
 *    `embedStalePages` reads the page under the lease; a release deletes the expired `embed-page:` rows a dead
 *    holder left (doctor `stale_locks` clears); a holder that throws releases its lease; and activation's legacy-lock
 *    inspection and deactivation's lease blockers leave page embedding leases out, live or expired.
 * 2. Fails when: the wait loop has no bound, the install skips the lease renewal, the drain reads its snapshot before
 *    the lease, expired lease rows stay, or an error path skips the release. Each test holds the lease itself or
 *    steals it inside the provider call, so every contention is forced, never timed.
 * 3. The provider is an injected embedFn or the gateway's transport seam: no network, no spend. PGLite always;
 *    PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Serial: the transport and the lease probe are
 *    process-wide.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppendBrain, type AppendBrain } from './helpers/append-brain.ts';
import { pendingEmbedPage } from './helpers/pending-embed-page.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../src/core/search/embedding-column.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';
import { acquirePageEmbeddingLease, pageEmbeddingLeaseId, pageEmbeddingLeaseProbe } from '../src/core/page-embedding-lease.ts';
import { embedStaleForSource, embedStalePages } from '../src/core/embed-stale.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { listStaleLocks, tryAcquireDbLock } from '../src/core/db-lock.ts';
import { inspectLegacyWriterLocks } from '../src/core/persistence/legacy-locks.ts';
import { deactivationBlockers } from '../src/core/persistence/deactivation.ts';
import { checkStaleLocks } from '../src/commands/doctor/checks/routing-federation.ts';

const CHUNKS = ['Alpha example chunk about the acme-example ledger.', 'Beta example chunk about the quarterly report.', 'Gamma example chunk about the roadmap.'];

for (const kind of testBackends()) {
  describe(`page embedding lease under contention (${kind})`, () => {
    let brain: AppendBrain;
    let home: string;
    let dims: number;
    const sent: string[] = [];
    const vector = () => Float32Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0));
    /** The injected provider: records each input and answers unit vectors. */
    const embedFn = async (texts: string[]) => { sent.push(...texts); return texts.map(vector); };
    /** The gateway provider the embedding effect calls; `during` runs inside the call, before it answers. */
    const transport = (during?: () => Promise<void>) => __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      sent.push(...values);
      await during?.();
      return { embeddings: values.map(() => Array.from(vector())), usage: { tokens: values.length } };
    }) as never);
    const vectorless = async (sourceId: string, slug = 'page') => (await brain.engine.executeRaw<{ chunk_text: string }>(
      `SELECT cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
        WHERE p.source_id=$1 AND p.slug=$2 AND cc.embedding IS NULL AND ${chunkGenerationFilter('p', 'cc')} ORDER BY cc.chunk_index`, [sourceId, slug])).map(r => r.chunk_text);
    const leaseRows = async (pageId: number) => brain.engine.executeRaw<{ acquisition_token: string }>(
      'SELECT acquisition_token FROM gbrain_cycle_locks WHERE id=$1', [pageEmbeddingLeaseId(pageId)]);
    const steal = (pageId: number) => brain.engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=$2::uuid WHERE id=$1', [pageEmbeddingLeaseId(pageId), randomUUID()]);
    const runEffect = async (effectId: string) => {
      await brain.engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [effectId]);
      await runPersistenceEffects(brain.engine, { engine: brain.engine.kind }, { hostId: localHostId(), limit: 1 });
      return (await brain.engine.executeRaw<{ state: string; error_code: string | null }>('SELECT state,error_code FROM persistence_effects WHERE id=$1', [effectId]))[0]!;
    };
    const pending = () => withEnv({ GBRAIN_HOME: home }, () => pendingEmbedPage(brain.engine, CHUNKS));

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      dims = (await resolveActiveEmbeddingColumnFromEngine(brain.engine)).dimensions;
      home = mkdtempSync(join(tmpdir(), 'gbrain-embed-lease-'));
    }, 600_000);
    afterEach(async () => {
      // A stolen lease row carries a token no holder releases; it would outlive its test until the TTL.
      await brain.engine.executeRaw("DELETE FROM gbrain_cycle_locks WHERE id LIKE 'embed-page:%'");
      sent.length = 0;
      pageEmbeddingLeaseProbe.contended = undefined;
      pageEmbeddingLeaseProbe.waitBoundMs = undefined;
      transport();
    });
    afterAll(async () => {
      await brain.close();
      rmSync(home, { recursive: true, force: true });
    }, 120_000);

    test('a waiter gives up at its deadline with a busy lease, and the holder keeps the page', async () => {
      const { pageId } = await pending();
      await using _holder = await acquirePageEmbeddingLease(brain.engine, pageId);
      const [held] = await leaseRows(pageId);
      let contended = 0;
      pageEmbeddingLeaseProbe.contended = () => { contended++; };
      const waiter = await acquirePageEmbeddingLease(brain.engine, pageId, { deadline: Date.now() + 300 });
      expect(waiter.busy).toBe(true);
      expect(contended).toBeGreaterThan(0);
      expect(await leaseRows(pageId)).toEqual([held!]);
    }, 30_000);

    test('a stale drain skips a page another path holds past the drain deadline: nothing sent, no failure', async () => {
      const { sourceId, pageId } = await pending();
      await using _holder = await acquirePageEmbeddingLease(brain.engine, pageId);
      let contended = 0;
      pageEmbeddingLeaseProbe.contended = () => { contended++; };
      const result = await embedStaleForSource(brain.engine, sourceId, { embedFn, concurrency: 1, deadline: Date.now() + 2_000 });
      expect(contended).toBeGreaterThan(0);
      expect(sent).toEqual([]);
      expect(result.failures ?? 0).toBe(0);
      expect(await vectorless(sourceId)).toEqual(CHUNKS);
    }, 30_000);

    test('the embedding effect gives up after its wait bound and retries with lock_busy, sending nothing', async () => {
      const { sourceId, effectId, pageId } = await pending();
      await using _holder = await acquirePageEmbeddingLease(brain.engine, pageId);
      pageEmbeddingLeaseProbe.waitBoundMs = 300;
      let contended = 0;
      pageEmbeddingLeaseProbe.contended = () => { contended++; };
      const effect = await withEnv({ GBRAIN_HOME: home }, () => runEffect(effectId));
      expect(contended).toBeGreaterThan(0);
      expect(effect).toMatchObject({ state: 'queued', error_code: 'lock_busy' });
      expect(sent).toEqual([]);
      expect(await vectorless(sourceId)).toEqual(CHUNKS);
    }, 30_000);

    test('a stale drain whose lease is taken over during the provider call installs nothing', async () => {
      const { sourceId, pageId } = await pending();
      const result = await embedStalePages(brain.engine, ['page'], sourceId, { embedFn: async texts => { await steal(pageId); return embedFn(texts); } });
      expect(sent.length).toBe(CHUNKS.length);
      expect(result.embedded).toBe(0);
      expect(await vectorless(sourceId)).toEqual(CHUNKS);
    }, 30_000);

    test('the embedding effect whose lease is taken over during the provider call installs nothing and retries', async () => {
      const { sourceId, effectId, pageId } = await pending();
      transport(async () => { await steal(pageId); });
      const effect = await withEnv({ GBRAIN_HOME: home }, () => runEffect(effectId));
      expect(sent.length).toBe(CHUNKS.length);
      expect(effect).toMatchObject({ state: 'queued', error_code: 'lock_busy' });
      expect(await vectorless(sourceId)).toEqual(CHUNKS);
    }, 30_000);

    test('embedStalePages reads the page under its lease: a rewrite while it waits is what it sends', async () => {
      const { sourceId, pageId } = await pending();
      const REWRITTEN = CHUNKS.map(text => text.replace('example chunk', 'rewritten chunk'));
      const holder = await acquirePageEmbeddingLease(brain.engine, pageId);
      const waiting = new Promise<void>(resolve => { pageEmbeddingLeaseProbe.contended = () => resolve(); });
      const drained = embedStalePages(brain.engine, ['page'], sourceId, { embedFn });
      await waiting;
      const prepared = (await readProjectionSnapshot(brain.engine, 'page', sourceId))!;
      await installPageProjection(brain.engine, prepared, REWRITTEN.map((chunk_text, chunk_index) => ({ chunk_index, chunk_source: 'compiled_truth' as const, chunk_text })), { seal: true });
      await holder[Symbol.asyncDispose]();
      const result = await drained;
      expect(sent.filter(input => CHUNKS.some(text => input.endsWith(text)))).toEqual([]);
      expect(sent.length).toBe(REWRITTEN.length);
      expect(REWRITTEN.every(text => sent.some(input => input.endsWith(text)))).toBe(true);
      expect(result.embedded).toBe(REWRITTEN.length);
      expect(await vectorless(sourceId)).toEqual([]);
    }, 30_000);

    test('a release deletes the expired embed-page rows a dead holder left, so doctor stale_locks clears; other locks stay', async () => {
      const { sourceId } = await pending();
      const dead = 'embed-page:987654321';
      const sync = `gbrain-sync:lease-test-${randomUUID()}`;
      for (const id of [dead, sync]) {
        await brain.engine.executeRaw(`INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
          VALUES ($1, 999999, 'host-a', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour', $2::uuid)`, [id, randomUUID()]);
      }
      expect((await listStaleLocks(brain.engine)).map(l => l.id)).toContain(dead);
      const result = await embedStalePages(brain.engine, ['page'], sourceId, { embedFn });
      expect(result.embedded).toBe(CHUNKS.length);
      const stale = (await listStaleLocks(brain.engine)).map(l => l.id);
      expect(stale.filter(id => id.startsWith('embed-page:'))).toEqual([]);
      expect(stale).toContain(sync);
      await brain.engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [sync]);
      expect((await checkStaleLocks(brain.engine)).status).toBe('ok');
    }, 30_000);

    test('activation legacy locks and deactivation lease blockers leave page embedding leases out, live or expired; a writer lock still shows', async () => {
      const { pageId } = await pending();
      const expired = 'embed-page:987654322';
      await brain.engine.executeRaw(`INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
        VALUES ($1, 999999, 'host-a', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour', $2::uuid)`, [expired, randomUUID()]);
      const writer = (await tryAcquireDbLock(brain.engine, `gbrain-sync:lease-test-${randomUUID()}`))!;
      try {
        await using _live = await acquirePageEmbeddingLease(brain.engine, pageId);
        expect((await brain.engine.executeRaw<{ id: string }>("SELECT id FROM gbrain_cycle_locks WHERE id LIKE 'embed-page:%' ORDER BY id")).map(r => r.id))
          .toEqual([pageEmbeddingLeaseId(pageId), expired].sort());
        expect((await inspectLegacyWriterLocks(brain.engine)).map(l => l.id)).toEqual([writer.id]);
        expect((await deactivationBlockers(brain.engine)).filter(b => b.kind === 'lease').map(b => b.id)).toEqual([writer.id]);
      } finally {
        await writer.release();
        await brain.engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [expired]);
      }
    }, 30_000);

    test('a holder that throws releases its lease: the drain, the effect and a bare holder', async () => {
      const failing = async (): Promise<Float32Array[]> => { throw new Error('provider refused'); };
      const drainPage = await pending();
      expect((await embedStalePages(brain.engine, ['page'], drainPage.sourceId, { embedFn: failing })).embedded).toBe(0);
      expect(await leaseRows(drainPage.pageId)).toEqual([]);

      const effectPage = await pending();
      __setEmbedTransportForTests((async () => { throw new Error('provider refused'); }) as never);
      const effect = await withEnv({ GBRAIN_HOME: home }, () => runEffect(effectPage.effectId));
      expect(effect.state).not.toBe('committed');
      expect(await leaseRows(effectPage.pageId)).toEqual([]);

      const barePage = await pending();
      await expect((async () => {
        await using _lease = await acquirePageEmbeddingLease(brain.engine, barePage.pageId);
        throw new Error('holder failed');
      })()).rejects.toThrow('holder failed');
      expect(await leaseRows(barePage.pageId)).toEqual([]);

      let contended = 0;
      pageEmbeddingLeaseProbe.contended = () => { contended++; };
      for (const { pageId } of [drainPage, effectPage, barePage]) {
        await using _next = await acquirePageEmbeddingLease(brain.engine, pageId, { deadline: Date.now() });
        expect((await leaseRows(pageId)).length).toBe(1);
      }
      expect(contended).toBe(0);
    }, 30_000);
  });
}
