/**
 * GST-1856: an ingest_capture job applies its capture once per idempotency key, so a run after the write landed never
 * reverts a newer edit.
 *
 * A worker that died or lost its lock after the page write committed, but before completion was recorded, handed the job
 * to another attempt (the stall sweep), and that attempt wrote the captured body over any edit made in between. A client
 * replaying a POST /ingest after `gbrain jobs prune` removed the completed job row got a fresh job that did the same.
 * Protects: a re-run of the key writes nothing and returns the first run's result (unmanaged, and managed through the
 * door's journal when the record row is missing); a replay after the job row is deleted leaves the newer edit; two
 * captures with different content to one slug both land in order, and re-running the first afterwards keeps the second.
 * Real token verifier, real Express route, the real ingest_capture handler; PGLite here, Postgres through
 * test/e2e/ingest-capture-applied-once-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { computeContentHash } from '../src/core/ingestion/types.ts';
import { appliedCaptureRequestPrefix, purgeStaleAppliedCaptures } from '../src/core/ingestion/applied-captures.ts';
import { MIGRATIONS, runMigrationSQL } from '../src/core/migrate.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SRC = 'source-a';

interface Brain { engine: BrainEngine; server: Server; base: string; token: string; close: () => Promise<void> }
const brains = new Map<string, Brain>();

async function openBrain(engine: BrainEngine, closeEngine: () => Promise<void>): Promise<Brain> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  const token = (await mintLegacyToken(engine, { name: 'applied-once-writer', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const app = express();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  mountWebhooks(app, {
    engine,
    resourceVerifier: provider,
    resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
    ingestRateLimiter: pass,
    githubWebhookLimiter: pass,
    broadcastEvent: () => {},
  } as unknown as ServeHttpContext);
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { engine, server, base, token, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await closeEngine(); } };
}

const backends = testBackends();
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    brains.set('pglite', await openBrain(pglite, () => pglite.disconnect()));
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    brains.set('postgres', await openBrain(pg.engine, pg.close));
  }
}, 120_000);
afterAll(async () => { for (const brain of brains.values()) await brain.close(); }, 60_000);

const jobCtx = (id: number, data: Record<string, unknown>, key: string | null, attempts = 0): MinionJobContext => ({ id, name: 'ingest_capture', data,
  attempts_made: attempts, idempotency_key: key, signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
  updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] });
/** Runs `sql` as a protocol-2 writer, which the writer fence requires of direct writes to journal and page rows. */
const asWriter = (engine: BrainEngine, sql: string, params: unknown[]) => engine.transaction(async tx => {
  await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol', '2', true)");
  await tx.executeRaw(sql, params);
});
type CaptureResult = Awaited<ReturnType<ReturnType<typeof makeIngestCaptureHandler>>>;
/** `engine` whose first readPageSnapshot (a managed capture's read just before its put) runs `meanwhile` first: the run stalls there. */
const stallBeforeSnapshot = (engine: BrainEngine, meanwhile: () => Promise<unknown>) => {
  let stalled = false;
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    if (prop !== 'readPageSnapshot' || stalled) return value.bind(target);
    stalled = true;
    return async (...args: unknown[]) => { await meanwhile(); return value.apply(target, args); };
  } });
};
const jsonData = (data: unknown) => (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown>;
const note = (title: string, line: string) => `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\n${line}\n`;
/** The data a webhook capture job carries for `content` sent to `slug` in `sourceId`. */
const captureData = (content: string, slug: string, sourceId: string) => ({ slug, sourceId, event: { source_id: 'webhook-client-example', source_kind: 'webhook',
  source_uri: 'mcp-webhook:client-example:1', received_at: new Date().toISOString(), content_type: 'text/markdown', content,
  content_hash: computeContentHash(content), untrusted_payload: true } });

for (const backend of backends) {
  describe(`ingest_capture applies a capture once per idempotency key (${backend})`, () => {
    const brain = () => brains.get(backend)!;
    const post = (body: string, slug: string) => fetch(`${brain().base}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${brain().token}`, 'content-type': 'text/markdown', 'x-gbrain-slug': slug },
      body,
    });
    const ingest = async (body: string, slug: string) => {
      const res = await post(body, slug);
      expect(res.status).toBe(202);
      return (await res.json() as { job_id: number }).job_id;
    };
    /** Runs a queued job the way the worker does: data and idempotency key from its row. */
    const runJob = async (id: number) => {
      const [row] = await brain().engine.executeRaw<{ data: unknown; idempotency_key: string | null }>('SELECT data, idempotency_key FROM minion_jobs WHERE id = $1', [id]);
      return makeIngestCaptureHandler(brain().engine)(jobCtx(id, jsonData(row!.data), row!.idempotency_key));
    };
    const complete = (id: number) => brain().engine.executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1", [id]);
    const pageText = async (slug: string) => (await brain().engine.readPageSnapshot(slug, { sourceId: SRC }))?.page.compiled_truth ?? '';

    test('a re-run of the job after its write landed keeps the newer edit and returns the first result', async () => {
      const slug = `notes/rerun-${backend}`;
      const data = captureData(note('Rerun capture', 'Captured body.'), slug, SRC);
      const key = `ingest:webhook:client-example:${SRC}:rerun-${backend}`;
      const run = makeIngestCaptureHandler(brain().engine);
      const first = await run(jobCtx(1, data, key));
      expect(first.status).toBe('imported');
      await importFromContent(brain().engine, slug, note('Rerun capture', 'Newer edit.'), { sourceId: SRC, noEmbed: true });
      // The stall sweep hands the job to another attempt: same row, same key, same attempts_made.
      expect(await run(jobCtx(1, data, key))).toEqual(first);
      expect(await pageText(slug)).toContain('Newer edit.');
      expect(await pageText(slug)).not.toContain('Captured body.');
      const [row] = await brain().engine.executeRaw<{ source_id: string; slug: string }>('SELECT source_id, slug FROM ingest_applied_captures WHERE idempotency_key = $1', [key]);
      expect(row).toEqual({ source_id: SRC, slug });
    });

    test('a POST replayed after its job row was pruned queues a job that keeps the newer edit', async () => {
      const slug = `notes/replay-${backend}`;
      const body = note('Replayed capture', 'Body from the integration.');
      const first = await ingest(body, slug);
      const firstResult = await runJob(first);
      expect(firstResult.status).toBe('imported');
      await complete(first);
      await importFromContent(brain().engine, slug, note('Replayed capture', 'Newer edit after the capture.'), { sourceId: SRC, noEmbed: true });
      await brain().engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [first]);

      const replay = await ingest(body, slug);
      expect(replay).not.toBe(first);
      expect(await runJob(replay)).toEqual(firstResult);
      expect(await pageText(slug)).toContain('Newer edit after the capture.');
      expect(await pageText(slug)).not.toContain('Body from the integration.');
    });

    test('a capture completed before the upgrade keeps the newer edit when its POST is replayed after the job row is pruned', async () => {
      const slug = `notes/pre-upgrade-${backend}`;
      const body = note('Pre-upgrade capture', 'Body captured before the upgrade.');
      const first = await ingest(body, slug);
      const firstResult = await runJob(first);
      await brain().engine.executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now(), result = $2::text::jsonb WHERE id = $1", [first, JSON.stringify(firstResult)]);
      // Before the upgrade nothing recorded the capture: the migration records it from the completed job.
      await brain().engine.executeRaw('DELETE FROM ingest_applied_captures WHERE slug = $1', [slug]);
      const migration = MIGRATIONS.find(m => m.name === 'ingest_applied_captures')!;
      await runMigrationSQL(brain().engine, migration, migration.sql!);
      await importFromContent(brain().engine, slug, note('Pre-upgrade capture', 'Newer edit after the upgrade.'), { sourceId: SRC, noEmbed: true });
      await brain().engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [first]);

      const replay = await ingest(body, slug);
      expect(await runJob(replay)).toEqual(firstResult);
      expect(await pageText(slug)).toContain('Newer edit after the upgrade.');
      expect(await pageText(slug)).not.toContain('Body captured before the upgrade.');
    });

    test('two captures with different content to one slug land in order, and a re-run of the first keeps the second', async () => {
      const slug = `notes/ordered-${backend}`;
      const one = await ingest(note('Ordered capture', 'First capture body.'), slug);
      expect((await runJob(one)).status).toBe('imported');
      await complete(one);
      expect(await pageText(slug)).toContain('First capture body.');
      const two = await ingest(note('Ordered capture', 'Second capture body.'), slug);
      expect(two).not.toBe(one);
      expect((await runJob(two)).status).toBe('imported');
      expect(await pageText(slug)).toContain('Second capture body.');
      expect((await runJob(one)).status).toBe('imported');
      expect(await pageText(slug)).toContain('Second capture body.');
      expect(await pageText(slug)).not.toContain('First capture body.');
    });

    // Two connections are needed to hold the record row uncommitted while the run writes, so this one is Postgres only.
    if (backend === 'postgres') test('a run that loses the record insert to a concurrent run rolls its page write back', async () => {
      const slug = `notes/concurrent-${backend}`;
      await importFromContent(brain().engine, slug, note('Concurrent capture', 'Edit already on the page.'), { sourceId: SRC, noEmbed: true });
      const data = captureData(note('Concurrent capture', 'Concurrent captured body.'), slug, SRC);
      const key = `ingest:webhook:client-example:${SRC}:concurrent-${backend}`;
      const stored = { slug, status: 'imported' as const, chunks: 0, untrusted_payload: true, source_kind: 'webhook', source_uri: 'mcp-webhook:client-example:1' };
      let inserted!: () => void, release!: () => void;
      const insertedP = new Promise<void>(resolve => { inserted = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const holder = brain().engine.transaction(async tx => {
        await tx.executeRaw('INSERT INTO ingest_applied_captures (idempotency_key, source_id, slug, result) VALUES ($1, $2, $3, $4::jsonb)', [key, SRC, slug, stored]);
        inserted();
        await held;
      });
      await insertedP;
      const run = makeIngestCaptureHandler(brain().engine)(jobCtx(4, data, key));
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        await Bun.sleep(50);
        blocked = (await brain().engine.executeRaw<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO ingest_applied_captures%'"))[0]!.n > 0;
      }
      release();
      await holder;
      expect(blocked).toBe(true);
      expect(await run).toEqual(stored);
      expect(await pageText(slug)).toContain('Edit already on the page.');
      expect(await pageText(slug)).not.toContain('Concurrent captured body.');
    }, 30_000);

    test('a keyed capture whose first write hits the pages source FK lands under default, its first record rolled back', async () => {
      const racingSource = `racing-${backend}`;
      await brain().engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [racingSource]);
      let attempts = 0;
      // The first write transaction runs in full (page and record), then fails as if the source row vanished under it.
      const racing = new Proxy(brain().engine, {
        get(target, prop) {
          if (prop === 'transaction') {
            return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
              if (++attempts > 1) return target.transaction(fn);
              return target.transaction(async tx => {
                await fn(tx);
                throw Object.assign(new Error('insert or update on table "pages" violates foreign key constraint "pages_source_id_fk"'), { code: '23503' });
              });
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const slug = `notes/fk-race-${backend}`;
      const key = `ingest:webhook:client-example:${racingSource}:fk-race`;
      const result = await makeIngestCaptureHandler(racing)(jobCtx(5, captureData(note('Racing capture', 'Racing body.'), slug, racingSource), key));
      expect(attempts).toBe(2);
      expect(result.status).toBe('imported');
      expect(result.source_fallback).toEqual({ requested: racingSource, effective: 'default', reason: 'fk_violation' });
      expect(await brain().engine.executeRaw('SELECT source_id FROM ingest_applied_captures WHERE idempotency_key = $1', [key])).toEqual([{ source_id: 'default' }]);
      expect((await brain().engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth).toContain('Racing body.');
      expect(await brain().engine.readPageSnapshot(slug, { sourceId: racingSource })).toBeNull();
    });

    test('the purge keeps records for 90 days', async () => {
      const insert = (key: string, age: string) => brain().engine.executeRaw(
        `INSERT INTO ingest_applied_captures (idempotency_key, source_id, slug, result, applied_at) VALUES ($1, $2, 'notes/purge', '{}'::jsonb, now() - $3::interval)`, [key, SRC, age]);
      await insert(`purge-old-${backend}`, '91 days');
      await insert(`purge-recent-${backend}`, '89 days');
      expect(await purgeStaleAppliedCaptures(brain().engine)).toBe(1);
      const kept = await brain().engine.executeRaw<{ idempotency_key: string }>("SELECT idempotency_key FROM ingest_applied_captures WHERE slug = 'notes/purge'");
      expect(kept.map(r => r.idempotency_key)).toEqual([`purge-recent-${backend}`]);
    });

    test('a job queued without a key writes and records nothing', async () => {
      const slug = `notes/keyless-${backend}`;
      const data = captureData(note('Keyless capture', 'Keyless body.'), slug, SRC);
      expect((await makeIngestCaptureHandler(brain().engine)(jobCtx(2, data, null))).status).toBe('imported');
      expect(await pageText(slug)).toContain('Keyless body.');
      expect(await brain().engine.executeRaw('SELECT 1 FROM ingest_applied_captures WHERE slug = $1', [slug])).toHaveLength(0);
    });
  });

  describe(`ingest_capture applies a capture once on a managed brain (${backend})`, () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

    test('a re-run after the door committed keeps the newer edit, from the journal when the record row is missing', () => managedBrain(async ({ engine, ctx }) => {
      const slug = 'notes/managed-rerun';
      const data = captureData(note('Managed capture', 'Managed captured body.'), slug, 'default');
      const key = 'ingest:webhook:client-example:default:managed-rerun';
      const run = makeIngestCaptureHandler(engine);
      const first = await run(jobCtx(3, data, key));
      expect(first.status).toBe('imported');
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: note('Managed capture', 'Managed newer edit.'), expected_revision: snapshot!.revision } });
      const pageText = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth ?? '';
      expect(await pageText()).toContain('Managed newer edit.');

      // The worker died after the door committed and before the record row was inserted.
      await engine.executeRaw('DELETE FROM ingest_applied_captures WHERE idempotency_key = $1', [key]);
      expect(await run(jobCtx(3, data, key))).toEqual(first);
      expect(await pageText()).toContain('Managed newer edit.');
      expect(await engine.executeRaw('SELECT 1 FROM ingest_applied_captures WHERE idempotency_key = $1', [key])).toHaveLength(1);

      expect(await run(jobCtx(3, data, key, 1))).toEqual(first);
      expect(await pageText()).toContain('Managed newer edit.');
      expect(await pageText()).not.toContain('Managed captured body.');
    }, { databaseUrl }), 120_000);

    test('a capture whose attempt id already names a refused write of it still lands (jobs retry resets attempts_made)', () => managedBrain(async ({ engine, ctx }) => {
      const slug = 'notes/managed-retried';
      const data = captureData(note('Managed retried', 'Managed retried body.'), slug, 'default');
      const key = 'ingest:webhook:client-example:default:managed-retried';
      const pageText = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth ?? '';
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: note('Managed retried', 'Page before the capture.') } });
      const stale = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: note('Managed retried', 'Edit before the capture.'), expected_revision: stale!.revision } });
      // Attempt 0 reached the door for the revision before that edit and was refused; `gbrain jobs retry` reset attempts_made to 0.
      await expect(submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: data.event.content, content_origin: 'tool_output',
        expected_revision: stale!.revision, request_id: `${appliedCaptureRequestPrefix(key)}0` } })).rejects.toThrow();

      const run = makeIngestCaptureHandler(engine);
      const result = await run(jobCtx(5, data, key));
      expect(result.status).toBe('imported');
      expect(await pageText()).toContain('Managed retried body.');
      expect(await run(jobCtx(5, data, key))).toEqual(result);
    }, { databaseUrl }), 120_000);

    test('a retried capture whose attempt id names a failed write of the same request still lands', () => managedBrain(async ({ engine, ctx }) => {
      const slug = 'notes/managed-failed';
      const data = captureData(note('Managed failed', 'Managed body after a failed write.'), slug, 'default');
      const key = 'ingest:webhook:client-example:default:managed-failed';
      const pageText = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth ?? '';
      // Attempt 0 sent the capture's request (the page did not exist yet) and the write ended failed without landing.
      const lock = (await acquireWorktree((await getWorktreeBinding(engine, 'default'))!))!;
      try {
        await expect(submitPageMutation({ ...ctx, writeWaitMs: 200 }, { operation: 'put_page', params: { slug, source_id: 'default', content: data.event.content,
          content_origin: 'tool_output', source_kind: 'webhook', source_uri: data.event.source_uri, ingested_via: 'ingest_capture',
          request_id: `${appliedCaptureRequestPrefix(key)}0`, keep_hidden_rows: true } })).rejects.toThrow(/pending/);
        await asWriter(engine, "UPDATE persistence_requests SET state = 'failed', error_code = 'storage_error' WHERE client_request_id = $1", [`${appliedCaptureRequestPrefix(key)}0`]);
      } finally { await lock.release(); }
      expect(await pageText()).toBe('');

      // `gbrain jobs retry` reset attempts_made to 0, so the run sends the same request again.
      const result = await makeIngestCaptureHandler(engine)(jobCtx(6, data, key));
      expect(result.status).toBe('imported');
      expect(await pageText()).toContain('Managed body after a failed write.');
    }, { databaseUrl }), 120_000);

    test('a committed request another principal sent under the capture prefix does not count as applied', () => managedBrain(async ({ engine, ctx }) => {
      const slug = 'notes/managed-forged';
      const data = captureData(note('Managed forged', 'Managed real capture.'), slug, 'default');
      const key = 'ingest:webhook:client-example:default:managed-forged';
      const prefix = appliedCaptureRequestPrefix(key);
      const pageText = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth ?? '';
      // A remote writer that predicted the key committed its own write under the capture's request_id prefix.
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: note('Managed forged', 'Forged write.'), request_id: `${prefix}0:forged` } });
      await asWriter(engine, "UPDATE persistence_requests SET principal_kind = 'oauth_client', principal_id = 'client-forger' WHERE client_request_id = $1", [`${prefix}0:forged`]);

      expect((await makeIngestCaptureHandler(engine)(jobCtx(7, data, key))).status).toBe('imported');
      expect(await pageText()).toContain('Managed real capture.');
      const own = await engine.executeRaw<{ principal_kind: string }>("SELECT principal_kind FROM persistence_requests WHERE client_request_id LIKE $1 AND client_request_id <> $2", [`${prefix}%`, `${prefix}0:forged`]);
      expect(own.map(r => r.principal_kind)).toEqual(['local_cli']);
    }, { databaseUrl }), 120_000);

    test('an original run that stalled before its put and resumes after the re-run committed and a newer edit landed keeps the newer edit', () => managedBrain(async ({ engine, ctx }) => {
      const slug = 'notes/managed-stalled';
      const data = captureData(note('Managed stalled', 'Managed stalled capture.'), slug, 'default');
      const key = 'ingest:webhook:client-example:default:managed-stalled';
      const pageText = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth ?? '';
      let rerun: CaptureResult | undefined;
      // The original passed the applied check and stalled; its lock expired, the stall re-run (same attempts_made)
      // committed the capture, and a newer edit landed before the original went on.
      const original = await makeIngestCaptureHandler(stallBeforeSnapshot(engine, async () => {
        rerun = await makeIngestCaptureHandler(engine)(jobCtx(8, data, key));
        const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: note('Managed stalled', 'Managed newer edit.'), expected_revision: snapshot!.revision } });
      }))(jobCtx(8, data, key));
      expect(rerun!.status).toBe('imported');
      expect(original).toEqual(rerun!);
      expect(await pageText()).toContain('Managed newer edit.');
      expect(await pageText()).not.toContain('Managed stalled capture.');
    }, { databaseUrl }), 120_000);

    test('a re-run that the original run commits ahead of, after its applied check, returns the original result', () => managedBrain(async ({ engine }) => {
      const slug = 'notes/managed-overtaken';
      const data = captureData(note('Managed overtaken', 'Managed overtaken capture.'), slug, 'default');
      const key = 'ingest:webhook:client-example:default:managed-overtaken';
      let original: CaptureResult | undefined;
      const rerun = await makeIngestCaptureHandler(stallBeforeSnapshot(engine, async () => {
        original = await makeIngestCaptureHandler(engine)(jobCtx(9, data, key));
      }))(jobCtx(9, data, key));
      expect(original!.status).toBe('imported');
      expect(rerun).toEqual(original!);
    }, { databaseUrl }), 120_000);
  });
}
