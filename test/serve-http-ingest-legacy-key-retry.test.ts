/**
 * A retry of a capture recorded under the /ingest key from before v0.60.609.0 must not queue a second job.
 *
 * #8798 (v0.60.609.0) added the target slug to the queue idempotency key (#8769). Job rows keep their key until
 * `gbrain jobs prune` removes them, so a capture that completed under the old key form
 * (`ingest:webhook:<client>:<write source>:<content hash>`) missed the new key when its client retried after the
 * upgrade: a second job was queued, and running it wrote the old body over the page's newer edit.
 * Protects: the retry (to the same slug in any case, or slug-less) answers 202 with the recorded job and queues nothing,
 * and the page keeps its newer edit after every queued capture runs; a legacy row for another slug or a dead legacy row
 * never answers for this capture, so #8769's fix and the dead-job retry still hold.
 * Real token verifier, real Express route, the real ingest_capture handler; PGLite here, Postgres through
 * test/e2e/serve-http-ingest-legacy-key-retry-postgres.test.ts.
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
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import { ERROR_CATALOGUE } from '../src/core/error-catalogue.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SRC = 'source-a';

interface Brain { engine: BrainEngine; server: Server; base: string; token: string; close: () => Promise<void> }
const brains = new Map<string, Brain>();

async function openBrain(engine: BrainEngine, closeEngine: () => Promise<void>): Promise<Brain> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  const token = (await mintLegacyToken(engine, { name: 'legacy-retry-writer', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
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

const jobCtx = (id: number, data: Record<string, unknown>): MinionJobContext => ({ id, name: 'ingest_capture', data, attempts_made: 0, idempotency_key: null,
  signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {},
  updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] });
const jsonData = (data: unknown) => (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown>;
const note = (title: string, line: string) => `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\n${line}\n`;

for (const backend of backends) {
  describe(`POST /ingest retry of a capture recorded under the pre-v0.60.609.0 key (${backend})`, () => {
    const brain = () => brains.get(backend)!;
    const post = (body: string, slug?: string) => fetch(`${brain().base}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${brain().token}`, 'content-type': 'text/markdown', ...(slug ? { 'x-gbrain-slug': slug } : {}) },
      body,
    });
    const ingest = async (body: string, slug?: string) => {
      const res = await post(body, slug);
      expect(res.status).toBe(202);
      return (await res.json() as { job_id: number }).job_id;
    };
    const jobData = async (id: number) =>
      jsonData((await brain().engine.executeRaw<{ data: unknown }>('SELECT data FROM minion_jobs WHERE id = $1', [id]))[0]!.data);
    const runJob = async (id: number) => makeIngestCaptureHandler(brain().engine)(jobCtx(id, await jobData(id)));
    /** Runs every queued capture, as a worker would after the retry. */
    const drainQueue = async () => {
      const waiting = await brain().engine.executeRaw<{ id: number }>(
        "SELECT id FROM minion_jobs WHERE name = 'ingest_capture' AND status = 'waiting' ORDER BY id");
      for (const { id } of waiting) {
        await runJob(Number(id));
        await brain().engine.executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1", [id]);
      }
    };
    /** Rewrites a job to how a pre-v0.60.609.0 server recorded it: the key with no slug part, in the given status. */
    const recordUnderLegacyKey = async (id: number, status: string) => {
      const data = await jobData(id);
      const event = data.event as { content_hash: string; metadata: { client_id: string } };
      const legacyKey = `ingest:webhook:${event.metadata.client_id}:${data.sourceId}:${event.content_hash}`;
      await brain().engine.executeRaw('UPDATE minion_jobs SET idempotency_key = $2, status = $3, finished_at = now() WHERE id = $1', [id, legacyKey, status]);
    };
    const captureJobs = async (marker: string) =>
      (await brain().engine.executeRaw<{ n: number }>(
        "SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'ingest_capture' AND data::text LIKE $1", [`%${marker}%`]))[0]!.n;
    const pageText = async (slug: string) => (await brain().engine.readPageSnapshot(slug, { sourceId: SRC }))?.page.compiled_truth ?? '';

    test('a retry to the same slug gets the recorded job, queues nothing, and the newer edit survives', async () => {
      const slug = `notes/legacy-retry-${backend}`;
      const body = note('Legacy capture', 'First body from the integration.');
      const first = await ingest(body, slug);
      expect((await runJob(first)).status).toBe('imported');
      await recordUnderLegacyKey(first, 'completed');

      await importFromContent(brain().engine, slug, note('Legacy capture', 'Newer edit made after the capture.'), { sourceId: SRC });
      expect(await pageText(slug)).toContain('Newer edit made after the capture.');

      expect(await ingest(body, slug)).toBe(first);
      expect(await ingest(body, slug.toUpperCase())).toBe(first);
      expect(await captureJobs('First body from the integration.')).toBe(1);

      await drainQueue();
      expect(await pageText(slug)).toContain('Newer edit made after the capture.');
      expect(await pageText(slug)).not.toContain('First body from the integration.');
    });

    test('a slug-less retry gets the recorded slug-less job', async () => {
      const body = note('Legacy inbox capture', `Inbox body ${backend}.`);
      const first = await ingest(body);
      await recordUnderLegacyKey(first, 'completed');
      expect(await ingest(body)).toBe(first);
      expect(await captureJobs(`Inbox body ${backend}.`)).toBe(1);
    });

    test('a legacy row for another slug never answers for this one (#8769 stays fixed)', async () => {
      const body = note('Shared legacy body', `Shared body ${backend}.`);
      const first = await ingest(body, `notes/shared-one-${backend}`);
      await recordUnderLegacyKey(first, 'completed');
      const second = await ingest(body, `notes/shared-two-${backend}`);
      expect(second).not.toBe(first);
      expect((await runJob(second)).status).toBe('imported');
      expect(await pageText(`notes/shared-two-${backend}`)).toContain(`Shared body ${backend}.`);
      expect(await ingest(body)).not.toBe(first);
    });

    test('a dead legacy row frees the capture for a fresh job', async () => {
      const slug = `notes/legacy-dead-${backend}`;
      const body = note('Dead legacy capture', `Dead body ${backend}.`);
      const first = await ingest(body, slug);
      await recordUnderLegacyKey(first, 'dead');
      const retried = await ingest(body, slug);
      expect(retried).not.toBe(first);
      expect((await runJob(retried)).status).toBe('imported');
      expect(await pageText(slug)).toContain(`Dead body ${backend}.`);
    });

    test('a completed legacy row with SQL NULL authority still answers the retry', async () => {
      const slug = `notes/legacy-null-done-${backend}`;
      const body = note('Null authority completed', `Null done body ${backend}.`);
      const first = await ingest(body, slug);
      await recordUnderLegacyKey(first, 'completed');
      await brain().engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [first]);
      expect(await ingest(body, slug)).toBe(first);
      expect(await captureJobs(`Null done body ${backend}.`)).toBe(1);
    });

    test('a waiting legacy row with SQL NULL authority answers 409 and queues nothing', async () => {
      const slug = `notes/legacy-null-waiting-${backend}`;
      const body = note('Null authority waiting', `Null waiting body ${backend}.`);
      const first = await ingest(body, slug);
      await recordUnderLegacyKey(first, 'waiting');
      await brain().engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL, finished_at = NULL WHERE id = $1', [first]);
      try {
        const res = await post(body, slug);
        expect(res.status).toBe(409);
        expect((await res.json() as { docs_url: string }).docs_url).toBe(ERROR_CATALOGUE.legacy_job_authority.docs);
        expect(await captureJobs(`Null waiting body ${backend}.`)).toBe(1);
      } finally {
        await brain().engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [first]);
      }
    });
  });
}
