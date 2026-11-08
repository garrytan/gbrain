import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SECRET = 'example-item-webhook-secret';

for (const label of testBackends()) {
  describe(`GitHub item webhook queue identity #8799 (${label})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    let server: Server;
    let base: string;
    const sourceId = `webhook-items-8799-${label}`;
    const repo = 'example-items/app';

    beforeAll(async () => {
      if (label === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        await lite.initSchema();
        engine = lite;
        close = () => lite.disconnect();
      }
      await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb)',
        [sourceId, JSON.stringify({ kind: 'github', gh_scope: 'repos', gh_repos: repo, webhook_secret: SECRET })]);
      for (const [id, secret] of [['legacy-a', 'other-example-secret'], ['legacy-b', SECRET]]) {
        await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb)',
          [`${sourceId}-${id}`, JSON.stringify({ github_repo: 'example-legacy/app', webhook_secret: secret })]);
      }
      const app = express();
      const pass: express.RequestHandler = (_req, _res, next) => next();
      mountWebhooks(app, {
        engine,
        resourceVerifier: { verifyAccessToken: async () => { throw new Error('unused'); } },
        resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
        ingestRateLimiter: pass, githubWebhookLimiter: pass, broadcastEvent: () => {},
      } as unknown as ServeHttpContext);
      server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 120_000);

    afterAll(async () => {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      if (engine) {
        await engine.executeRaw("DELETE FROM minion_jobs WHERE data->>'sourceId' = $1", [sourceId]);
        await engine.executeRaw('DELETE FROM sources WHERE id = $1 OR id = $2 OR id = $3',
          [sourceId, `${sourceId}-legacy-a`, `${sourceId}-legacy-b`]);
        await close?.();
      }
    }, 60_000);

    async function send(number: number, action = 'edited', event = 'issues', targetRepo = repo, secret = SECRET) {
      const payload = JSON.stringify({ repository: { full_name: targetRepo }, action,
        ...(event === 'pull_request' ? { pull_request: { number } } : { issue: { number } }) });
      const response = await fetch(`${base}/webhooks/github`, {
        method: 'POST', body: payload,
        headers: { 'content-type': 'application/json', 'x-github-event': event,
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}` },
      });
      return { status: response.status, retryAfter: response.headers.get('retry-after'),
        body: await response.json() as { job_id?: number; status?: string; error?: string } };
    }

    test('different items remain distinct behind waiting syncs, and same-intent retries deduplicate', async () => {
      const first = await send(101);
      const second = await send(102, 'opened', 'pull_request');
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.job_id).not.toBe(first.body.job_id);
      const retry = await send(102, 'opened', 'pull_request');
      expect(retry.body.job_id).toBe(second.body.job_id);
      const rows = await engine.executeRaw<{ data: { github_item: { repo: string; number: number; kind: string } } }>(
        'SELECT data FROM minion_jobs WHERE id IN ($1, $2) ORDER BY id', [first.body.job_id, second.body.job_id]);
      expect(rows.map(row => row.data.github_item)).toEqual([
        { repo, number: 101, kind: 'issue' }, { repo, number: 102, kind: 'pr' },
      ]);
    });

    test('delete intent cannot reuse the refresh job in the same bucket', async () => {
      const refresh = await send(103);
      const deleted = await send(103, 'deleted');
      expect(deleted.status).toBe(202);
      expect(deleted.body.job_id).not.toBe(refresh.body.job_id);
      const [row] = await engine.executeRaw<{ data: { github_item: { deleted?: boolean } } }>(
        'SELECT data FROM minion_jobs WHERE id = $1', [deleted.body.job_id]);
      expect(row.data.github_item.deleted).toBe(true);
      expect((await send(103, 'deleted')).body.job_id).toBe(deleted.body.job_id);
    });

    test('concurrent events preserve each item while collapsing identical retries', async () => {
      const responses = await Promise.all([send(201), send(202), send(201)]);
      expect(responses.map(r => r.status)).toEqual([202, 202, 202]);
      expect(responses[0].body.job_id).toBe(responses[2].body.job_id);
      expect(responses[1].body.job_id).not.toBe(responses[0].body.job_id);
    });

    test('every configured legacy secret can acknowledge an ignored item event', async () => {
      for (const secret of ['other-example-secret', SECRET]) {
        const response = await send(104, 'edited', 'issues', 'example-legacy/app', secret);
        expect(response.status).toBe(202);
        expect(response.body.status).toBe('ignored');
        expect(response.body.job_id).toBeUndefined();
      }
      expect((await send(104, 'edited', 'issues', 'example-legacy/app', 'invalid-example-secret')).status).toBe(404);
      expect((await send(104, 'edited', 'issues', 'example-unknown/app')).status).toBe(404);
    });
    test('a full source backlog refuses the new item instead of acknowledging another job', async () => {
      const [{ count }] = await engine.executeRaw<{ count: string }>(
        "SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'sync' AND status = 'waiting' AND data->>'sourceId' = $1", [sourceId]);
      for (let i = Number(count); i < 50; i++) expect((await send(1000 + i)).status).toBe(202);
      const [{ data }] = await engine.executeRaw<{ data: { github_item: { number: number } } }>(
        "SELECT data FROM minion_jobs WHERE data->>'sourceId' = $1 ORDER BY id DESC LIMIT 1", [sourceId]);
      expect((await send(data.github_item.number)).status).toBe(202);
      const full = await send(9999);
      expect(full.status).toBe(429);
      expect(full.retryAfter).toBe('30');
      expect(full.body.error).toBe('webhook_backlog_full');
      expect(full.body.job_id).toBeUndefined();
      const rows = await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->>'sourceId' = $1 AND data->'github_item'->>'number' = '9999'", [sourceId]);
      expect(rows).toHaveLength(0);
      await engine.executeRaw("DELETE FROM minion_jobs WHERE data->>'sourceId' = $1", [sourceId]);
      expect((await send(9999)).status).toBe(202);
    });
  });
}
