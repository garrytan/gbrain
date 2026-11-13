/**
 * GST-2113: a webhook capture (POST /ingest, then its ingest_capture job) writes only inside its credential's write source.
 *
 * When the granted source was archived or removed after the 202, the job wrote the capture under default, where the
 * credential may have no grant, replacing an unrestricted default page at the same slug.
 * Protects (real token verifier and Express route for the 202, the real handler, PGLite):
 * - a webhook job whose granted source was archived after the 202 refuses source_changed and leaves default untouched;
 * - a webhook job whose source row vanished mid-write (pages source FK) refuses the same way;
 * - on a managed brain, a source archived between the job's check and the door's put refuses and leaves default untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { computeContentHash } from '../src/core/ingestion/types.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const SRC = 'source-a';
const note = (title: string, line: string) => `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\n${line}\n`;
const jobCtx = (id: number, data: Record<string, unknown>): MinionJobContext => ({ id, name: 'ingest_capture', data,
  attempts_made: 0, idempotency_key: null, signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
  updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] });
const captureData = (content: string, slug: string, sourceId: string) => ({ slug, sourceId, event: { source_id: 'webhook-client-example', source_kind: 'webhook',
  source_uri: 'mcp-webhook:client-example:1', received_at: new Date().toISOString(), content_type: 'text/markdown', content,
  content_hash: computeContentHash(content), untrusted_payload: true } });
const text = async (engine: BrainEngine, slug: string, sourceId: string) => (await engine.readPageSnapshot(slug, { sourceId }))?.page.compiled_truth ?? null;
const refused = { code: 'source_changed', detail: 'webhook_source_unavailable' };

describe('a webhook capture never falls back to default (GST-2113)', () => {
  let engine: PGLiteEngine;
  let server: Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    token = (await mintLegacyToken(engine, { name: 'granted-writer', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const app = express();
    const pass: express.RequestHandler = (_req, _res, next) => next();
    mountWebhooks(app, { engine, resourceVerifier: provider, resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
      ingestRateLimiter: pass, githubWebhookLimiter: pass, broadcastEvent: () => {} } as unknown as ServeHttpContext);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await engine.disconnect();
  }, 30_000);

  test('a job whose granted source was archived after the 202 refuses and leaves the default page as it was', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    const slug = 'notes/shared-example';
    await importFromContent(engine, slug, note('Shared example', 'Default body.'), { noEmbed: true });
    const res = await fetch(`${base}/ingest`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown', 'x-gbrain-slug': slug },
      body: note('Shared example', 'Captured body.') });
    expect(res.status).toBe(202);
    const jobId = (await res.json() as { job_id: number }).job_id;
    await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', [SRC]);
    const [row] = await engine.executeRaw<{ data: unknown }>('SELECT data FROM minion_jobs WHERE id = $1', [jobId]);
    const data = (typeof row!.data === 'string' ? JSON.parse(row!.data) : row!.data) as Record<string, unknown>;
    expect(data.sourceId).toBe(SRC);

    await expect(makeIngestCaptureHandler(engine)(jobCtx(jobId, data))).rejects.toMatchObject(refused);
    expect(await text(engine, slug, 'default')).toContain('Default body.');
    expect(await text(engine, slug, 'default')).not.toContain('Captured body.');
    await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [SRC]);
  });

  test('a job whose source row vanished mid-write refuses and leaves the default page as it was', async () => {
    const racingSource = 'racing-example';
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [racingSource]);
    const slug = 'notes/raced-example';
    await importFromContent(engine, slug, note('Raced example', 'Default body.'), { noEmbed: true });
    let attempts = 0;
    const racing = new Proxy(engine as BrainEngine, { get(target, prop) {
      if (prop === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
        if (++attempts === 1) throw Object.assign(new Error('insert or update on table "pages" violates foreign key constraint "pages_source_id_fk"'), { code: '23503' });
        return target.transaction(fn);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });

    await expect(makeIngestCaptureHandler(racing)(jobCtx(2, captureData(note('Raced example', 'Captured body.'), slug, racingSource)))).rejects.toMatchObject(refused);
    expect(attempts).toBe(1);
    expect(await text(engine, slug, 'default')).toContain('Default body.');
  });
});

describe('a managed webhook capture never falls back to default (GST-2113)', () => {
  test('a source archived before the door\'s put refuses and leaves the default page as it was', () => managedBrain(async ({ engine, ctx }) => {
    const slug = 'notes/managed-shared-example';
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: note('Managed shared', 'Default body.') } });
    let archived = false;
    const archiving = new Proxy(engine, { get(target, prop) {
      if (prop === 'readPageSnapshot') return async (...args: Parameters<BrainEngine['readPageSnapshot']>) => {
        if (!archived && args[1]?.sourceId === SRC) {
          archived = true;
          await target.transaction(async tx => {
            await tx.executeRaw("SELECT set_config('gbrain.topology_change', 'on', true)");
            await tx.executeRaw('UPDATE sources SET archived = true, archived_at = now() WHERE id = $1', [SRC]);
          });
        }
        return target.readPageSnapshot(...args);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });

    await expect(makeIngestCaptureHandler(archiving)(jobCtx(3, captureData(note('Managed shared', 'Captured body.'), slug, SRC)))).rejects.toMatchObject(refused);
    expect(archived).toBe(true);
    expect(await text(engine, slug, 'default')).toContain('Default body.');
    expect(await text(engine, slug, 'default')).not.toContain('Captured body.');
  }, { setup: async ({ engine, root }) => {
    const sourceRoot = join(root, '..', 'source-a'); mkdirSync(sourceRoot);
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING', [SRC, sourceRoot]);
    await claimWorktree(engine, SRC, sourceRoot);
  } }), 120_000);
});
