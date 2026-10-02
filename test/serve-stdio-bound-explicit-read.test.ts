/**
 * #5081 over the real stdio transport: `gbrain serve` started with
 * GBRAIN_SOURCE=work (the harness `.mcp.json` shape from the report) may name
 * a federated source in an explicit `source_id` read, gets only that source's
 * rows back, is refused a source that is not federated with the
 * bound-connection hint, and keeps unqualified reads on the bound source.
 *
 * PGLite, hermetic temp HOME; the MCP SDK spawns `gbrain serve` and performs
 * the same initialize handshake Claude Code does. The in-process matrix over
 * every affected read lives in test/explicit-read-admission-5081.test.ts.
 *
 * Lane: unit. Run: `bun test test/serve-stdio-bound-explicit-read.test.ts`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { cliDiagnostic } from './helpers/fixture-diagnostics.ts';

const MARKER = 'halcyon-bound-read-5081';

function execFixture(args: string[], env: Record<string, string>): void {
  const result = spawnSync('bun', ['--no-env-file', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(cliDiagnostic(args[2] ?? 'stdio fixture', {
    exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
  }));
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return Array.isArray(content) ? content.map((c) => c?.text ?? '').join('\n') : '';
}

function sourcesOf(text: string): string[] {
  const rows = JSON.parse(text) as Array<{ source_id?: string }>;
  return [...new Set(rows.map((row) => row.source_id ?? ''))].sort();
}

describe('#5081 — GBRAIN_SOURCE-bound stdio serve, explicit source_id reads', () => {
  let home: string;
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-stdio-5081-'));
    const env = keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined,
    });
    delete env.GBRAIN_SOURCE;
    execFixture(['run', 'src/cli.ts', 'init', '--pglite', '--no-embedding', '--non-interactive'], env);
    for (const [id, flag] of [['work', null], ['notes', '--federated'], ['private', null]] as const) {
      const dir = join(home, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}-page.md`),
        `---\ntitle: ${MARKER} in ${id}\n---\n\n# ${MARKER}\n\nThis ${MARKER} page lives in the ${id} source.\n`);
      execFixture(['run', 'src/cli.ts', 'sources', 'add', id, '--path', dir, ...(flag ? [flag] : []), '--force'], env);
      execFixture(['run', 'src/cli.ts', 'import', dir, '--no-embed', '--source-id', id], env);
    }

    transport = new StdioClientTransport({
      command: 'bun',
      args: ['--no-env-file', 'run', 'src/cli.ts', 'serve'],
      cwd: process.cwd(),
      env: { ...env, GBRAIN_SOURCE: 'work' },
    });
    client = new Client({ name: 'gbrain-stdio-5081', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    if (client) { try { await client.close(); } catch { /* best-effort */ } }
    if (transport) { try { await transport.close(); } catch { /* best-effort */ } }
    if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('search, query and get_page name a federated source and return only its rows', async () => {
    const search = await client!.callTool({ name: 'search', arguments: { query: MARKER, source_id: 'notes', limit: 10 } });
    expect(search.isError).toBeFalsy();
    expect(sourcesOf(textOf(search))).toEqual(['notes']);

    const query = await client!.callTool({ name: 'query', arguments: { query: MARKER, source_id: 'notes', expand: false, limit: 10 } });
    expect(query.isError).toBeFalsy();
    expect(sourcesOf(textOf(query))).toEqual(['notes']);

    const page = await client!.callTool({ name: 'get_page', arguments: { slug: 'notes-page', source_id: 'notes' } });
    expect(page.isError).toBeFalsy();
    expect(JSON.parse(textOf(page)).source_id).toBe('notes');
  }, 60_000);

  test('a source that is not federated is refused with the bound-connection hint', async () => {
    const res = await client!.callTool({ name: 'search', arguments: { query: MARKER, source_id: 'private' } });
    expect(res.isError).toBe(true);
    const body = JSON.parse(textOf(res));
    expect(body.error).toBe('permission_denied');
    expect(body.suggestion).toStartWith('This connection is bound to source work (GBRAIN_SOURCE). private ');
    expect(body.suggestion).toContain('`gbrain sources federate private` on the brain host, or start this connection without GBRAIN_SOURCE.');
  }, 60_000);

  test('unqualified reads stay on the bound source', async () => {
    const res = await client!.callTool({ name: 'search', arguments: { query: MARKER, limit: 10 } });
    expect(sourcesOf(textOf(res))).toEqual(['work']);
  }, 60_000);
});
