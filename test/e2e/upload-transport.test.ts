/**
 * Wave B upload sessions over every transport (spec 6.2): escape-heavy text
 * (quotes, backslashes, control characters, emoji and astral characters)
 * through the legacy HTTP transport (1 MiB inbound cap), the OAuth `/mcp`
 * server (`serve --http`, 4 MiB) and stdio (capped at 4 MiB per part).
 * begin_page_upload advertises the connection's cap less 4 KiB; every part
 * the client cuts fits it; a part over it gets part_too_large; a reply
 * dropped after a part landed resumes from get_page_upload; the committed
 * page is byte-identical. The thin client's put --file, capture --file and
 * large append ride the same sessions. PGLite always, Postgres with
 * DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { materializedPage } from '../../src/core/persistence/segmented-apply.ts';
import { RemoteMcpError } from '../../src/core/remote-mcp-error.ts';
import { stringUploadBody, toolCallFrameBytes, uploadPageBody, type UploadToolCall } from '../../src/core/mcp-client.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { withEnv } from '../helpers/with-env.ts';

const CLI = join(import.meta.dir, '../../src/cli.ts');
const MIB = 1024 * 1024;
const backends = process.env.DATABASE_URL ? ['pglite', 'postgres'] as const : ['pglite'] as const;
const PIECES = ['"quoted" ', '\\back\\slash ', '\u0001\u0002\u0007\u001f', '\t', 'é中文 ', '😀', '🧠👩‍💻', '\u{10FFFF}', '\u2028', ' plain words '];

/** Escape-heavy text whose upload frames run several times `frameBytes`; no frontmatter and no trailing whitespace, so the stored body is the text itself. */
function escapeHeavy(frameBytes: number): string {
  const out: string[] = ['# Upload transport'];
  let size = 0;
  for (let i = 0; size < frameBytes; i++) {
    const line = `line ${i}: ${PIECES.join('')}`;
    out.push(line);
    size += Buffer.byteLength(JSON.stringify(line));
  }
  out.push('end of upload');
  return out.join('\n');
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    child.kill('SIGTERM');
  });
}

/** An upload tool call over an MCP client that records every frame it sends and can drop one reply after the brain stored the part. */
function mcpCall(client: Client, sent: number[], dropReplyOfPart?: number): UploadToolCall {
  let dropped = false;
  return async (tool, args) => {
    if (tool === 'upload_page_part') sent.push(toolCallFrameBytes(tool, args));
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    if (result.isError) throw new Error(text);
    if (tool === 'upload_page_part' && args.part === dropReplyOfPart && !dropped) {
      dropped = true;
      throw new RemoteMcpError('network', 'connection reset after the part was sent', { kind: 'unreachable' });
    }
    return JSON.parse(text) as Record<string, unknown>;
  };
}
const transient = (error: unknown) => error instanceof RemoteMcpError && error.reason === 'network';

