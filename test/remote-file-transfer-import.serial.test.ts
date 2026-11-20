/**
 * Remote file transfer, import lane: file_upload_commit with import: true turns an uploaded image into an image page
 * from the in-memory bytes, keyed by the stored object's path, linked to the page it was attached to. Serial: it
 * replaces the gateway's multimodal embedder for the process (no provider is called).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gateway from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let embedded = 0;
mock.module('../src/core/ai/gateway.ts', () => ({
  ...gateway,
  embedMultimodal: async (inputs: unknown[]) => { embedded += inputs.length; return inputs.map(() => new Float32Array(1024).fill(0.01)); },
}));
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let engine: InstanceType<typeof PGLiteEngine>;
let home: string;
let storageDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gb-rfti-home-'));
  storageDir = mkdtempSync(join(tmpdir(), 'gb-rfti-storage-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: storageDir } }));
  await engine.putPage('meetings/2026-01-15', { type: 'meeting', title: 'Synthetic meeting', compiled_truth: 'Whiteboard session.', timeline: '' } as never);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const d of [home, storageDir]) rmSync(d, { recursive: true, force: true });
});

async function call(name: string, params: Record<string, unknown>) {
  return withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
    const result = await dispatchToolCall(engine, name, params, { remote: true, transport: 'stdio', sourceId: 'default' });
    return { body: JSON.parse(result.content[0].text), isError: !!result.isError };
  });
}

async function upload(filename: string, extra: Record<string, unknown>) {
  const begin = await call('file_upload_begin', { filename, size_bytes: PNG.length, sha256: sha(PNG), import: true, ...extra });
  await call('file_upload_part', { upload_id: begin.body.upload_id, part: 1, data_base64: PNG.toString('base64') });
  return call('file_upload_commit', { upload_id: begin.body.upload_id });
}

describe('file_upload_commit import: true', () => {
  test('an uploaded image becomes an image page at its storage path, linked to its page, its files row pointing at the stored object', async () => {
    const commit = await upload('Whiteboard.png', { page_slug: 'meetings/2026-01-15' });
    expect(commit.isError).toBe(false);
    expect(commit.body).toMatchObject({ status: 'uploaded', storage_path: 'meetings/2026-01-15/Whiteboard.png' });
    expect(commit.body.import).toMatchObject({ status: 'imported', slug: 'meetings/2026-01-15/whiteboard.png', image_of: 'meetings/2026-01-15' });

    const page = await engine.getPage('meetings/2026-01-15/whiteboard.png', { sourceId: 'default' });
    expect(page?.type).toBe('image');
    const [file] = await engine.executeRaw<{ page_id: number; metadata: Record<string, unknown> }>(`SELECT page_id, metadata FROM files WHERE storage_path = 'meetings/2026-01-15/Whiteboard.png'`);
    expect(file.page_id).toBe(page!.id);
    expect(file.metadata).toMatchObject({ storage: 'local' });
    const links = await engine.getLinks('meetings/2026-01-15/whiteboard.png');
    expect(links.some((l: { to_slug: string; link_type: string }) => l.to_slug === 'meetings/2026-01-15' && l.link_type === 'image_of')).toBe(true);
    const [visual] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'meetings/2026-01-15/whiteboard.png' AND c.embedding_image IS NOT NULL`);
    expect(embedded).toBeGreaterThan(0);
    expect(visual.n).toBe(1);
  });

  test('an image without a matching extension is stored under one, so the importer reads it', async () => {
    const commit = await upload('photo', {});
    expect(commit.isError).toBe(false);
    expect(commit.body.storage_path).toBe(`unsorted/${sha(PNG).slice(0, 8)}-photo.png`);
    expect(commit.body.import.status).toBe('imported');
  });
});
