import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { callRemoteTool, unpackToolResult, _clearMcpClientTokenCache } from '../../src/core/mcp-client.ts';
import { uploadAttachment, downloadAttachment } from '../../src/commands/attachment-transfer.ts';
import { CHUNK_BYTES, sha256 } from '../../src/core/attachments/context.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

describe.skipIf(!hasDatabase())('attachments through the OAuth thin client', () => {
  let dir: string, port: number, child: ChildProcess | undefined, cfg: GBrainConfig;
  let clientId: string, stderr = '';
  let env: NodeJS.ProcessEnv;
  const cli = (...args: string[]) => execFileSync(process.execPath, ['run', 'src/cli.ts', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => unpackToolResult(await callRemoteTool(cfg, name, args));
  async function start() {
    stderr = '';
    child = spawn(process.execPath, ['run', 'src/cli.ts', 'serve', '--http', '--port', String(port), '--public-url', `http://127.0.0.1:${port}`, '--bind', '127.0.0.1'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr!.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-5000); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
      await Bun.sleep(100);
    }
    throw new Error(`Server readiness timeout: ${stderr}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const current = child;
    const exited = new Promise<void>(resolve => current.once('exit', () => resolve()));
    current.kill('SIGKILL'); await exited; child = undefined;
  }
  beforeAll(async () => {
    await setupDB();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-attachment-oauth-'));
    mkdirSync(join(dir, '.gbrain'));
    writeFileSync(join(dir, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: process.env.DATABASE_URL,
      storage: { backend: 'local', bucket: 'test', localPath: join(dir, 'storage') } }));
    env = { ...process.env, GBRAIN_HOME: dir, GBRAIN_DATABASE_URL: process.env.DATABASE_URL, GBRAIN_MCP_FORCE_SURFACE: 'starter' };
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const output = cli('auth', 'register-client', 'attachment-fixture', '--grant-types', 'client_credentials', '--scopes', 'read write');
    clientId = output.match(/Client ID:\s+(\S+)/)![1];
    const secret = output.match(/Client Secret:\s+(\S+)/)![1];
    cfg = { engine: 'postgres', remote_mcp: { mcp_url: `http://127.0.0.1:${port}/mcp`, issuer_url: `http://127.0.0.1:${port}`, oauth_client_id: clientId, oauth_client_secret: secret } };
    await getEngine().putPage('notes/attachment-oauth', { title: 'Attachment fixture', type: 'note', compiled_truth: 'Synthetic data', timeline: '' });
    _clearMcpClientTokenCache();
    await start();
  }, 30000);
  afterAll(async () => {
    await stop();
    if (clientId) cli('auth', 'revoke-client', clientId);
    _clearMcpClientTokenCache();
    await teardownDB();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 30000);

  test('OAuth expiry and a killed server preserve staged ownership and exact bytes', async () => {
    const bytes = Buffer.alloc(CHUNK_BYTES + 17, 0x53);
    const started = await call('attachment_begin', { request_id: randomUUID(), page_slug: 'notes/attachment-oauth', filename: 'original.bin', size_bytes: bytes.length, sha256: sha256(bytes) });
    const first = { upload_id: started.upload_id, offset: 0, data_base64: bytes.subarray(0, CHUNK_BYTES).toString('base64') };
    await call('attachment_write', first);
    // Expire the server token without clearing the client's cache: real 401/refresh path.
    await getEngine().executeRaw('UPDATE oauth_tokens SET expires_at=1 WHERE client_id=$1', [clientId]);
    await stop(); await start();
    await call('attachment_write', first);
    await call('attachment_write', { upload_id: started.upload_id, offset: CHUNK_BYTES, data_base64: bytes.subarray(CHUNK_BYTES).toString('base64') });
    cli('auth', 'rescope-client', clientId, '--bound-slug-prefixes', 'notes/elsewhere/');
    await expect(call('attachment_complete', { upload_id: started.upload_id })).rejects.toThrow();
    cli('auth', 'rescope-client', clientId, '--bound-slug-prefixes', 'none');
    const saved = await call('attachment_complete', { upload_id: started.upload_id });
    expect((await call('attachment_complete', { upload_id: started.upload_id })).attachment_id).toBe(saved.attachment_id);
    const output = join(dir, 'restored.bin');
    await downloadAttachment(call, saved.attachment_id, output);
    expect(readFileSync(output)).toEqual(bytes);
    expect((await call('attachment_list', { page_slug: 'notes/attachment-oauth' })).attachments).toHaveLength(1);
    // Exercise the full supported upload helper through the same OAuth adapter.
    const input = join(dir, 'input.bin'); writeFileSync(input, bytes);
    const second = await uploadAttachment(call, input, 'notes/attachment-oauth', randomUUID());
    await downloadAttachment(call, second.attachment_id, join(dir, 'second.bin'));
    expect(readFileSync(join(dir, 'second.bin'))).toEqual(bytes);
  }, 30000);

  test('revoking the OAuth client blocks an already staged upload', async () => {
    const started = await call('attachment_begin', { request_id: randomUUID(), page_slug: 'notes/attachment-oauth', filename: 'revoked.bin', size_bytes: 0, sha256: sha256(Buffer.alloc(0)) });
    cli('auth', 'revoke-client', clientId);
    clientId = '';
    await expect(call('attachment_complete', { upload_id: started.upload_id })).rejects.toThrow();
    const [row] = await getEngine().executeRaw<{ state: string; file_id: number | null }>('SELECT state,file_id FROM attachment_uploads WHERE id=$1', [started.upload_id]);
    expect(row).toMatchObject({ state: 'pending', file_id: null });
  });
});