/** A commit still publishing (write_pending) settles by its receipt: polls get_write_request until the write is final. */
async function settlePending(client: Client, error: unknown): Promise<Record<string, unknown>> {
  let detail: { error?: string; write_request?: { request_id?: string } };
  try { detail = JSON.parse(error instanceof Error ? error.message : ''); } catch { throw error; }
  const requestId = detail.write_request?.request_id;
  if (detail.error !== 'write_pending' || !requestId) throw error;
  for (let i = 0; i < 120; i++) {
    const read = await client.callTool({ name: 'get_write_request', arguments: { request_id: requestId } }, undefined, { timeout: 60_000 });
    const receipt = JSON.parse((read.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    const state = (receipt.write_request as { state?: string } | undefined)?.state ?? receipt.state;
    if (state === 'committed') return receipt;
    if (state !== 'queued' && state !== 'running' && state !== 'accepted') throw new Error(JSON.stringify(receipt));
    await Bun.sleep(1000);
  }
  throw new Error(`write ${requestId} still pending after 120 polls`);
}

for (const backend of backends) describe(`upload sessions over every transport (${backend})`, () => {
  let home: string;
  let env: Record<string, string>;
  let engine: BrainEngine;
  let config: GBrainConfig;
  let closePostgres: (() => Promise<void>) | undefined;
  const legacyBearer = `gbrain_${randomBytes(32).toString('hex')}`;
  const expected = new Map<string, string>();

  async function cli(args: string[], cliHome = home) {
    const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
      cwd: cliHome, env: { ...env, HOME: cliHome, GBRAIN_HOME: cliHome }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  /** begin + parts + commit through one client; checks the advertised cap, the frames, part_too_large and resume. */
  async function exercise(client: Client, slug: string, capBytes: number) {
    const begun = await client.callTool({ name: 'begin_page_upload', arguments: { slug: `${slug}-probe`, mode: 'create', total_bytes: 1, sha256: createHash('sha256').update('x').digest('hex'), request_id: randomUUID() } });
    expect(begun.isError, JSON.stringify(begun)).not.toBe(true);
    const probe = JSON.parse((begun.content as Array<{ text: string }>)[0]!.text) as { upload_id: string; part_max_frame_bytes: number; next_part: number };
    expect(probe.part_max_frame_bytes).toBe(capBytes - 4096);
    const max = probe.part_max_frame_bytes;
    // A part whose frame is over the advertised cap, yet under the transport's own limit, is refused by the brain.
    let over = '"\\'.repeat(Math.ceil((max + 2000) / 4));
    const tooLarge = await client.callTool({ name: 'upload_page_part', arguments: { upload_id: probe.upload_id, part: probe.next_part, text: over, part_sha256: createHash('sha256').update(over).digest('hex') } });
    expect(tooLarge.isError).toBe(true);
    expect(JSON.stringify(tooLarge)).toContain('part_too_large');
    over = '';
    await client.callTool({ name: 'abort_page_upload', arguments: { upload_id: probe.upload_id } });

    const text = escapeHeavy(max * 2.5);
    const sent: number[] = [];
    const receipt = await uploadPageBody(mcpCall(client, sent, probe.next_part + 1), { slug, mode: 'create', request_id: randomUUID() }, stringUploadBody(text), { transient, wait_ms: 30_000 })
      .catch(error => settlePending(client, error));
    expect(receipt.slug ?? slug).toBe(slug);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const bytes of sent) expect(bytes).toBeLessThanOrEqual(max);
    expected.set(slug, text);
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), `gbrain-upload-transport-${backend}-`));
    env = keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined,
      GBRAIN_SWEEP: '0', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_UPDATE_CHECK: '0', GBRAIN_NO_BANNER: '1', GBRAIN_NO_RETRY_CONNECT: '1', NODE_ENV: 'test',
    });
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      closePostgres = isolated.close;
      config = { engine: 'postgres', database_url: isolated.databaseUrl };
    } else {
      config = { engine: 'pglite', database_path: join(home, 'db') };
      engine = new PGLiteEngine();
      await engine.connect(config);
      await engine.initSchema();
    }
    config = { ...config, embedding_disabled: true } as GBrainConfig;
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
    await engine.executeRaw('INSERT INTO access_tokens (name, token_hash, scopes) VALUES ($1, $2, $3::text[])',
      ['upload-legacy', createHash('sha256').update(legacyBearer).digest('hex'), ['read', 'write']]);
  }, 180_000);

  afterAll(async () => {
    await engine?.disconnect().catch(() => {});
    await closePostgres?.();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('legacy HTTP transport: 1 MiB cap', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }), token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }) } });
      const client = new Client({ name: 'upload-legacy-http', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${legacyBearer}` } } }));
        await exercise(client, 'uploads/legacy-http', MIB);
      } finally {
        await client.close().catch(() => {});
        server.stop?.(true);
        await engine.disconnect();
      }
    });
  }, 300_000);

  /** Runs `fn` against a `serve --http` OAuth brain, with an MCP client connected and a thin-client home pointed at it. */
  async function withOAuthServe(name: string, fn: (client: Client, thinHome: string) => Promise<void>) {
    const reg = await cli(['auth', 'register-client', `upload-${name}-${backend}`, '--grant-types', 'client_credentials', '--scopes', 'read write', '--token-endpoint-auth-method', 'client_secret_post']);
    const clientId = /Client ID:\s+(\S+)/.exec(reg.stdout)?.[1];
    const clientSecret = /Client Secret:\s+(\S+)/.exec(reg.stdout)?.[1];
    expect(clientId && clientSecret, reg.stdout + reg.stderr).toBeTruthy();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', base],
      { cwd: home, env: { ...env, HOME: home, GBRAIN_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let serverErr = '';
    server.stderr?.on('data', (d: Buffer) => { serverErr = (serverErr + d.toString()).slice(-6000); });
    const thinHome = mkdtempSync(join(tmpdir(), 'gbrain-upload-thin-'));
    const client = new Client({ name: `upload-${name}`, version: '1' });
    try {
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        try { ready = (await fetch(`${base}/health`)).ok; } catch { /* starting */ }
        if (!ready) await Bun.sleep(500);
      }
      expect(ready, serverErr).toBe(true);
      const minted = await fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId!, client_secret: clientSecret!, scope: 'read write' }) });
      const { access_token } = await minted.json() as { access_token: string };
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
      mkdirSync(join(thinHome, '.gbrain'), { recursive: true });
      writeFileSync(join(thinHome, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'postgres', remote_mcp: { issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: clientId, oauth_client_secret: clientSecret } }));
      await fn(client, thinHome);
    } catch (error) {
      console.error(serverErr);
      throw error;
    } finally {
      await client.close().catch(() => {});
      await stop(server);
      rmSync(thinHome, { recursive: true, force: true });
    }
  }

  test('OAuth /mcp (serve --http): 4 MiB cap, and the thin client put --file and capture --file ride upload sessions', async () => {
    await withOAuthServe('oauth', async (client, thinHome) => {
      await exercise(client, 'uploads/oauth-mcp', 4 * MIB);
      const big = escapeHeavy(2 * MIB);
      writeFileSync(join(thinHome, 'big.md'), big);
      const put = await cli(['put', 'uploads/thin-put', '--file', join(thinHome, 'big.md')], thinHome);
      expect(put.code, put.stdout + put.stderr).toBe(0);
      expected.set('uploads/thin-put', big);
      const capture = await cli(['capture', '--file', join(thinHome, 'big.md'), '--slug', 'uploads/thin-capture', '--json'], thinHome);
      expect(capture.code, capture.stdout + capture.stderr).toBe(0);
      expect(JSON.parse(capture.stdout)).toMatchObject({ slug: 'uploads/thin-capture' });
    });
  }, 600_000);

  test('OAuth /mcp: the thin client appends directly within the part cap the server reports (--expect-tail honoured), and through an upload session above it', async () => {
    await withOAuthServe('append', async (_client, thinHome) => {
      const big = escapeHeavy(2 * MIB);
      const huge = escapeHeavy(4 * MIB + 64 * 1024);
      writeFileSync(join(thinHome, 'big.md'), big);
      writeFileSync(join(thinHome, 'huge.md'), huge);
      writeFileSync(join(thinHome, 'start.md'), '# Thin append');
      expect((await cli(['put', 'uploads/thin-append', '--file', join(thinHome, 'start.md')], thinHome)).code).toBe(0);
      const head = await cli(['get', 'uploads/thin-append', '--body', 'none', '--json'], thinHome);
      expect(head.code, head.stdout + head.stderr).toBe(0);
      const tail = /"tail_sha256":\s*"([0-9a-f]{64})"/.exec(head.stdout)?.[1];
      expect(tail, head.stdout).toBeDefined();
      const direct = await cli(['append', 'uploads/thin-append', '--file', join(thinHome, 'big.md'), '--expect-tail', tail!, '--json'], thinHome);
      expect(direct.code, direct.stdout + direct.stderr).toBe(0);
      const refused = await cli(['append', 'uploads/thin-append', '--file', join(thinHome, 'huge.md'), '--region', 'truth'], thinHome);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('--region apply only to an append whose call fits');
      const uploaded = await cli(['append', 'uploads/thin-append', '--file', join(thinHome, 'huge.md'), '--json'], thinHome);
      expect(uploaded.code, uploaded.stdout + uploaded.stderr).toBe(0);
      expected.set('uploads/thin-append', `# Thin append\n${big}\n${huge}`);
    });
  }, 600_000);

  test('stdio: 64 MiB inbound, capped at 4 MiB per part', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve'], cwd: home,
      env: { ...env, HOME: home, GBRAIN_HOME: home }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
    const client = new Client({ name: 'upload-stdio', version: '1' });
    try {
      await client.connect(transport);
      await exercise(client, 'uploads/stdio', 4 * MIB);
    } catch (error) {
      console.error(stderr);
      throw error;
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 300_000);

  test('every committed page is byte-identical to what was uploaded', async () => {
    await engine.connect(config);
    for (const [slug, text] of expected) {
      const page = await materializedPage(engine, await engine.getPage(slug, { sourceId: 'default' }));
      expect(page, slug).not.toBeNull();
      const body = page!.timeline ? `${page!.compiled_truth}\n${page!.timeline}` : page!.compiled_truth;
      expect({ slug, bytes: Buffer.byteLength(body), same: body === text }).toEqual({ slug, bytes: Buffer.byteLength(text), same: true });
    }
    expect(expected.size).toBe(5);
  }, 300_000);
});
