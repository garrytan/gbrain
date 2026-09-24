import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { runMigrations } from '../../src/core/migrate.ts';

describe.skipIf(!hasDatabase())('native attachments on PostgreSQL', () => {
  let dir: string;
  let ctx: OperationContext;
  const invoke = (name: string, p: Record<string, unknown>): Promise<any> => operationsByName[name].handler(ctx, p);
  beforeAll(async () => {
    await setupDB();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-attachment-pg-'));
    const engine = getEngine();
    await engine.putPage('notes/files', { title: 'Files', type: 'note', compiled_truth: 'Files', timeline: '' });
    ctx = { engine, config: { engine: 'postgres', storage: { backend: 'local', bucket: 'test', localPath: dir } },
      remote: true, transport: 'http', dryRun: false, logger: { info() {}, warn() {}, error() {} }, sourceId: 'default',
      auth: { token: 'fixture', clientId: 'attachment-test', principal: { kind: 'oauth_client', id: 'attachment-test' }, scopes: ['read', 'write'], sourceId: 'default' } } as OperationContext;
  });
  afterAll(async () => { await teardownDB(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('concurrent identical chunks and completions publish exactly one verified file', async () => {
    const bytes = Buffer.alloc(1024 * 1024 + 7, 0x74);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const params = { request_id: randomUUID(), page_slug: 'notes/files', filename: 'data.xlsx', size_bytes: bytes.length, sha256 };
    const [one, two] = await Promise.all([invoke('attachment_begin', params), invoke('attachment_begin', params)]);
    expect(one.upload_id).toBe(two.upload_id);
    for (let offset = 0; offset < bytes.length; offset += one.chunk_bytes) {
      const chunk = { upload_id: one.upload_id, offset, data_base64: bytes.subarray(offset, offset + one.chunk_bytes).toString('base64') };
      await Promise.all([invoke('attachment_write', chunk), invoke('attachment_write', chunk)]);
    }
    const [a, b] = await Promise.all([invoke('attachment_complete', { upload_id: one.upload_id }), invoke('attachment_complete', { upload_id: one.upload_id })]);
    expect(a.attachment_id).toBe(b.attachment_id);
    expect((await invoke('attachment_list', { page_slug: 'notes/files' })).attachments).toHaveLength(1);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += one.chunk_bytes) {
      chunks.push(Buffer.from((await invoke('attachment_read', { attachment_id: a.attachment_id, offset })).data_base64, 'base64'));
    }
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });

  test('staged binary data is protected by RLS when PostgreSQL runs with its usual bypass role', async () => {
    const rows = await ctx.engine.executeRaw<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname IN ('attachment_uploads','attachment_chunks')");
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.relrowsecurity)).toBe(true);
  });

  test('upgrading a v164 database preserves existing file records and applying migration twice is harmless', async () => {
    const before = await ctx.engine.executeRaw('SELECT * FROM files ORDER BY id');
    expect(before.length).toBeGreaterThan(0);
    await ctx.engine.executeRaw('DROP TABLE attachment_chunks');
    await ctx.engine.executeRaw('DROP TABLE attachment_uploads');
    await ctx.engine.setConfig('version', '164');
    await runMigrations(ctx.engine);
    expect(await ctx.engine.getConfig('version')).toBe('165');
    expect(await ctx.engine.executeRaw('SELECT * FROM files ORDER BY id')).toEqual(before);
    await runMigrations(ctx.engine);
    expect(await ctx.engine.executeRaw('SELECT * FROM files ORDER BY id')).toEqual(before);
    expect(await ctx.engine.executeRaw('SELECT id FROM attachment_uploads')).toEqual([]);
  });
});
