/**
 * /webhooks/github push events answer an unsigned or badly signed request the same way whatever the repository
 * (security wave, CSO A-2). Before this fix the push path looked the repository up and answered unknown_repo,
 * ref_mismatch (naming the tracked branch) and webhook_not_configured (naming the source id) before it checked the
 * HMAC, so an unauthenticated peer could tell which repositories a brain syncs. Protects: every unverified push gets
 * one 401 signature_mismatch body; a verified push for another branch still gets 202 ref_mismatch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';

const SECRET = 'example-webhook-secret';
let engine: PGLiteEngine;
let server: Server;
let base: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)',
    ['source-signed', JSON.stringify({ github_repo: 'acme-example/signed', tracked_branch: 'main', webhook_secret: SECRET })]);
  await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)',
    ['source-unset', JSON.stringify({ github_repo: 'acme-example/unset', tracked_branch: 'main' })]);
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

async function push(repo: string, ref: string, signature?: string) {
  const payload = JSON.stringify({ repository: { full_name: repo }, ref });
  const res = await fetch(`${base}/webhooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push',
      'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', 'not-the-secret').update(payload).digest('hex')}` },
    body: payload,
  });
  return { status: res.status, text: await res.text() };
}
const signed = (repo: string, ref: string) => {
  const payload = JSON.stringify({ repository: { full_name: repo }, ref });
  return `sha256=${createHmac('sha256', SECRET).update(payload).digest('hex')}`;
};

describe('unverified GitHub push webhooks', () => {
  test('a registered repo, an unregistered repo and a repo with no secret get the same 401', async () => {
    const answers = [
      await push('acme-example/signed', 'refs/heads/feature'),
      await push('acme-example/unknown', 'refs/heads/feature'),
      await push('acme-example/unset', 'refs/heads/main'),
      await push('acme-example/signed', 'refs/heads/main'),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.text).toBe(answers[0]!.text);
      expect(answer.text).not.toContain('main');
      expect(answer.text).not.toContain('source-');
      expect(answer.text).not.toContain('acme-example');
    }
  });

  test('a verified push for another branch is still acknowledged as ref_mismatch', async () => {
    const answer = await push('acme-example/signed', 'refs/heads/feature', signed('acme-example/signed', 'refs/heads/feature'));
    expect(answer.status).toBe(202);
    expect(JSON.parse(answer.text)).toMatchObject({ status: 'ignored', reason: 'ref_mismatch' });
  });
});
