import { test, expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { connectLocalOwner } from '../src/mcp/local-owner-client.ts';
import { ownerProof } from '../src/mcp/local-owner-state.ts';
import { hookResolveSocketForConfig, requestContextPack, readIpcSecretForConfig, IPC_UNAVAILABLE } from '../src/core/context/resolve-ipc.ts';

test('an impostor local listener receives neither the discovery secret nor MCP context', async () => {
  let received = '';
  const server = createServer(socket => {
    socket.on('data', chunk => { received += String(chunk); });
    socket.write(JSON.stringify({ challenge: 'a'.repeat(64), proof: '0'.repeat(64) }) + '\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listen failed');
  try {
    await expect(connectLocalOwner({ protocol: 1, pid: process.pid, port: address.port, secret: 'b'.repeat(64), identity: 'test-identity' },
      { cwd: 'private-session-directory' })).rejects.toThrow('authentication failed');
    expect(received).not.toContain('private-session-directory');
    expect(received).not.toContain('b'.repeat(64));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a recorded valid server greeting cannot authenticate a later connection', async () => {
  const secret = 'b'.repeat(64), identity = 'test-identity', challenge = 'a'.repeat(64), oldNonce = 'c'.repeat(64);
  let received = '';
  const server = createServer(socket => {
    socket.on('data', chunk => { received += String(chunk); });
    socket.write(JSON.stringify({ challenge, proof: ownerProof(secret, 'server', challenge, `${oldNonce}:${identity}`) }) + '\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listen failed');
  try {
    await expect(connectLocalOwner({ protocol: 1, pid: process.pid, port: address.port, secret, identity },
      { cwd: 'private-session-directory' })).rejects.toThrow('authentication failed');
    expect(received).not.toContain('private-session-directory');
    expect(received).not.toContain(secret);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('fresh PGLite install shares one owner across simultaneous stdio sessions and survives a chat closing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbo-'));
  const env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    GBRAIN_SOURCE: undefined, GBRAIN_LOCAL_OWNER_IDLE_MS: '1500' });
  const clients: Client[] = [];
  const diagnosticsByClient = new Map<Client, () => string>();
  let ownerFile = '';
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, ['--no-env-file', 'src/cli.ts', ...args], { env, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(`fixture CLI failed: ${r.stderr}`);
  };
  const script = join(process.cwd(), 'src', 'cli.ts');
  const open = async (args: string[], source?: string, forceSurface?: string, cwd = process.cwd(), surfaceEnv?: string) => {
    const client = new Client({ name: 'local-owner-test', version: '1' });
    const sessionEnv = { ...env, ...(source ? { GBRAIN_SOURCE: source } : {}), ...(forceSurface ? { GBRAIN_MCP_FORCE_SURFACE: forceSurface } : {}), ...(surfaceEnv ? { GBRAIN_SURFACE: surfaceEnv } : {}) };
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', script, 'serve', ...args], cwd, env: sessionEnv, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    diagnosticsByClient.set(client, () => diagnostics);
    clients.push(client);
    try { await client.connect(transport); } catch (error) { throw new Error(`MCP handshake failed: ${error}; ${diagnostics}`); }
    return client;
  };
  try {
    cli(['init', '--pglite', '--no-embedding', '--non-interactive']);
    const notes = join(home, 'notes'); mkdirSync(notes);
    writeFileSync(join(notes, 'shared.md'), '---\ntitle: sharedowner-mark-3r8\n---\n\nsharedowner-mark-3r8\n');
    cli(['import', notes, '--no-embed']);
    const secondNotes = join(home, 'second-notes'); mkdirSync(secondNotes);
    writeFileSync(join(secondNotes, 'separate.md'), '---\ntitle: separateowner-mark-7h4\n---\n\nseparateowner-mark-7h4\n');
    cli(['sources', 'add', 'separate-source', '--path', secondNotes, '--no-federated', '--force']);
    cli(['import', secondNotes, '--no-embed', '--source-id', 'separate-source']);
    const cfg = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
    ownerFile = join(cfg.database_path, '.gbrain-mcp-owner', 'owner.json');
    const [first, second] = await Promise.all([open([], 'default'), open(['--access', 'read-only'], 'default')]);
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
    expect(owner.pid).toBeGreaterThan(0);
    const lists = await Promise.all([first.listTools(), second.listTools()]);
    const narrow = await open(['--surface', 'starter'], 'default');
    expect(diagnosticsByClient.get(narrow)!()).toContain('surface=starter (source: --surface)');
    await narrow.callTool({ name: 'request_tools', arguments: { surface: 'full' } });
    expect(diagnosticsByClient.get(narrow)!()).toContain('surface_widened from=starter to=full');
    expect(diagnosticsByClient.get(second)!()).not.toContain('surface_widened');
    await narrow.close();
    const envSurface = await open(['--surface', 'full'], 'default', undefined, process.cwd(), 'verbs');
    expect((await envSurface.listTools()).tools).toHaveLength(7);
    expect(diagnosticsByClient.get(envSurface)!()).toContain('surface=verbs (source: env GBRAIN_SURFACE)');
    await envSurface.close();
    const invalidSurface = await open(['--surface', 'starter'], 'default', undefined, process.cwd(), 'everything');
    expect(diagnosticsByClient.get(invalidSurface)!()).toContain('ignoring GBRAIN_SURFACE="everything"');
    expect(JSON.stringify(await invalidSurface.callTool({ name: 'whoami', arguments: {} }))).toContain('surface_env_invalid');
    expect(JSON.stringify(await invalidSurface.callTool({ name: 'whoami', arguments: {} }))).not.toContain('surface_env_invalid');
    await invalidSurface.close();
    expect(lists[0].tools.some(t => t.name === 'put_page')).toBe(true);
    expect(lists[1].tools.some(t => t.name === 'put_page')).toBe(false);
    const results = await Promise.all([first, second].map(client => client.callTool({ name: 'search', arguments: { query: 'sharedowner-mark-3r8' } })));
    for (const result of results) { expect(result.isError).not.toBe(true); expect(JSON.stringify(result.content)).toContain('sharedowner-mark-3r8'); }
    await first.close();
    expect((await second.callTool({ name: 'search', arguments: { query: 'sharedowner-mark-3r8' } })).isError).not.toBe(true);
    expect(JSON.parse(readFileSync(ownerFile, 'utf8')).pid).toBe(owner.pid);
    const scoped = await open([], 'separate-source', undefined, secondNotes);
    const socket = await hookResolveSocketForConfig(cfg, 'separate-source');
    const ipcSecret = readIpcSecretForConfig(cfg);
    expect(socket).not.toBeNull(); expect(ipcSecret).not.toBeNull();
    const pack = await requestContextPack(socket!, { secret: ipcSecret!, sourceId: 'separate-source', sessionId: 'source-hook-test', window: [], entities: [] }, { timeoutMs: 5000 });
    expect(pack).not.toBe(IPC_UNAVAILABLE);
    expect((pack as { error?: string }).error).not.toBe('source_mismatch');
    expect(JSON.stringify((await scoped.callTool({ name: 'search', arguments: { query: 'separateowner-mark-7h4' } })).content)).toContain('separateowner-mark-7h4');
    expect(JSON.stringify((await second.callTool({ name: 'search', arguments: { query: 'separateowner-mark-7h4' } })).content)).not.toContain('separateowner-mark-7h4');
    expect(JSON.stringify((await scoped.callTool({ name: 'search', arguments: { query: 'sharedowner-mark-3r8' } })).content)).not.toContain('sharedowner-mark-3r8');
    expect(JSON.parse(readFileSync(ownerFile, 'utf8')).pid).toBe(owner.pid);
    const ownUpload = await scoped.callTool({ name: 'file_upload', arguments: { path: 'separate.md' } });
    expect(JSON.parse((ownUpload.content as Array<{ text: string }>)[0].text).code).toBe('storage_error');
    const foreignUpload = await scoped.callTool({ name: 'file_upload', arguments: { path: join(notes, 'shared.md') } });
    expect(JSON.parse((foreignUpload.content as Array<{ text: string }>)[0].text).code).toBe('invalid_params');
    const narrowed = await open([], 'default', 'verbs');
    expect((await narrowed.listTools()).tools.some(t => t.name === 'search')).toBe(false);
    expect((await second.listTools()).tools.some(t => t.name === 'search')).toBe(true);
    const idle = await open(['--stdio-idle-timeout', '1'], 'default');
    let idleClosed = false; idle.onclose = () => { idleClosed = true; };
    for (let i = 0; i < 50 && !idleClosed; i++) await delay(100);
    expect(idleClosed).toBe(true);
    expect((await second.listTools()).tools.some(t => t.name === 'search')).toBe(true);
    // A one-shot caller closes stdin immediately after its last request.
    const oneShot = spawn(process.execPath, ['--no-env-file', script, 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let frames = '';
    let initialized = false;
    oneShot.stdout.on('data', chunk => {
      frames += String(chunk);
      if (!initialized && frames.includes('"id":1')) {
        initialized = true;
        oneShot.stdin.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
          + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'sharedowner-mark-3r8' } } }) + '\n');
      }
    });
    oneShot.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'one-shot-test', version: '1' } } }) + '\n');
    const result = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { oneShot.kill(); reject(new Error('one-shot fixture timed out')); }, 20_000);
      oneShot.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    expect(result).toBe(0); expect(frames).toContain('"id":2'); expect(frames).toContain('sharedowner-mark-3r8');
    await narrowed.close(); await scoped.close();
    await second.close();
    for (let i = 0; i < 100 && existsSync(ownerFile); i++) await delay(100);
    expect(existsSync(ownerFile)).toBe(false);
    // A later chat starts a fresh owner without manually restarting a service.
    const third = await open([], 'default');
    expect((await third.callTool({ name: 'search', arguments: { query: 'sharedowner-mark-3r8' } })).isError).not.toBe(true);
    expect(JSON.parse(readFileSync(ownerFile, 'utf8')).pid).not.toBe(owner.pid);
    const newPid = JSON.parse(readFileSync(ownerFile, 'utf8')).pid;
    // Abrupt owner death must not require deleting a lock or restarting a service.
    process.kill(newPid, 'SIGKILL'); await delay(500); await third.close();
    const fourth = await open([], 'default');
    expect((await fourth.callTool({ name: 'search', arguments: { query: 'sharedowner-mark-3r8' } })).isError).not.toBe(true);
    expect(JSON.parse(readFileSync(ownerFile, 'utf8')).pid).not.toBe(newPid);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    for (let i = 0; i < 100 && ownerFile && existsSync(ownerFile); i++) await delay(100);
    if (ownerFile && existsSync(ownerFile)) {
      const record = JSON.parse(readFileSync(ownerFile, 'utf8'));
      try { process.kill(record.pid); } catch { /* already exited */ }
      await delay(500);
    }
    try { rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) {
      // Bun on Windows can report EBUSY for a closed private PGLite tree;
      // Node's filesystem cleanup handles the same tree without changing ACLs.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      const cleanup = spawnSync('node', ['-e', "require('fs').rmSync(process.argv[1], {recursive:true,force:true,maxRetries:20,retryDelay:100})", home]);
      if (cleanup.status !== 0) throw error;
    }
  }
}, 180_000);
