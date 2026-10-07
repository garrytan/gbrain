/**
 * Runtime widening on the owner's stdio pipe, and GBRAIN_SURFACE on stdio
 * `serve`, over real MCP stdio sessions on a hermetic PGLite brain.
 *
 * Protects: `request_tools {surface}` widens this session's one allow-set
 * (tools/list and dispatch both see it), sends tools/list_changed, returns
 * the new tools' schemas so a client that ignores list_changed can call them
 * by name, writes a `surface_widened` audit line, and persists nothing (a new
 * session starts at the registered surface); `--access read-only` still caps
 * it; `mcp.allow_session_widen=false` refuses with the persistent route;
 * stdio resolves GBRAIN_SURFACE > --surface, an invalid value is ignored
 * with a stderr line and one `surface_env_invalid` notice, and whoami /
 * gbrain://capabilities report the surface and its source. HTTP keeps its
 * per-client branch (test/request-tools.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { CAPABILITIES_URI } from '../src/mcp/capabilities.ts';

let home: string;
let env: Record<string, string>;

function cli(args: string[]) {
  return spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
}

interface Session { client: Client; stderr: () => string; listChanged: () => number; close: () => Promise<void> }

async function session(args: string[], extraEnv: Record<string, string> = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    // These fixtures mutate config between sessions, requiring immediate DB release.
    command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--direct', ...args], cwd: process.cwd(), env: { ...env, ...extraEnv }, stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  const client = new Client({ name: 'gbrain-request-tools-stdio-test', version: '1.0.0' }, { capabilities: {} });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
  await client.connect(transport);
  return { client, stderr: () => err, listChanged: () => changed, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}

const names = async (s: Session) => (await s.client.listTools()).tools.map(t => t.name);
const parsed = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0]).text) as Record<string, unknown>;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-request-tools-stdio-'));
  env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SURFACE: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined, GBRAIN_NO_ONBOARD_NUDGE: '1' });
  delete env.GBRAIN_SOURCE;
  expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive']).status).toBe(0);
}, 120_000);

afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe('request_tools {surface} on stdio', () => {
  test('widens this session: list_changed, tools/list and dispatch agree, schemas returned, audit line, nothing persisted', async () => {
    const s = await session(['--surface', 'starter']);
    try {
      expect(await names(s)).not.toContain('get_health');
      const hidden = await s.client.callTool({ name: 'get_health', arguments: {} });
      expect(isError(hidden)).toBe(true);
      const hint = parsed(hidden) as { fix?: { mcp?: { tool: string; arguments: unknown }; next?: string } };
      expect(hint.fix?.mcp).toEqual({ tool: 'request_tools', arguments: { surface: 'full' } });
      expect(hint.fix?.next).toBe('run');

      const widened = parsed(await s.client.callTool({ name: 'request_tools', arguments: { surface: 'full' } })) as {
        persisted: boolean; scope: string; surface: string; previous: string; tools: Array<{ name: string }>; note: string;
      };
      expect(widened).toMatchObject({ persisted: false, scope: 'session', surface: 'full', previous: 'starter' });
      expect(widened.tools.map(t => t.name)).toContain('get_health');
      expect(widened.note).toContain('GBRAIN_SURFACE=full');

      // A client that ignores list_changed calls the new tool by name.
      expect(isError(await s.client.callTool({ name: 'get_health', arguments: {} }))).toBe(false);
      await waitFor(() => s.listChanged() > 0, { timeoutMs: 10_000 });
      expect(await names(s)).toContain('get_health');
      expect(s.stderr()).toMatch(/surface_widened from=starter to=full op=request_tools/);

      const who = parsed(await s.client.callTool({ name: 'whoami', arguments: {} }));
      expect(who).toMatchObject({ transport: 'stdio', surface: 'full', surface_source: 'flag' });
    } finally {
      await s.close();
    }
    const next = await session(['--surface', 'starter']);
    try {
      expect(await names(next)).not.toContain('get_health');
    } finally {
      await next.close();
    }
  }, 90_000);

  test('--access read-only still caps the session: request_tools is not callable and the hint stays read-only', async () => {
    const s = await session(['--surface', 'starter', '--access', 'read-only']);
    try {
      expect(await names(s)).not.toContain('request_tools');
      expect(isError(await s.client.callTool({ name: 'request_tools', arguments: { surface: 'full' } }))).toBe(true);
      const put = parsed(await s.client.callTool({ name: 'put_page', arguments: { slug: 'notes/x', content: 'x' } })) as { fix?: { mcp?: unknown; next?: string } };
      expect(put.fix?.mcp).toBeUndefined();
      expect(put.fix?.next).toBe('tell_user_to_run');
    } finally {
      await s.close();
    }
  }, 60_000);

  test('mcp.allow_session_widen=false refuses with the persistent route, and the hint names it', async () => {
    expect(cli(['config', 'set', 'mcp.allow_session_widen', 'false']).status).toBe(0);
    const s = await session(['--surface', 'starter']);
    try {
      const hint = parsed(await s.client.callTool({ name: 'get_health', arguments: {} })) as { suggestion: string; fix?: { mcp?: unknown; next?: string; user_message?: string } };
      expect(hint.fix?.mcp).toBeUndefined();
      expect(hint.fix?.next).toBe('tell_user_to_run');
      expect(hint.suggestion).toContain('GBRAIN_SURFACE=full');
      const refused = await s.client.callTool({ name: 'request_tools', arguments: { surface: 'full' } });
      expect(isError(refused)).toBe(true);
      const env = parsed(refused) as { code: string; suggestion: string };
      expect(env.code).toBe('permission_denied');
      expect(env.suggestion).toContain('GBRAIN_SURFACE=full');
      expect(await names(s)).not.toContain('get_health');
    } finally {
      await s.close();
      expect(cli(['config', 'set', 'mcp.allow_session_widen', 'true']).status).toBe(0);
    }
  }, 60_000);
});

describe('GBRAIN_SURFACE on stdio serve', () => {
  test('the env wins over --surface, and whoami and capabilities report it', async () => {
    const s = await session(['--surface', 'full'], { GBRAIN_SURFACE: 'verbs' });
    try {
      expect((await names(s)).length).toBe(7);
      expect(s.stderr()).toContain('surface=verbs (source: env GBRAIN_SURFACE)');
      const caps = JSON.parse(((await s.client.readResource({ uri: CAPABILITIES_URI })).contents[0] as { text: string }).text) as { surface: string; surface_source: string };
      expect(caps).toMatchObject({ surface: 'verbs', surface_source: 'env' });
    } finally {
      await s.close();
    }
  }, 60_000);

  test('an invalid value is ignored with a stderr line and one surface_env_invalid notice naming the served surface', async () => {
    const s = await session(['--surface', 'starter'], { GBRAIN_SURFACE: 'everything' });
    try {
      expect(await names(s)).toContain('put_page');
      expect(s.stderr()).toContain('ignoring GBRAIN_SURFACE="everything"');
      const first = await s.client.callTool({ name: 'whoami', arguments: {} }) as { content: Array<{ text: string }>; _meta?: { gbrain_notices?: Array<{ code: string; why: string }> } };
      const notice = first._meta?.gbrain_notices?.find(n => n.code === 'surface_env_invalid');
      expect(notice?.why).toContain("serves 'starter' (source: --surface)");
      expect(first.content.some(c => c.text.startsWith('[gbrain notice surface_env_invalid kind=info]'))).toBe(true);
      const second = await s.client.callTool({ name: 'whoami', arguments: {} }) as { _meta?: { gbrain_notices?: Array<{ code: string }> } };
      expect(second._meta?.gbrain_notices?.some(n => n.code === 'surface_env_invalid') ?? false).toBe(false);
    } finally {
      await s.close();
    }
  }, 60_000);
});
