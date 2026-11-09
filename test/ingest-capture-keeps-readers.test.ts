/**
 * GST-2112: a webhook capture (POST /ingest, then the ingest_capture job) never drops a page's stored readers.
 *
 * The job writes through a trusted local path, so before this fix the only gate was that the writer could read the
 * page: a member-bound token granted a non-default source could replace a page whose readable_by names it with a body
 * that names no readers, and the page became readable by every caller. Protects, for a remote member-bound writer on a
 * granted source (real token verifier, real Express route, repo-less PGLite brain with members):
 * - the route refuses a body that drops readable_by (readable_by_invalid) and queues nothing;
 * - the job refuses the same body at write time, also when the readers were added after the 202;
 * - a body that drops the writer itself from readable_by is refused;
 * - a body that keeps the readers, and a page without readers, still import;
 * - on a managed brain (the door's put_page runs as a trusted local write) the job refuses the same way, PGLite and Postgres.
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
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SRC = 'source-a';
const SHARED = 'notes/shared-plan';
const LATER = 'notes/restricted-later';
const OPEN = 'notes/team-open';

let engine: PGLiteEngine;
let server: Server;
let base: string;
let bobToken: string;
let bobTokenId: string;

const page = (title: string, extra = '', text = 'Original body.') => `---\ntype: note\ntitle: ${title}\n${extra}---\n# ${title}\n\n${text}\n`;
const READERS = 'readable_by: [alice-example, bob-example]\n';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __resetPrivateVisibilityCacheForTests();
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  await importFromContent(engine, SHARED, page('Shared plan', READERS), { sourceId: SRC, noEmbed: true } as never);
  await importFromContent(engine, LATER, page('Restricted later'), { sourceId: SRC, noEmbed: true } as never);
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

const ingest = (slug: string, body: string) => fetch(`${base}/ingest`, {
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
const bobJob = (slug: string, content: string) => jobCtx({ event: webhookEvent(content), slug, sourceId: SRC,
  writer: { principal: { kind: 'legacy_token', id: bobTokenId } } });
const stored = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC }))?.page ?? null;
const readers = async (slug: string) => ((await stored(slug))?.frontmatter as Record<string, unknown> | undefined)?.readable_by ?? null;
const queuedJobs = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'ingest_capture'"))[0]!.n;
const jobData = async (jobId: number) => {
  const [row] = await engine.executeRaw<{ data: unknown }>('SELECT data FROM minion_jobs WHERE id = $1', [jobId]);
  return (typeof row!.data === 'string' ? JSON.parse(row!.data) : row!.data) as Record<string, unknown>;
};

describe('a webhook capture keeps a page\'s stored readers (GST-2112)', () => {
  test('the route refuses a body that drops readable_by: readable_by_invalid, nothing queued, readers kept', async () => {
    const before = await queuedJobs();
    const res = await ingest(SHARED, page('Shared plan', '', 'Replaced with no readers.'));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('readable_by_invalid');
    expect(await queuedJobs()).toBe(before);
    expect(await readers(SHARED)).toEqual(['alice-example', 'bob-example']);
    expect((await stored(SHARED))?.compiled_truth).toContain('Original body.');
  });

  test('the job refuses the same body at write time: the page keeps its readers and its text', async () => {
    await expect(makeIngestCaptureHandler(engine)(bobJob(SHARED, page('Shared plan', '', 'Replaced by the job.')))).rejects.toMatchObject({ code: 'readable_by_invalid' });
    expect(await readers(SHARED)).toEqual(['alice-example', 'bob-example']);
    expect((await stored(SHARED))?.compiled_truth).toContain('Original body.');
  });

  test('readers added after the 202 are kept: the queued job refuses at write time', async () => {
    const res = await ingest(LATER, page('Restricted later', '', 'Queued while the page was open.'));
    expect(res.status).toBe(202);
    const { job_id } = await res.json() as { job_id: number };
    await importFromContent(engine, LATER, page('Restricted later', READERS), { sourceId: SRC, noEmbed: true } as never);
    await expect(makeIngestCaptureHandler(engine)(jobCtx(await jobData(job_id)))).rejects.toMatchObject({ code: 'readable_by_invalid' });
    expect(await readers(LATER)).toEqual(['alice-example', 'bob-example']);
  });

  test('a body that leaves the writer out of readable_by is refused', async () => {
    const res = await ingest(SHARED, page('Shared plan', 'readable_by: [alice-example]\n', 'Locked out.'));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('readable_by_invalid');
    expect(await readers(SHARED)).toEqual(['alice-example', 'bob-example']);
  });

  test('a body that keeps the readers imports, and the readers stay', async () => {
    const res = await ingest(SHARED, page('Shared plan', READERS, 'Updated by bob, readers kept.'));
    expect(res.status).toBe(202);
    const { job_id } = await res.json() as { job_id: number };
    expect((await makeIngestCaptureHandler(engine)(jobCtx(await jobData(job_id)))).status).toBe('imported');
    expect(await readers(SHARED)).toEqual(['alice-example', 'bob-example']);
    expect((await stored(SHARED))?.compiled_truth).toContain('Updated by bob, readers kept.');
  });

  test('a page without readers still imports a body without readers', async () => {
    const res = await ingest(OPEN, page('Team open', '', 'Updated by bob.'));
    expect(res.status).toBe(202);
    const { job_id } = await res.json() as { job_id: number };
    expect((await makeIngestCaptureHandler(engine)(jobCtx(await jobData(job_id)))).status).toBe('imported');
    expect((await stored(OPEN))?.compiled_truth).toContain('Updated by bob.');
    expect(await readers(OPEN)).toBeNull();
  });
});

for (const backend of testBackends()) {
  describe(`a webhook capture keeps stored readers on a managed brain (${backend}, GST-2112)`, () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

    test('the job refuses a body that drops readable_by and imports one that keeps it', () => managedBrain(async ({ engine, ctx }) => {
      __resetPrivateVisibilityCacheForTests();
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SHARED, content: page('Shared plan', READERS) } });
      const bob = await mintLegacyToken(engine, { name: 'bob-managed', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'] });
      await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [bob.id, 'bob-example']);
      const job = (content: string) => jobCtx({ event: webhookEvent(content), slug: SHARED, sourceId: 'default',
        writer: { principal: { kind: 'legacy_token', id: String(bob.id) } } });
      const stored0 = async () => (await engine.readPageSnapshot(SHARED, { sourceId: 'default' }))?.page;
      const readers0 = async () => ((await stored0())?.frontmatter as Record<string, unknown> | undefined)?.readable_by ?? null;
      await expect(makeIngestCaptureHandler(engine)(job(page('Shared plan', '', 'Replaced on a managed brain.')))).rejects.toMatchObject({ code: 'readable_by_invalid' });
      expect(await readers0()).toEqual(['alice-example', 'bob-example']);
      expect((await stored0())?.compiled_truth).toContain('Original body.');
      expect((await makeIngestCaptureHandler(engine)(job(page('Shared plan', READERS, 'Managed update, readers kept.')))).status).toBe('imported');
      expect(await readers0()).toEqual(['alice-example', 'bob-example']);
      expect((await stored0())?.compiled_truth).toContain('Managed update, readers kept.');
    }, { databaseUrl }), 120_000);
  });
}
