/**
 * #7599: a read-only stdio serve skips the resident write duties on Postgres. On PGLite the serve holds the brain's only
 * engine handle, so the CLI's reads and writes go through its persistence owner socket; a read-only PGLite serve that
 * skipped them left every CLI command with "The local persistence owner is unavailable". It keeps them.
 *
 * Drives the real CLI subprocess beside a real `gbrain serve --access read-only` holding the PGLite brain.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const baseEnv = { GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_UPDATE_CHECK: '0', GBRAIN_SWEEP: '0', GBRAIN_NON_INTERACTIVE: '1',
  GBRAIN_NO_BANNER: '1', NO_COLOR: '1', NODE_ENV: 'test', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined };

let home: string;

const gbrain = (args: string[]) => runCli(args, { home, cwd: home, env: baseEnv, timeoutMs: 90_000 });
const ok = (result: CliResult) => {
  expect({ exit: result.exitCode, failure: result.exitCode ? result.stdout + result.stderr : '' }).toEqual({ exit: 0, failure: '' });
  return JSON.parse(result.stdout) as Record<string, any>;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-ro-pglite-7599-'));
  ok(await gbrain(['init', '--pglite', '--no-embedding', '--non-interactive', '--json']));
}, 120_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test('a read-only stdio serve holding a PGLite brain still serves the CLI\'s writes and reads', async () => {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_UPDATE_CHECK: '0', GBRAIN_SWEEP: '0', NODE_ENV: 'test' };
  const client = new Client({ name: 'ro-pglite-7599', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve', '--access', 'read-only'], cwd: home, env, stderr: 'pipe' });
  try {
    await client.connect(transport, { signal: AbortSignal.timeout(30_000) });
    const captured = ok(await gbrain(['capture', 'Captured beside a read-only serve.', '--slug', 'inbox/read-only-example-7599', '--json']));
    expect(captured).toMatchObject({ slug: 'inbox/read-only-example-7599' });
    const page = ok(await gbrain(['get', 'inbox/read-only-example-7599', '--json']));
    expect(page).toMatchObject({ slug: 'inbox/read-only-example-7599' });
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}, 180_000);
