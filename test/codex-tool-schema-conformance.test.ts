// I1: Codex registers `serve --surface full`, so every tool full lists reaches Codex's tool loader,
// which hands each one to the model as a function. A name outside ^[a-zA-Z0-9_-]{1,64}$, a duplicate,
// or an input schema that is not a plain object with typed properties makes Codex drop the tool or the
// whole server. This pins those rules for both schema modes the server can emit.
import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

type Schema = Record<string, unknown>;

function schemaProblems(schema: Schema, at: string): string[] {
  const out: string[] = [];
  if ('$ref' in schema) out.push(`${at}: $ref`);
  const type = schema.type;
  if (type === undefined && !('enum' in schema) && !('anyOf' in schema) && !('oneOf' in schema)) out.push(`${at}: no type`);
  if (type === 'array') {
    if (!schema.items || typeof schema.items !== 'object') out.push(`${at}: array without items`);
    else out.push(...schemaProblems(schema.items as Schema, `${at}[]`));
  }
  if (type === 'object' && schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties as Record<string, Schema>)) out.push(...schemaProblems(sub, `${at}.${key}`));
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key])) (schema[key] as Schema[]).forEach((sub, i) => out.push(...schemaProblems(sub, `${at}|${key}${i}`)));
  }
  if (Array.isArray(schema.required)) {
    const props = Object.keys((schema.properties ?? {}) as Schema);
    for (const r of schema.required as string[]) if (!props.includes(r)) out.push(`${at}: required ${r} is not a property`);
  }
  return out;
}

describe('I1: every tool the full surface lists loads in Codex', () => {
  for (const strictParams of [false, true]) {
    test(`names and input schemas (strictParams ${strictParams})`, () => {
      const defs = buildToolDefs(filterOpsForSurface(operations, 'full'), { strictParams });
      expect(defs.length).toBeGreaterThan(150);
      const names = defs.map(d => d.name);
      expect(names.filter(n => !/^[a-zA-Z0-9_-]{1,64}$/.test(n))).toEqual([]);
      expect(names.length).toBe(new Set(names).size);
      const problems: string[] = [];
      for (const def of defs) {
        const schema = def.inputSchema as unknown as Schema;
        if (schema.type !== 'object') problems.push(`${def.name}: root type ${String(schema.type)}`);
        for (const key of ['oneOf', 'anyOf', 'allOf', 'not', 'enum']) if (key in schema) problems.push(`${def.name}: root ${key}`);
        if (typeof schema.properties !== 'object' || schema.properties === null) problems.push(`${def.name}: no properties object`);
        problems.push(...schemaProblems(schema, def.name));
        if (typeof def.description !== 'string' || def.description.length === 0) problems.push(`${def.name}: no description`);
      }
      expect(problems).toEqual([]);
    });
  }
});

describe('I1: a fresh Codex registration lists the full surface and runs a read starter hid', () => {
  test('serve with the exact args setup codex writes: tools/list passes the same checks and get_chunks answers', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { keylessBrainEnv } = await import('./helpers/provider-env.ts');
    const { registrationProfile, stdioServeArgv } = await import('../src/core/mcp-registration.ts');
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-codex-full-'));
    const env = keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined,
      GBRAIN_NON_INTERACTIVE: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', NO_COLOR: '1',
    });
    try {
      const init = Bun.spawn([process.execPath, '--no-env-file', cli, 'init', '--pglite', '--no-embedding'], { cwd: home, env, stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe' });
      expect(await init.exited).toBe(0);
      const profile = registrationProfile('codex');
      const [, ...serveArgs] = stdioServeArgv('gbrain', profile.surface, profile.advertise);
      expect(serveArgs).toEqual(['serve', '--surface', 'full']);
      const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', cli, ...serveArgs], env, cwd: home, stderr: 'pipe' });
      const client = new Client({ name: 'codex-conformance', version: '1' }, { capabilities: {} });
      await client.connect(transport);
      try {
        const listed = (await client.listTools()).tools;
        const starter = new Set(filterOpsForSurface(operations, 'starter').map(o => o.name));
        expect(listed.length).toBeGreaterThan(starter.size * 3);
        expect(listed.map(t => t.name).filter(n => !/^[a-zA-Z0-9_-]{1,64}$/.test(n))).toEqual([]);
        expect(listed.length).toBe(new Set(listed.map(t => t.name)).size);
        expect(listed.flatMap(t => [...(t.inputSchema.type === 'object' ? [] : [`${t.name}: root type`]), ...schemaProblems(t.inputSchema as Schema, t.name)])).toEqual([]);
        expect(starter.has('get_chunks')).toBe(false);
        expect(listed.map(t => t.name)).toContain('get_chunks');
        const put = await client.callTool({ name: 'put_page', arguments: { slug: 'notes/codex-check', content: '---\ntype: note\ntitle: Codex check\n---\n# Codex check\n\nconformancecanary' } });
        expect(put.isError ?? false).toBe(false);
        const chunks = await client.callTool({ name: 'get_chunks', arguments: { slug: 'notes/codex-check' } });
        expect(chunks.isError ?? false).toBe(false);
        expect(JSON.stringify(chunks.content)).toContain('conformancecanary');
      } finally { await client.close().catch(() => {}); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 180_000);
});
