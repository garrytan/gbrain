import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real CLI subprocesses against a loopback-only MCP fixture; no datastore or keys.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function run(mode: 'timeout' | 'pending' | 'conflict' | 'interrupt', json = true, command = ['remember', 'fixture', '--provenance', 'test']) {
  let args: Record<string, unknown> | undefined;
  let signalSubmitted!: () => void;
  const submitted = new Promise<void>(resolve => { signalSubmitted = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const base = `http://127.0.0.1:${server.port}`;
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, token_endpoint: `${base}/token` });
    if (path === '/token') return Response.json({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600, scope: 'read write' });
    if (path !== '/mcp' || request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.json() as any;
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === 'initialize') result = {
      protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
    };
    else {
      args = body.params.arguments;
      signalSubmitted();
      if (mode === 'timeout' || mode === 'interrupt') return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      }), { headers: { 'Content-Type': 'application/json' } });
      const conflict = mode === 'conflict';
      result = { isError: true, content: [{ type: 'text', text: JSON.stringify({
        error: conflict ? 'invalid_params' : 'unavailable', message: 'Fixture write outcome.',
        suggestion: 'Inspect the original request.', protocol_version: 1,
        write_error: conflict ? 'revision_conflict' : 'write_pending',
        write_request: { request_id: args!.request_id, state: conflict ? 'conflict' : 'queued', retry_after_ms: conflict ? null : 1000 },
      }) }] };
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const root = mkdtempSync(join(tmpdir(), 'gbrain-thin-write-errors-')); roots.push(root);
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', remote_mcp: {
    issuer_url: `http://127.0.0.1:${server.port}`, mcp_url: `http://127.0.0.1:${server.port}/mcp`,
    oauth_client_id: 'fixture', oauth_client_secret: 'fixture',
  } }));
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' };
  for (const name of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE']) delete env[name];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...command, ...(json ? ['--json'] : []), mode === 'interrupt' ? '--timeout=10s' : '--timeout=500ms'], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    if (mode === 'interrupt') await Promise.race([submitted.then(() => child.kill('SIGINT')), child.exited]);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, args };
  } finally { clearTimeout(watchdog); child.kill(); await server.stop(true); }
}

test.each(['timeout', 'interrupt'] as const)('thin CLI %s exposes the generated UUID without a fabricated receipt', async mode => {
  const result = await run(mode);
  expect(result.args?.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: mode === 'interrupt' ? 130 : 1 });
  const body = JSON.parse(result.stdout);
  expect(body).toMatchObject({ error: 'unavailable', request_id: result.args!.request_id, submission_status: 'unknown', detail: 'delivery_unknown', protocol_version: 1 });
  expect(body).not.toHaveProperty('write_request');
  expect(body.suggestion).toContain(result.args!.request_id);
}, 15_000);

test.each(['pending', 'conflict'] as const)('thin CLI renders the frozen %s receipt as JSON', async mode => {
  const result = await run(mode);
  expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 1 });
  const body = JSON.parse(result.stdout);
  expect(body).toMatchObject({ error: mode === 'conflict' ? 'invalid_params' : 'unavailable', protocol_version: 1,
    write_error: mode === 'conflict' ? 'revision_conflict' : 'write_pending',
    write_request: { request_id: result.args!.request_id, state: mode === 'conflict' ? 'conflict' : 'queued' },
  });
}, 15_000);

test('human thin CLI errors retain the request UUID too', async () => {
  const result = await run('pending', false);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`Request: ${result.args!.request_id}`);
}, 15_000);

test.each(['timeout', 'pending'] as const)('thin takes %s preserves the same structured retry identity as page writes', async mode => {
  const result = await run(mode, true, ['takes', 'add', 'page', '--claim', 'Example preference', '--kind', 'take', '--who', 'world']);
  expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 1 });
  const body = JSON.parse(result.stdout);
  expect(body.request_id).toBe(result.args!.request_id);
  if (mode === 'timeout') {
    expect(body).toMatchObject({ submission_status: 'unknown', detail: 'delivery_unknown' });
    expect(body).not.toHaveProperty('write_request');
  } else expect(body.write_request).toMatchObject({ request_id: result.args!.request_id, state: 'queued' });
}, 15_000);

test.each([
  ['add', ['--claim', 'Example', '--kind', 'take', '--who', 'world']],
  ['update', ['--row', '1', '--weight', '0.4']],
  ['supersede', ['--row', '1', '--claim', 'New example']],
  ['resolve', ['--row', '1', '--quality', 'correct']],
] as const)('thin takes %s forwards explicit retry and revision tokens unchanged', async (verb, options) => {
  const requestId = '31000000-0000-4000-8000-000000000001';
  const revision = '32000000-0000-4000-8000-000000000001';
  const result = await run('pending', true, ['takes', verb, 'page', ...options, '--request-id', requestId, '--expected-revision', revision]);
  expect(result.code).toBe(1);
  expect(result.args).toMatchObject({ request_id: requestId, expected_revision: revision });
  expect(JSON.parse(result.stdout).write_request).toMatchObject({ request_id: requestId, state: 'queued' });
}, 15_000);
