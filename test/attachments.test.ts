import { LocalStorage } from '../src/core/storage/local.ts';
import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { uploadAttachment, downloadAttachment } from '../src/commands/attachment-transfer.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { withEnv } from './helpers/with-env.ts';
import { enforceBoundClientOpAllowList } from '../src/core/ops/context.ts';

let engine: PGLiteEngine;
let dir: string;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function context(client = 'client-a', source = 'default'): OperationContext {
  return { engine, config: { engine: 'pglite', storage: { backend: 'local', bucket: 'test', localPath: dir } },
    logger: { info() {}, warn() {}, error() {} }, remote: true, transport: 'http', dryRun: false,
    sourceId: source, auth: { token: 'synthetic-test-token', clientId: client, principal: { kind: 'oauth_client', id: client },
      scopes: ['read', 'write'], sourceId: source, allowedSources: [source] } } as OperationContext;
}
async function call(name: string, args: Record<string, unknown>, ctx = context()): Promise<any> {
  const op = operationsByName[name];
  expect(op, `${name} must be available over MCP`).toBeDefined();
  expect(op.localOnly).not.toBe(true);
  return op.handler(ctx, args);
}
async function begin(bytes: Buffer, extra: Record<string, unknown> = {}, ctx = context()) {
  return call('attachment_begin', { request_id: randomUUID(), page_slug: 'notes/audit', filename: 'audit.xlsx',
    size_bytes: bytes.length, sha256: digest(bytes), ...extra }, ctx);
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-attachments-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/audit', { title: 'Audit', type: 'note', frontmatter: {}, compiled_truth: 'Audit', timeline: '' });
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other')");
  await engine.putPage('notes/audit', { title: 'Other audit', type: 'note', frontmatter: {}, compiled_truth: 'Other', timeline: '' }, { sourceId: 'other' });
});
afterAll(async () => { await engine?.disconnect(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('an 8 MiB attachment survives bounded chunks, repeated writes and exact byte download', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 0x91);
  const request_id = randomUUID();
  const upload = await begin(bytes, { request_id });
  expect((await begin(bytes, { request_id })).upload_id).toBe(upload.upload_id);
  for (let offset = 0; offset < bytes.length; offset += upload.chunk_bytes) {
    const args = { upload_id: upload.upload_id, offset, data_base64: bytes.subarray(offset, offset + upload.chunk_bytes).toString('base64') };
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(1024 * 1024);
    await call('attachment_write', args);
    if (offset === 0) await call('attachment_write', args);
  }
  const saved = await call('attachment_complete', { upload_id: upload.upload_id });
  expect(saved.sha256).toBe(digest(bytes));
  expect((await call('attachment_complete', { upload_id: upload.upload_id })).attachment_id).toBe(saved.attachment_id);
  const fullReads = spyOn(LocalStorage.prototype, 'download');
  const downloaded: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += upload.chunk_bytes) {
    const chunk = await call('attachment_read', { attachment_id: saved.attachment_id, offset });
    downloaded.push(Buffer.from(chunk.data_base64, 'base64'));
  }
  expect(Buffer.concat(downloaded).equals(bytes)).toBe(true);
  const readCount = fullReads.mock.calls.length;
  fullReads.mockRestore();
  expect(readCount).toBe(0);
  const list = await call('attachment_list', { page_slug: 'notes/audit' });
  expect(list.attachments.map((a: any) => a.attachment_id)).toContain(saved.attachment_id);
  expect(JSON.stringify(list)).not.toContain(dir);
  expect(await engine.executeRaw('SELECT * FROM attachment_chunks WHERE upload_id=$1', [upload.upload_id])).toEqual([]);
});

test('incomplete and corrupt uploads never enter the file catalogue', async () => {
  const bytes = Buffer.from('hello');
  const upload = await begin(bytes);
  await expect(call('attachment_complete', { upload_id: upload.upload_id })).rejects.toMatchObject({ code: 'upload_incomplete' });
  await call('attachment_write', { upload_id: upload.upload_id, offset: 0, data_base64: Buffer.from('wrong').toString('base64') });
  await expect(call('attachment_complete', { upload_id: upload.upload_id })).rejects.toMatchObject({ code: 'checksum_mismatch' });
  await expect(call('attachment_write', { upload_id: upload.upload_id, offset: 0, data_base64: bytes.toString('base64') })).rejects.toMatchObject({ code: 'conflict' });
  await call('attachment_abort', { upload_id: upload.upload_id });
});

