/**
 * E2E — `whoami` over the REAL stdio MCP transport.
 *
 * Codifies the manual probe from the fix/whoami-stdio-transport work
 * (garrytan/gbrain#1625). It spins up `gbrain serve` as an actual subprocess,
 * drives it through the MCP SDK client over stdio (initialize handshake +
 * tools/call), and asserts `whoami` returns the `{transport:'stdio', scopes:[]}`
 * shape — NOT the `unknown_transport` throw the bug produced.
 *
 * This is the process/transport-level belt-and-suspenders that the unit tests
 * (test/whoami.test.ts) and dispatcher tests can't give: it proves
 * src/mcp/server.ts actually threads `transport: 'stdio'` end to end, through
 * the real MCP SDK and a separate OS process.
 *
 * Hermetic: fresh PGLite brain in a temp GBRAIN_HOME, no DATABASE_URL, no API
 * keys. Delegates to `bun run src/cli.ts` because bun --compile can't bundle
 * PGLite assets (same constraint as pglite-cli-exit.serial.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const BUN = process.execPath; // the bun running this test — no PATH dependency

let tmpHome: string;
let repoSourceDir: string;
let runEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-whoami-stdio-'));
  repoSourceDir = mkdtempSync(join(tmpdir(), 'gbrain-whoami-stdio-src-'));

  // Minimal git repo so `init --repo` has a HEAD to anchor against. whoami
  // needs no pages, so we skip `sync`.
  writeFileSync(join(repoSourceDir, 'seed.md'), '---\ntitle: Seed\n---\nhello\n', 'utf-8');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoSourceDir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoSourceDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoSourceDir });
  spawnSync('git', ['add', '-A'], { cwd: repoSourceDir });
  spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoSourceDir });

  // Strip embedding-provider keys so init doesn't refuse on the multi-provider
  // ambiguity check — whoami is keyword/no-embed only.
  runEnv = { ...process.env, GBRAIN_HOME: tmpHome };
  delete runEnv.VOYAGE_API_KEY;
  delete runEnv.ZEROENTROPY_API_KEY;
  delete runEnv.OPENAI_API_KEY;
  delete runEnv.ANTHROPIC_API_KEY;
  delete runEnv.GOOGLE_API_KEY;

  const init = spawnSync(
    BUN,
    ['run', CLI, 'init', '--pglite', '--repo', repoSourceDir, '--no-embedding', '--yes'],
    { cwd: REPO_ROOT, env: runEnv, encoding: 'utf-8', timeout: 120_000 },
  );
  if (init.status !== 0) {
    throw new Error(
      `gbrain init failed (code=${init.status}):\nSTDOUT:\n${init.stdout}\nSTDERR:\n${init.stderr}`,
    );
  }
}, 180_000);

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repoSourceDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('E2E: whoami over real stdio MCP transport', () => {
  test('tools/call whoami returns {transport:"stdio", scopes:[]} (not unknown_transport)', async () => {
    // Child env: only defined string values; MCP_STDIO=1 so server.ts doesn't
    // self-shutdown on stdin lifecycle (the SDK client owns the process and
    // terminates it in finally).
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(runEnv)) if (typeof v === 'string') childEnv[k] = v;
    childEnv.MCP_STDIO = '1';

    const transport = new StdioClientTransport({
      command: BUN,
      args: ['run', CLI, 'serve'],
      cwd: REPO_ROOT,
      env: childEnv,
      stderr: 'ignore', // server logs go to stderr; keep them out of test output
    });
    const client = new Client({ name: 'whoami-stdio-e2e', version: '0.0.0' }, { capabilities: {} });

    try {
      await client.connect(transport); // spawns the process + initialize handshake
      const res: any = await client.callTool({ name: 'whoami', arguments: {} });

      expect(res.isError).toBeFalsy();
      const text = res?.content?.[0]?.text;
      expect(typeof text).toBe('string');
      const body = JSON.parse(text);

      expect(body.transport).toBe('stdio');
      expect(body.scopes).toEqual([]);
      // Regression guard: the bug returned this error code instead of a shape.
      expect(body.error).toBeUndefined();
    } finally {
      await client.close().catch(() => {});
    }
  }, 120_000);
});
