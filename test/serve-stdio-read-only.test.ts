/**
 * #4768 (stdio half): `gbrain serve --access read-only` over a real MCP stdio
 * session on a hermetic PGLite brain, on every surface tier.
 *
 * Protects: the read-only ceiling is one operation set for tools/list, the
 * capabilities resource and dispatch; guessed mutating tools (put_page,
 * delete_page, remember, capture) and request_tools are refused before any
 * handler runs (no page is written); read operations keep working; the
 * default (no flag) is unchanged; `--http --access read-only` refuses.
 * Regression it catches: a catalog-only filter that leaves dispatch resolving
 * the global catalog, or a predicate that admits mutating operations.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { operations } from '../src/core/operations.ts';
import { isReadOnlyOperation } from '../src/mcp/surface.ts';
import { CAPABILITIES_URI } from '../src/mcp/capabilities.ts';

const MARKER = 'readonly-marker-4768';
let home: string;
let env: Record<string, string>;

function cli(args: string[]) {
  return spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
}

async function session(args: string[]): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({ command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--direct', ...args], cwd: process.cwd(), env });
  const client = new Client({ name: 'gbrain-read-only-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}

const errorOf = (result: unknown): string | undefined => {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  if (!r.isError) return undefined;
  try { return (JSON.parse(r.content?.[0]?.text ?? '{}') as { error?: string }).error ?? 'error'; } catch { return 'error'; }
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-stdio-read-only-'));
  env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined });
  delete env.GBRAIN_SOURCE;
  expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive']).status).toBe(0);
  const notes = join(home, 'notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'marker.md'), `---\ntitle: ${MARKER} note\n---\n\n# ${MARKER}\n\nRead-only stdio fixture prose.\n`);
  expect(cli(['import', notes, '--no-embed']).status).toBe(0);
}, 120_000);

afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

test('the read-only predicate admits only non-mutating read operations of the live registry', () => {
  for (const op of operations) {
    if (op.scope !== 'read' || op.mutating === true || op.requiredScopes?.length) expect(isReadOnlyOperation(op)).toBe(false);
  }
  for (const name of ['put_page', 'delete_page', 'remember', 'capture', 'forget', 'request_tools', 'think', 'join_brain']) {
    expect(isReadOnlyOperation(operations.find(op => op.name === name)!)).toBe(false);
  }
  for (const name of ['search', 'get_page', 'query', 'recall']) expect(isReadOnlyOperation(operations.find(op => op.name === name)!)).toBe(true);
});

describe('serve --access read-only', () => {
  for (const surface of ['full', 'starter', 'verbs'] as const) {
    test(`${surface}: catalog, capabilities and dispatch agree and refuse every mutation`, async () => {
      const { client, close } = await session(['--surface', surface, '--access', 'read-only']);
      try {
        const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
        expect(listed.length).toBeGreaterThan(0);
        for (const name of listed) expect(isReadOnlyOperation(operations.find(op => op.name === name)!)).toBe(true);
        const resource = (await client.readResource({ uri: CAPABILITIES_URI })).contents[0] as { text: string };
        const capabilities = JSON.parse(resource.text) as { access: string; available_operations: string[] };
        expect(capabilities.access).toBe('read-only');
        expect([...capabilities.available_operations].sort()).toEqual(listed);

        for (const [name, args] of [
          ['put_page', { slug: 'notes/injected', content: '# Injected' }],
          ['delete_page', { slug: 'marker' }],
          ['remember', { fact: 'Injected fact', entity: 'marker' }],
          ['capture', { content: 'Injected capture' }],
          ['request_tools', { tools: ['put_page'] }],
        ] as const) {
          expect(errorOf(await client.callTool({ name, arguments: { ...args } }))).toBe('unknown_tool');
        }
        const read = surface === 'verbs' ? 'recall' : 'search';
        const result = await client.callTool({ name: read, arguments: read === 'recall' ? { query: MARKER } : { query: MARKER, limit: 5 } });
        expect(errorOf(result)).toBeUndefined();
      } finally { await close(); }
    }, 60_000);
  }

  test('nothing was written and the default access is unchanged', async () => {
    const { client, close } = await session([]);
    try {
      const names = new Set((await client.listTools()).tools.map(tool => tool.name));
      expect(names.has('put_page')).toBe(true);
      const page = await client.callTool({ name: 'get_page', arguments: { slug: 'notes/injected' } });
      expect(errorOf(page)).toBe('page_not_found');
      expect(errorOf(await client.callTool({ name: 'get_page', arguments: { slug: 'marker' } }))).toBeUndefined();
    } finally { await close(); }
  }, 60_000);

  test('--http --access read-only refuses with the per-token fix', () => {
    const refused = cli(['serve', '--http', '--access', 'read-only', '--port', '0']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('gbrain auth rescope-token <name> --operations');
  });
});
