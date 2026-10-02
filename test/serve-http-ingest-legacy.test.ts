/**
 * #5157 / #5114: `POST /ingest` over a job row left with SQL NULL authority
 * by an upgrade across v0.50 (PGLite, real Express route via mountWebhooks).
 *
 * /ingest submits with application authority, so a completed legacy key
 * coalesces and returns 202; a live legacy row returns 409 with the
 * `{error, message, hint, docs_url}` body; other submission errors stay 500.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { computeContentHash } from '../src/core/ingestion/types.ts';

const CLIENT = 'ingest-legacy-client';
let engine: PGLiteEngine;
let server: Server;
let base: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const app = express();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  mountWebhooks(app, {
    engine,
    resourceVerifier: {
      verifyAccessToken: async (token: string) => ({ token, clientId: CLIENT, clientName: 'example-client', scopes: ['read', 'write'], sourceId: 'default', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    },
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
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

function post(content: string) {
  return fetch(`${base}/ingest`, { method: 'POST', headers: { authorization: 'Bearer test-only', 'content-type': 'text/markdown' }, body: content });
}
const keyFor = (content: string) => `ingest:webhook:${CLIENT}:default:${computeContentHash(content)}`;

/** A job holding the capture's exact key, rewritten to a pre-cutover row. */
async function legacyRow(content: string, status: string, authority: string | null = null): Promise<number> {
  const job = await new MinionQueue(engine).add('ingest_capture', { legacy: true }, { idempotency_key: keyFor(content) });
  await engine.executeRaw('UPDATE minion_jobs SET status = $2, submission_authority = $3::text::jsonb WHERE id = $1', [job.id, status, authority]);
  return job.id;
}

describe('POST /ingest over legacy job authority', () => {
  test('a waiting legacy row with the same key returns 409 with the recovery hint, never 500', async () => {
    const content = '# Waiting legacy\n\nbody';
    const id = await legacyRow(content, 'waiting');
    const res = await post(content);
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['docs_url', 'error', 'hint', 'message']);
    expect(body.error).toBe('permission_denied');
    expect(body.message).toContain(`job ${id} (ingest_capture, waiting)`);
    expect(body.hint).toContain('gbrain jobs authorize-legacy --select "status=waiting|delayed|waiting-children|paused"');
    expect(body.hint).toContain('--expect <hash> --yes');
    expect(body.docs_url).toBe('docs/guides/repair.md#legacy-job-authority');
  });

  test('a full waiting cap whose newest row is legacy returns 409', async () => {
    const queue = new MinionQueue(engine);
    for (let i = 0; i < 50; i++) await queue.add('ingest_capture', { n: i, sourceId: 'default' });
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL');
    const res = await post('# Cap\n\nfresh content');
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, string>).docs_url).toBe('docs/guides/repair.md#legacy-job-authority');
  });

  test('a completed legacy row with the same key coalesces with 202 (application authority)', async () => {
    const content = '# Completed legacy\n\nbody';
    const id = await legacyRow(content, 'completed');
    const res = await post(content);
    expect(res.status).toBe(202);
    expect((await res.json() as Record<string, unknown>).job_id).toBe(id);
  });

  test('a cancelled legacy key is released and the capture queues a fresh job', async () => {
    const content = '# Cancelled legacy\n\nbody';
    const id = await legacyRow(content, 'cancelled');
    const res = await post(content);
    expect(res.status).toBe(202);
    expect((await res.json() as Record<string, unknown>).job_id).not.toBe(id);
  });

  test('a non-legacy submission error still returns 500 queue_submission_failed', async () => {
    const content = '# JSONB null\n\nbody';
    await legacyRow(content, 'waiting', 'null');
    const res = await post(content);
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toBe('queue_submission_failed');
    expect(body.message).toContain('coalescing across');
  });
});
