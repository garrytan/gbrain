/**
 * #8799: a GitHub item webhook queues a refresh for exactly the item it names.
 * Before the fix a waiting refresh for one item of a source absorbed every
 * other item's event (a source-wide waiting cap of 1, answered 202 with the
 * first item's job), and an issues/deleted event inside the same 30 s bucket
 * as an edit reused the edit's job, so the page was refetched, not removed.
 * A cap hit answers 429 unless the job it returns covers the event.
 *
 * Real PGLite queue, synthetic repository and secret.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';

const SECRET = 'example-webhook-secret';
const REPO = 'acme-example/app';
let engine: PGLiteEngine;
let server: Server;
let base: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [id, repo] of [['source-a', REPO], ['source-b', 'acme-example/other'], ['source-c', 'acme-example/third'], ['source-d', 'acme-example/fourth']]) {
    await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)',
      [id, JSON.stringify({ kind: 'github', gh_scope: 'repos', gh_repos: repo, webhook_secret: SECRET })]);
  }
  const app = express();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  mountWebhooks(app, {
    engine,
    resourceVerifier: { verifyAccessToken: async () => { throw new Error('unused'); } },
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

async function issueEvent(number: number, action: string, repo = REPO) {
  const payload = JSON.stringify({ action, repository: { full_name: repo }, issue: { number } });
  const res = await fetch(`${base}/webhooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(payload).digest('hex')}` },
    body: payload,
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const waitingItems = async (sourceId: string) => (await engine.executeRaw<{ item: { number: number; deleted?: boolean } }>(
  "SELECT data->'github_item' AS item FROM minion_jobs WHERE name = 'sync' AND status = 'waiting' AND data->>'sourceId' = $1 ORDER BY id", [sourceId]))
  .map(row => (typeof row.item === 'string' ? JSON.parse(row.item) : row.item) as { number: number; deleted?: boolean });

describe('#8799 GitHub item webhooks', () => {
  test('two items of one source each get their own refresh job', async () => {
    const first = await issueEvent(1, 'edited');
    const second = await issueEvent(2, 'edited');
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.job_id).not.toBe(first.body.job_id);
    expect((await waitingItems('source-a')).map(item => item.number)).toEqual([1, 2]);
  });

  test('a repeated event for the same item inside the bucket reuses its job', async () => {
    const again = await issueEvent(1, 'labeled');
    const [row] = await engine.executeRaw<{ id: number }>(
      "SELECT id FROM minion_jobs WHERE name = 'sync' AND status = 'waiting' AND (data->'github_item'->>'number')::int = 1 ORDER BY id LIMIT 1");
    expect(again.status).toBe(202);
    expect(again.body.job_id).toBe(row!.id);
  });

  test('a deletion right after an edit queues a delete, not the edit refresh', async () => {
    const deleted = await issueEvent(1, 'deleted');
    expect(deleted.status).toBe(202);
    const [job] = await engine.executeRaw<{ item: unknown }>("SELECT data->'github_item' AS item FROM minion_jobs WHERE id = $1", [deleted.body.job_id]);
    const item = (typeof job!.item === 'string' ? JSON.parse(job!.item) : job!.item) as { number: number; deleted?: boolean };
    expect(item).toMatchObject({ number: 1, deleted: true });
  });

  test('a full backlog refuses the event with 429 instead of answering with another item', async () => {
    for (let number = 1; number <= 50; number++) expect((await issueEvent(number, 'edited', 'acme-example/other')).status).toBe(202);
    const refused = await issueEvent(51, 'edited', 'acme-example/other');
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'webhook_backlog_full', source_id: 'source-b' });
    expect((await waitingItems('source-b')).some(item => item.number === 51)).toBe(false);
  });

  test('at a full backlog a waiting source-wide sync covers an edit but not a deletion', async () => {
    for (let number = 1; number <= 49; number++) expect((await issueEvent(number, 'edited', 'acme-example/third')).status).toBe(202);
    const sweep = await new MinionQueue(engine).add('sync', { sourceId: 'source-c', noExtract: false }, { priority: -10 });
    const edit = await issueEvent(60, 'edited', 'acme-example/third');
    expect(edit.status).toBe(202);
    expect(edit.body.job_id).toBe(sweep.id);
    expect((await issueEvent(61, 'deleted', 'acme-example/third')).status).toBe(429);
  });

  test('at a full backlog a waiting automatic freshness sync, which may skip, covers nothing', async () => {
    for (let number = 1; number <= 49; number++) expect((await issueEvent(number, 'edited', 'acme-example/fourth')).status).toBe(202);
    await new MinionQueue(engine).add('sync', { sourceId: 'source-d', embed_reason: 'autopilot_freshness' }, { priority: -10 });
    expect((await issueEvent(60, 'edited', 'acme-example/fourth')).status).toBe(429);
  });
});