test('upload ownership, source isolation and page fences apply on every request', async () => {
  const upload = await begin(Buffer.from('data'));
  await expect(call('attachment_write', { upload_id: upload.upload_id, offset: 0, data_base64: 'ZGF0YQ==' }, context('client-b'))).rejects.toMatchObject({ code: 'not_found' });
  await expect(call('attachment_complete', { upload_id: upload.upload_id }, context('client-a', 'other'))).rejects.toMatchObject({ code: 'not_found' });
  const fenced = context(); fenced.auth!.boundSlugPrefixes = ['notes/elsewhere/'];
  await expect(call('attachment_write', { upload_id: upload.upload_id, offset: 0, data_base64: 'ZGF0YQ==' }, fenced)).rejects.toMatchObject({ code: 'permission_denied' });
  expect((await call('attachment_list', { page_slug: 'notes/audit' }, context('client-b', 'other'))).attachments).toEqual([]);
  await call('attachment_abort', { upload_id: upload.upload_id });
});

test('a namespace-bound client can transfer within its approved namespace', async () => {
  const ctx = context(); ctx.auth!.boundSlugPrefixes = ['notes/'];
  for (const name of ['attachment_begin', 'attachment_write', 'attachment_complete', 'attachment_abort']) {
    expect(() => enforceBoundClientOpAllowList(ctx.auth, operationsByName[name])).not.toThrow();
  }
  const started = await begin(Buffer.alloc(0), {}, ctx);
  const saved = await call('attachment_complete', { upload_id: started.upload_id }, ctx);
  expect(saved.state).toBe('complete');
});

test('invalid metadata and oversized or noncanonical chunks fail before storing bytes', async () => {
  await expect(begin(Buffer.from('a'), { filename: '../secret' })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(begin(Buffer.from('a'), { size_bytes: 1024 ** 3 })).rejects.toMatchObject({ code: 'invalid_params' });
  const upload = await begin(Buffer.from('hello'));
  for (const args of [{ offset: 0, data_base64: '!!!!' }, { offset: 1, data_base64: 'aGVsbG8=' },
    { offset: 0, data_base64: Buffer.alloc(1024 * 1024).toString('base64') }]) {
    await expect(call('attachment_write', { upload_id: upload.upload_id, ...args })).rejects.toMatchObject({ code: 'invalid_params' });
  }
  await call('attachment_abort', { upload_id: upload.upload_id });
});

test('unconfigured storage refuses admission and dry runs create no upload', async () => {
  const noStore = context(); noStore.config = {} as any;
  await expect(begin(Buffer.from('x'), {}, noStore)).rejects.toMatchObject({ code: 'storage_error' });
  const dry = context(); dry.dryRun = true;
  const id = randomUUID();
  expect((await begin(Buffer.from('x'), { request_id: id }, dry)).dry_run).toBe(true);
  expect(await engine.executeRaw('SELECT id FROM attachment_uploads WHERE id=$1', [id])).toEqual([]);
});

test('client transfer preserves filenames and bytes without overwriting an existing local file', async () => {
  const input = join(dir, '[Example] Travel Data.xlsx');
  const output = join(dir, 'download.xlsx');
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 5, 0x37);
  writeFileSync(input, bytes);
  const saved = await uploadAttachment(call, input, 'notes/audit', randomUUID());
  expect(saved.filename).toBe('[Example] Travel Data.xlsx');
  await downloadAttachment(call, saved.attachment_id, output);
  expect(readFileSync(output).equals(bytes)).toBe(true);
  await expect(downloadAttachment(call, saved.attachment_id, output)).rejects.toThrow('already exists');
  expect(readFileSync(output).equals(bytes)).toBe(true);
  const corrupt = async (name: string, args: Record<string, unknown>) => ({ ...await call(name, args), sha256: '0'.repeat(64) });
  await expect(downloadAttachment(corrupt, saved.attachment_id, join(dir, 'corrupt.xlsx'))).rejects.toThrow('checksum mismatch');
  expect(readdirSync(dir).filter(n => n.startsWith('.gbrain-download'))).toEqual([]);
});

