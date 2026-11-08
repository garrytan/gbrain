/**
 * POST /ingest replaces pages only where the caller's own remote write could (security wave, CSO AUTHZ-1).
 *
 * The webhook route hands its body to the ingest_capture job, which writes outside the MCP op layer. Before this
 * fix the job carried no caller identity, so a write-scoped token replaced pages that every MCP write op refuses it:
 * another member's readable_by page, an owner visibility: private page, another member's fact page. Protects:
 * - the route refuses those slugs (404 page_not_found, 403 for member pages) and queues nothing;
 * - the job re-checks the stored writer at write time, so a page restricted after the 202 is still refused;
 * - a queued webhook job without a stored writer is checked as a guest (fail closed);
 * - a page the caller can read, and a fresh slug, still import.
 * Real token verifier, real Express route, repo-less PGLite brain with members.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { computeContentHash, type IngestionEvent } from '../src/core/ingestion/types.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

const SRC = 'source-a';
const MEMBER_ONLY = 'notes/alice-plan';
const PRIVATE = 'notes/owner-private';
const OPEN = 'notes/team-open';
const ALICE_MEMBER_PAGE = 'memory/members/alice-example';

let engine: PGLiteEngine;
let server: Server;
let base: string;
let bobToken: string;
let bobTokenId: string;

const page = (title: string, extra = '') => `---\ntype: note\ntitle: ${title}\n${extra}---\n# ${title}\n\nOriginal body.\n`;
const takeover = '---\ntype: note\ntitle: Replaced\nreadable_by: [bob-example]\n---\n# Replaced\n\nReplaced by another member.\n';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __resetPrivateVisibilityCacheForTests();
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  await importFromContent(engine, MEMBER_ONLY, page('Alice plan', 'readable_by: [alice-example]\n'), { sourceId: SRC, noEmbed: true } as never);
  await importFromContent(engine, PRIVATE, page('Owner private', 'visibility: private\n'), { sourceId: SRC, noEmbed: true } as never);
  await importFromContent(engine, OPEN, page('Team open'), { sourceId: SRC, noEmbed: true } as never);
  for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
  const bob = await mintLegacyToken(engine, { name: 'bob', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [bob.id, 'bob-example']);
  bobToken = bob.token;
  bobTokenId = String(bob.id);

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

const ingest = (slug: string, body = takeover) => fetch(`${base}/ingest`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'text/markdown', 'x-gbrain-slug': slug },
  body,
});
const jobCtx = (data: Record<string, unknown>): MinionJobContext => ({ id: 1, name: 'ingest_capture', data, attempts_made: 0, idempotency_key: null,
  signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {},
  updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] });
const webhookEvent = (content: string): IngestionEvent => ({ source_id: 'webhook-client-example', source_kind: 'webhook',
  source_uri: 'mcp-webhook:client-example:1', received_at: new Date().toISOString(), content_type: 'text/markdown', content,
  content_hash: computeContentHash(content), untrusted_payload: true });
const body = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC }))?.page.compiled_truth ?? null;
const queuedJobs = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'ingest_capture'"))[0]!.n;

describe('POST /ingest refuses pages the caller cannot write over MCP', () => {
  test('another member\'s readable_by page: 404 page_not_found, nothing queued, page unchanged', async () => {
    const before = await queuedJobs();
    const res = await ingest(MEMBER_ONLY);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('page_not_found');
    expect(await queuedJobs()).toBe(before);
    expect(await body(MEMBER_ONLY)).toContain('Original body.');
  });

  test('a differently cased slug for the same page is refused the same way', async () => {
    const res = await ingest('Notes/Alice-Plan');
    expect(res.status).toBe(404);
    expect(await body(MEMBER_ONLY)).toContain('Original body.');
  });

  test('an owner visibility: private page: 404 page_not_found, page unchanged', async () => {
    const res = await ingest(PRIVATE);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('page_not_found');
    expect(await body(PRIVATE)).toContain('Original body.');
  });

  test('another member\'s fact page: 403 permission_denied', async () => {
    const res = await ingest(ALICE_MEMBER_PAGE, page('Alice facts'));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('permission_denied');
    expect(await engine.readPageSnapshot(ALICE_MEMBER_PAGE, { sourceId: SRC })).toBeNull();
  });

  test('a slug header that is not a valid slug: 400 invalid_slug, nothing queued', async () => {
    const before = await queuedJobs();
    const res = await ingest('../escape');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_slug');
    expect(await queuedJobs()).toBe(before);
  });

  test('a page the caller can read still imports through the job', async () => {
    const res = await ingest(OPEN, page('Team open', '') + '\nUpdated by bob.\n');
    expect(res.status).toBe(202);
    const { job_id } = await res.json() as { job_id: number };
    const [row] = await engine.executeRaw<{ data: unknown }>('SELECT data FROM minion_jobs WHERE id = $1', [job_id]);
    const data = (typeof row!.data === 'string' ? JSON.parse(row!.data) : row!.data) as Record<string, unknown>;
    expect((await makeIngestCaptureHandler(engine)(jobCtx(data))).status).toBe('imported');
    expect(await body(OPEN)).toContain('Updated by bob.');
  });
});

describe('ingest_capture re-checks the webhook writer at write time', () => {
  test('a stored writer who cannot read the target is refused page_not_found, page unchanged', async () => {
    const outcome = await makeIngestCaptureHandler(engine)(jobCtx({ event: webhookEvent(takeover), slug: MEMBER_ONLY, sourceId: SRC,
      writer: { principal: { kind: 'legacy_token', id: bobTokenId } } })).catch((err: { code?: string }) => err);
    expect((outcome as { code?: string }).code).toBe('page_not_found');
    expect(await body(MEMBER_ONLY)).toContain('Original body.');
  });

  test('a queued webhook job with no stored writer is checked as a guest', async () => {
    const outcome = await makeIngestCaptureHandler(engine)(jobCtx({ event: webhookEvent(takeover), slug: PRIVATE, sourceId: SRC }))
      .catch((err: { code?: string }) => err);
    expect((outcome as { code?: string }).code).toBe('page_not_found');
    expect(await body(PRIVATE)).toContain('Original body.');
  });

  test('a member fact page is refused for a webhook writer', async () => {
    const outcome = await makeIngestCaptureHandler(engine)(jobCtx({ event: webhookEvent(page('Alice facts')), slug: ALICE_MEMBER_PAGE, sourceId: SRC,
      writer: { principal: { kind: 'legacy_token', id: bobTokenId } } })).catch((err: { code?: string }) => err);
    expect((outcome as { code?: string }).code).toBe('permission_denied');
    expect(await engine.readPageSnapshot(ALICE_MEMBER_PAGE, { sourceId: SRC })).toBeNull();
  });
});
