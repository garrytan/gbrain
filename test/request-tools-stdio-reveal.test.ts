/**
 * request_tools {tools} on a stdio session must not claim a tool is listed and
 * callable when it is outside the session's surface.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';

let home: string;
let env: Record<string, string>;

const parsed = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0]).text) as Record<string, unknown>;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-request-tools-reveal-'));
  env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SURFACE: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined, GBRAIN_NO_ONBOARD_NUDGE: '1' });
  delete env.GBRAIN_SOURCE;
  const init = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', 'init', '--pglite', '--no-embedding', '--non-interactive'], { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(init.status).toBe(0);
}, 120_000);

afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe('request_tools {tools} on a starter stdio session', () => {
  test('a tool outside the surface is not reported as listed', async () => {
    const transport = new StdioClientTransport({
      command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--surface', 'starter'], cwd: process.cwd(), env, stderr: 'pipe',
    });
    const client = new Client({ name: 'gbrain-request-tools-reveal-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const reply = parsed(await client.callTool({ name: 'request_tools', arguments: { tools: ['get_brain_identity'] } }));
      const after = (await client.listTools()).tools.map(t => t.name);
      expect(after).not.toContain('get_brain_identity');
      expect(reply.listed).toBeUndefined();
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 90_000);
});