test('private, deleted, archived and cross-source attachments stay unreadable', async () => {
  await engine.putPage('notes/restricted', { title: 'Restricted', type: 'note', compiled_truth: 'content', timeline: '' });
  const upload = await begin(Buffer.alloc(0), { page_slug: 'notes/restricted' });
  const saved = await call('attachment_complete', { upload_id: upload.upload_id });
  await expect(call('attachment_read', { attachment_id: saved.attachment_id }, context('client-b', 'other'))).rejects.toMatchObject({ code: 'not_found' });
  await engine.executeRaw("UPDATE pages SET frontmatter=' {\"visibility\":\"private\"}'::jsonb WHERE slug='notes/restricted'");
  await expect(call('attachment_read', { attachment_id: saved.attachment_id })).rejects.toMatchObject({ code: 'not_found' });
  await engine.executeRaw("UPDATE pages SET frontmatter='{}'::jsonb, deleted_at=now() WHERE slug='notes/restricted'");
  await expect(call('attachment_read', { attachment_id: saved.attachment_id })).rejects.toMatchObject({ code: 'not_found' });
  await engine.executeRaw("UPDATE pages SET deleted_at=NULL WHERE slug='notes/restricted'");
  await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
  try { await expect(call('attachment_read', { attachment_id: saved.attachment_id })).rejects.toMatchObject({ code: 'not_found' }); }
  finally { await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'"); }
});

test('changed request metadata, storage destination and expired sessions are rejected', async () => {
  const bytes = Buffer.from('x');
  const id = randomUUID();
  const upload = await begin(bytes, { request_id: id });
  await expect(begin(bytes, { request_id: id, filename: 'different.xlsx' })).rejects.toMatchObject({ code: 'conflict' });
  const moved = context(); moved.config.storage = { backend: 'local', bucket: 'changed', localPath: dir };
  await expect(call('attachment_complete', { upload_id: upload.upload_id }, moved)).rejects.toMatchObject({ code: 'storage_error' });
  await engine.executeRaw("UPDATE attachment_uploads SET expires_at=now()-interval '1 second' WHERE id=$1", [upload.upload_id]);
  await expect(call('attachment_write', { upload_id: upload.upload_id, offset: 0, data_base64: 'eA==' })).rejects.toMatchObject({ code: 'upload_expired' });
  const next = await begin(bytes);
  expect(await engine.executeRaw('SELECT id FROM attachment_uploads WHERE id=$1', [upload.upload_id])).toEqual([]);
  await call('attachment_abort', { upload_id: next.upload_id });
});

test('purging and recreating a page cannot resurrect its former native attachments', async () => {
  await engine.putPage('notes/recreated', { title: 'Original', type: 'note', compiled_truth: 'Original', timeline: '' });
  const upload = await begin(Buffer.alloc(0), { page_slug: 'notes/recreated' });
  const saved = await call('attachment_complete', { upload_id: upload.upload_id });
  await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug='notes/recreated'");
  await engine.putPage('notes/recreated', { title: 'Different', type: 'note', compiled_truth: 'Different', timeline: '' });
  expect((await call('attachment_list', { page_slug: 'notes/recreated' })).attachments).toEqual([]);
  await expect(call('attachment_read', { attachment_id: saved.attachment_id })).rejects.toMatchObject({ code: 'not_found' });
  const [old] = await engine.executeRaw<{ storage_path: string }>('SELECT storage_path FROM files WHERE id=$1', [saved.attachment_id]);
  // Legacy/unmarked objects must not regain ownership through a reused slug either.
  await engine.executeRaw("UPDATE files SET metadata='{}'::jsonb WHERE id=$1", [saved.attachment_id]);
  expect((await call('attachment_list', { page_slug: 'notes/recreated' })).attachments).toEqual([]);
  await expect(call('attachment_read', { attachment_id: saved.attachment_id })).rejects.toMatchObject({ code: 'not_found' });
  const next = await begin(Buffer.from('x'), { request_id: upload.upload_id, page_slug: 'notes/recreated' });
  await call('attachment_write', { upload_id: next.upload_id, offset: 0, data_base64: 'eA==' });
  const replacement = await call('attachment_complete', { upload_id: next.upload_id });
  expect(replacement.attachment_id).not.toBe(saved.attachment_id);
  expect(readFileSync(join(dir, old.storage_path)).length).toBe(0);
});

test('real HTTP MCP accepts multi-request binaries with read/write scopes and denies writes to read-only tokens', async () => {
  const home = join(dir, 'http-home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(context().config));
  const token = randomUUID(), readToken = randomUUID();
  await engine.executeRaw("INSERT INTO access_tokens (name,token_hash,scopes) VALUES ('attachment-test',$1,ARRAY['read','write']),('attachment-reader',$2,ARRAY['read'])", [digest(Buffer.from(token)), digest(Buffer.from(readToken))]);
  await withEnv({ GBRAIN_HOME: home, GBRAIN_HTTP_MAX_BODY_BYTES: '1048576', GBRAIN_MCP_FORCE_SURFACE: undefined }, async () => {
    const server = await startHttpTransport({ engine, port: 0, surface: 'starter' });
    const rpc = async (method: string, params: unknown, auth = token) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      expect(response.status).toBe(200);
      return (await response.json() as any).result;
    };
    const remoteCall = async (name: string, args: Record<string, unknown>) => {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    try {
      const tools = await rpc('tools/list', {});
      expect(tools.tools.some((t: any) => t.name === 'attachment_begin')).toBe(true);
      expect(tools.tools.some((t: any) => t.name === 'file_upload')).toBe(false);
      const denied = await rpc('tools/call', { name: 'attachment_begin', arguments: {} }, readToken);
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain('permission_denied');
      const input = join(dir, 'http.bin'), output = join(dir, 'http-download.bin');
      writeFileSync(input, Buffer.alloc(2 * 1024 * 1024 + 3, 0x17));
      const saved = await uploadAttachment(remoteCall, input, 'notes/audit', randomUUID());
      await downloadAttachment(remoteCall, saved.attachment_id, output);
      expect(readFileSync(output).equals(readFileSync(input))).toBe(true);
    } finally { server.stop(true); }
  });
});


test('retry repairs storage-before-registration failure and preserves bytes after an ambiguous commit', async () => {
  for (const mode of ['before-register', 'after-commit']) {
    const bytes = Buffer.from(`recovery-${mode}`);
    const started = await begin(bytes);
    await call('attachment_write', { upload_id: started.upload_id, offset: 0, data_base64: bytes.toString('base64') });
    const ctx = context();
    ctx.engine = new Proxy(engine, { get(target, key) {
      if (key === 'transaction') return async (fn: any) => {
        const result = await target.transaction(tx => fn(new Proxy(tx, { get(inner, method) {
          if (method === 'executeRaw' && mode === 'before-register') return async (sql: string, ...args: any[]) => {
            if (sql.includes('INSERT INTO files')) throw new Error('synthetic registration failure');
            return (inner.executeRaw as any)(sql, ...args);
          };
          const value = (inner as any)[method]; return typeof value === 'function' ? value.bind(inner) : value;
        } })));
        if (mode === 'after-commit') throw new Error('synthetic lost commit acknowledgement');
        return result;
      };
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(call('attachment_complete', { upload_id: started.upload_id }, ctx)).rejects.toThrow('synthetic');
    const [staged] = await engine.executeRaw<{ storage_key: string }>('SELECT storage_key FROM attachment_uploads WHERE id=$1', [started.upload_id]);
    expect(readFileSync(join(dir, 'attachments', staged.storage_key))).toEqual(bytes);
    const saved = await call('attachment_complete', { upload_id: started.upload_id });
    expect((await call('attachment_complete', { upload_id: started.upload_id })).attachment_id).toBe(saved.attachment_id);
    expect(await engine.executeRaw('SELECT id FROM files WHERE storage_path=$1', [`attachments/${staged.storage_key}`])).toHaveLength(1);
    expect(Buffer.from((await call('attachment_read', { attachment_id: saved.attachment_id })).data_base64, 'base64')).toEqual(bytes);
  }
});

test('failed storage upload or corrupt read-back never publishes an attachment', async () => {
  for (const mode of ['write-failure', 'corrupt-read-back']) {
    const bytes = Buffer.from('original bytes');
    const started = await begin(bytes);
    await call('attachment_write', { upload_id: started.upload_id, offset: 0, data_base64: bytes.toString('base64') });
    const fault = mode === 'write-failure'
      ? spyOn(LocalStorage.prototype, 'upload').mockRejectedValue(new Error('synthetic storage failure'))
      : spyOn(LocalStorage.prototype, 'download').mockResolvedValue(Buffer.from('corrupt bytes'));
    try { await expect(call('attachment_complete', { upload_id: started.upload_id })).rejects.toMatchObject({ code: mode === 'write-failure' ? 'storage_error' : 'checksum_mismatch' }); }
    finally { fault.mockRestore(); }
    const [row] = await engine.executeRaw<{ state: string; file_id: number | null }>('SELECT state,file_id FROM attachment_uploads WHERE id=$1', [started.upload_id]);
    expect(row).toMatchObject({ state: 'pending', file_id: null });
    expect((await call('attachment_complete', { upload_id: started.upload_id })).state).toBe('complete');
  }
});
