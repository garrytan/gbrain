/**
 * /webhooks/github push events answer an unsigned or badly signed request the same way whatever the repository
 * (security wave, CSO A-2). Before this fix the push path looked the repository up and answered unknown_repo,
 * ref_mismatch (naming the tracked branch) and webhook_not_configured (naming the source id) before it checked the
 * HMAC, so an unauthenticated peer could tell which repositories a brain syncs. Protects: every unverified push gets
 * one 401 signature_mismatch body; a verified push for another branch still gets 202 ref_mismatch.
 * #8768: every unverified request also computes the HMAC over its body, whether the repository is unknown, has no
 * secret or is in scope of a github-kind source, so response time does not say which repositories this brain syncs.
 * Counted on the HMAC itself rather than timed, so the test cannot flake.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import * as crypto from 'crypto';
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
  await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)',
    ['source-items', JSON.stringify({ kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/covered', webhook_secret: SECRET })]);
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

describe('unverified webhooks compute the HMAC whatever the repository (#8768)', () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { spy?.mockRestore(); spy = undefined; });

  async function hmacsFor(event: string, payload: string, signature: string) {
    spy = spyOn(crypto, 'createHmac');
    const res = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature },
      body: payload,
    });
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    spy = undefined;
    return { status: res.status, calls };
  }
  const forged = `sha256=${'0'.repeat(64)}`;
  const pushBody = (repo: string) => JSON.stringify({ repository: { full_name: repo }, ref: 'refs/heads/main' });
  const issueBody = (repo: string) => JSON.stringify({ repository: { full_name: repo }, issue: { number: 7 }, action: 'edited' });

  test('a push for an unknown repo, a repo with no secret and a signed repo each compute one HMAC', async () => {
    for (const repo of ['acme-example/unknown', 'acme-example/unset', 'acme-example/signed']) {
      const answer = await hmacsFor('push', pushBody(repo), forged);
      expect(answer).toEqual({ status: 401, calls: 1 });
    }
  });

  test('a malformed signature header still computes the HMAC', async () => {
    for (const repo of ['acme-example/unknown', 'acme-example/signed']) {
      expect(await hmacsFor('push', pushBody(repo), 'sha256=not-hex')).toEqual({ status: 401, calls: 1 });
    }
  });

  test('an item event computes as many HMACs for a covered, a legacy-registered and an unknown repo', async () => {
    const covered = await hmacsFor('issues', issueBody('acme-example/covered'), forged);
    const legacy = await hmacsFor('issues', issueBody('acme-example/signed'), forged);
    const unknown = await hmacsFor('issues', issueBody('acme-example/unknown'), forged);
    expect(covered.calls).toBeGreaterThan(0);
    expect(legacy.calls).toBe(covered.calls);
    expect(unknown.calls).toBe(covered.calls);
    expect(new Set([covered.status, legacy.status, unknown.status])).toEqual(new Set([404]));
  });
});
