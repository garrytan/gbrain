/**
 * `mcp.advertised_surface` narrows what tools/list shows without narrowing
 * what can be called. On stdio: a tool outside the listed set is still
 * callable, and once request_tools describes it, it joins this session's
 * list (tools/list_changed). The callable ceiling (--surface) still blocks.
 * Initialize instructions name request_tools when tools are left unlisted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { operations } from '../src/core/operations.ts';
import { advertisedOps, filterOpsForSurface, resolveAdvertisedSurface } from '../src/mcp/surface.ts';
import { buildMcpInstructions } from '../src/mcp/instructions.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let home: string;

function childEnv(): Record<string, string> {
  return keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined,
    GBRAIN_NON_INTERACTIVE: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', NO_COLOR: '1',
  });
}

async function gbrain(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], { cwd: home, env: childEnv(), stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: `${stdout}\n${stderr}` };
}

async function session<T>(serveArgs: string[], fn: (client: Client, changed: () => number) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve', ...serveArgs], env: childEnv(), cwd: home, stderr: 'pipe' });
  const client = new Client({ name: 'advertised-surface', version: '1' }, { capabilities: {} });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changes++; });
  await client.connect(transport);
  try { return await fn(client, () => changes); } finally { await client.close().catch(() => {}); }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-advertised-'));
  const init = await gbrain(['init', '--pglite', '--no-embedding']);
  if (init.code !== 0) throw new Error(`init failed: ${init.out}`);
  const set = await gbrain(['config', 'set', 'mcp.advertised_surface', 'verbs']);
  if (set.code !== 0) throw new Error(`config set failed: ${set.out}`);
}, 180_000);
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('advertised surface (pure)', () => {
  test('narrows the callable list, never widens it', () => {
    const full = filterOpsForSurface(operations, 'full');
    expect(advertisedOps(full, 'full', 'verbs').map(o => o.name).sort()).toEqual(filterOpsForSurface(operations, 'verbs').map(o => o.name).sort());
    const verbs = filterOpsForSurface(operations, 'verbs');
    expect(advertisedOps(verbs, 'verbs', 'full')).toBe(verbs);
    expect(advertisedOps(full, 'full', null)).toBe(full);
  });

  test('the database plane wins over the file plane; unrecognized values advertise everything', async () => {
    const engine = { getConfig: async (k: string) => (k === 'mcp.advertised_surface' ? 'starter' : null) } as never;
    expect(await resolveAdvertisedSurface(engine, { mcp: { advertised_surface: 'verbs' } } as never)).toBe('starter');
    expect(await resolveAdvertisedSurface(null, { mcp: { advertised_surface: 'verbs' } } as never)).toBe('verbs');
    const junk = { getConfig: async () => 'everything' } as never;
    expect(await resolveAdvertisedSurface(junk, { mcp: { advertised_surface: 'verbs' } } as never)).toBeNull();
  });

  test('instructions name request_tools only when tools are unlisted and request_tools is callable', () => {
    expect(buildMcpInstructions({ tools: { callable: () => true, hiddenCallable: 130 } })).toContain('130 more are callable. Call request_tools');
    expect(buildMcpInstructions({ tools: { callable: () => true } })).not.toContain('more are callable');
    expect(buildMcpInstructions({ tools: { callable: n => n !== 'request_tools', hiddenCallable: 5 } })).not.toContain('more are callable');
  });
});

describe('stdio session', () => {
  test('lists the verbs, calls an unlisted tool, and lists it once request_tools describes it', async () => {
    await session([], async (client, changed) => {
      const listed = (await client.listTools()).tools.map(t => t.name);
      expect(listed.sort()).toEqual(filterOpsForSurface(operations, 'verbs').map(o => o.name).sort());
      expect(listed).not.toContain('put_page');
      const put = await client.callTool({ name: 'put_page', arguments: { slug: 'notes/advertised', content: '---\ntype: note\ntitle: Advertised\n---\nHidden but callable.\n' } });
      expect(put.isError).toBeFalsy();
      const req = await client.callTool({ name: 'request_tools', arguments: { tools: ['put_page'] } });
      expect(req.isError).toBeFalsy();
      for (let i = 0; i < 50 && changed() === 0; i++) await Bun.sleep(50);
      expect(changed()).toBe(1);
      expect((await client.listTools()).tools.map(t => t.name)).toContain('put_page');
    });
  }, 120_000);

  test('the callable ceiling still blocks', async () => {
    await session(['--surface', 'verbs'], async (client) => {
      const put = await client.callTool({ name: 'put_page', arguments: { slug: 'notes/blocked', content: 'x' } });
      expect(put.isError).toBe(true);
    });
  }, 120_000);
});
