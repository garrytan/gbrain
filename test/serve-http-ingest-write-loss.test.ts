/**
 * POST /ingest never answers 202 for a capture it did not queue.
 *
 * #8769: the queue idempotency key now carries the target slug. Before this fix the key was
 * client + write source + content hash, so one client posting the same body to two slugs while the first job was
 * still queued (or after it completed) got the first job back: a 202 for the second slug and nothing written there.
 * Protects: the same body to two slugs queues two jobs and writes both pages; a retry to the same slug (any case)
 * and a slug-less retry still collapse onto one job; a slug-less post and a slug post stay separate.
 * Waiting cap: at 50 waiting captures for a source the queue hands back the newest waiting job instead of inserting;
 * the route used to answer 202 with that job, dropping the body. Protects: the capture over the cap gets 429 with
 * Retry-After and nothing claimed, and the same capture lands its own job once the backlog drains.
 * Real token verifier, real Express route, repo-less PGLite brain, the real ingest_capture handler.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';

const SRC = 'source-a';

let engine: PGLiteEngine;
let server: Server;
let base: string;
let token: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  token = (await mintLegacyToken(engine, { name: 'writer', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
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
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()));
  await engine?.disconnect();
}, 60_000);

const post = (body: string, slug?: string) => fetch(`${base}/ingest`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown', ...(slug ? { 'x-gbrain-slug': slug } : {}) },
  body,
});
const ingest = async (body: string, slug?: string) => {
  const res = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown', ...(slug ? { 'x-gbrain-slug': slug } : {}) },
    body,
  });
  expect(res.status).toBe(202);
  return (await res.json() as { job_id: number }).job_id;
};
const jobCtx = (id: number, data: Record<string, unknown>): MinionJobContext => ({ id, name: 'ingest_capture', data, attempts_made: 0, idempotency_key: null,
  signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {},
  updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] });
const runJob = async (id: number) => {
  const [row] = await engine.executeRaw<{ data: unknown }>('SELECT data FROM minion_jobs WHERE id = $1', [id]);
  const data = (typeof row!.data === 'string' ? JSON.parse(row!.data) : row!.data) as Record<string, unknown>;
  return makeIngestCaptureHandler(engine)(jobCtx(id, data));
};
const note = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\nSame body for every target.\n`;

describe('POST /ingest idempotency includes the target slug', () => {
  test('the same body to two slugs while the first job is queued: two jobs, both pages written', async () => {
    const body = note('Shared capture');
    const first = await ingest(body, 'notes/target-one');
    const second = await ingest(body, 'notes/target-two');
    expect(second).not.toBe(first);
    expect((await runJob(first)).status).toBe('imported');
    expect((await runJob(second)).status).toBe('imported');
    expect((await engine.readPageSnapshot('notes/target-one', { sourceId: SRC }))?.page.compiled_truth).toContain('Same body for every target.');
    expect((await engine.readPageSnapshot('notes/target-two', { sourceId: SRC }))?.page.compiled_truth).toContain('Same body for every target.');
  });

  test('the same body to a third slug after the first job completed still gets its own job', async () => {
    const body = note('Shared capture');
    const third = await ingest(body, 'notes/target-three');
    expect((await runJob(third)).status).toBe('imported');
    expect(await engine.readPageSnapshot('notes/target-three', { sourceId: SRC })).not.toBeNull();
  });

  test('a retry to the same slug, in any case, collapses onto the first job', async () => {
    const body = note('Retried capture');
    const first = await ingest(body, 'notes/retried');
    expect(await ingest(body, 'notes/retried')).toBe(first);
    expect(await ingest(body, 'Notes/Retried')).toBe(first);
  });

  test('a slug-less post and a slug post of the same body are separate jobs; slug-less retries collapse', async () => {
    const body = note('Inbox capture');
    const inbox = await ingest(body);
    expect(await ingest(body)).toBe(inbox);
    expect(await ingest(body, 'notes/inbox-copy')).not.toBe(inbox);
  });

  const entropy = Array.from({ length: 47 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join('');
  const queuedWith = async (marker: string) =>
    (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs WHERE data::text LIKE $1', [`%${marker}%`]))[0]!.n;

  test('a slug of about 3 KB, which no page can be stored under, is refused with 400 invalid_slug and nothing queued', async () => {
    const res = await post(note('Long-slug capture'), `notes/${entropy}`);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_slug');
    expect(await queuedWith('Long-slug capture')).toBe(0);
  });

  test('a slug of exactly 1024 bytes is queued, and its retry collapses; 1025 bytes is refused', async () => {
    const atLimit = `notes/${entropy.slice(0, 1024 - 'notes/'.length)}`;
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(1024);
    const body = note('Slug at the limit');
    const first = await ingest(body, atLimit);
    expect(await ingest(body, atLimit)).toBe(first);

    const over = await post(note('Slug over the limit'), `${atLimit}b`);
    expect(over.status).toBe(400);
    expect((await over.json() as { error: string }).error).toBe('invalid_slug');
    expect(await queuedWith('Slug over the limit')).toBe(0);
  });
});

describe('POST /ingest at the waiting cap', () => {
  test('the capture over the cap gets 429 and nothing queued; it lands its own job once the backlog drains', async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    const queued = new Set<number>();
    for (let i = 0; i < 50; i++) queued.add(await ingest(note(`Backlog ${i}`)));
    expect(queued.size).toBe(50);

    const over = await post(note('Over the cap'));
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('30');
    expect((await over.json() as { error: string }).error).toBe('ingest_backlog_full');
    const [held] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE data::text LIKE '%Over the cap%'");
    expect(held!.n).toBe(0);

    await engine.executeRaw("UPDATE minion_jobs SET status = 'completed' WHERE id = $1", [Math.min(...queued)]);
    const retried = await ingest(note('Over the cap'));
    expect(queued.has(retried)).toBe(false);
    expect((await runJob(retried)).status).toBe('imported');
  });
});
