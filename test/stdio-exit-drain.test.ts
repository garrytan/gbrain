/**
 * GST-2760: a stdio MCP process whose stdin closes while a large reply is still buffered must deliver the whole reply
 * before it exits. Bun's process.exit drops stdout it still holds (an 8 MiB write arrives as 64 KiB). Drives the real
 * thin-client bridge in a child process over its own stdio, with the remote calls injected.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdio-drain-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BRIDGE = join(import.meta.dir, '..', 'src', 'mcp', 'remote-bridge.ts');
const SIZE = 8 * 1024 * 1024;

describe('stdio exit drains stdout', () => {
  test('stdin EOF right after a large reply delivers all of it', async () => {
    const script = join(dir, 'bridge-child.ts');
    writeFileSync(script, `
import { startRemoteStdioBridge } from ${JSON.stringify(BRIDGE)};
const cfg = { engine: 'postgres', remote_mcp: { issuer_url: 'https://host.example', mcp_url: 'https://host.example/mcp', oauth_client_id: 'gbrain_cl_example', oauth_client_secret: 'secret-example' } };
await startRemoteStdioBridge(cfg as never, {
  installFatalHandlers: false, mcpStdio: false,
  lifecycle: { getParentPid: () => 1, probeWatchdog: () => false },
  list: (async () => ({ server: { name: 'gbrain', version: '9.0.0.0' }, tools: [{ name: 'get_page', inputSchema: { type: 'object' } }] })) as never,
  forward: (async () => ({ content: [{ type: 'text', text: 'y'.repeat(${SIZE}) }] })) as never,
});
`);
    const child = Bun.spawn([process.execPath, '--no-env-file', script], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, GBRAIN_HOME: dir, GBRAIN_SURFACE: 'full' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'notes/big-example' } } }) + '\n');
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const reply = out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(m => m?.id === 2);
    expect({ code, bytes: out.length >= SIZE, err: code ? err : '' }).toEqual({ code: 0, bytes: true, err: '' });
    expect(reply?.result?.content?.[0]?.text?.length).toBe(SIZE);
  }, 60_000);

  test('the exit waits for the flush, and a reader that never reads cannot hold it past the bound', async () => {
    const { PassThrough } = await import('node:stream');
    const { exitAfterStdoutDrains } = await import('../src/mcp/stdio-lifecycle.ts');
    const exits: Array<number | undefined> = [];
    const flushed = new PassThrough();
    exitAfterStdoutDrains(code => exits.push(code), flushed, 5_000)(0);
    flushed.resume();
    for (let i = 0; i < 100 && !exits.length; i++) await Bun.sleep(5);
    expect(exits).toEqual([0]);
    const stuck = Object.assign(new PassThrough(), { end: () => stuck });
    exitAfterStdoutDrains(code => exits.push(code), stuck as never, 20)(1);
    await Bun.sleep(60);
    expect(exits).toEqual([0, 1]);
  });
});
