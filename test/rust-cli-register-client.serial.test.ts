/**
 * `gbrain auth register-client` through the real CLI entry on a Rust-engine brain, against the same command on a
 * PGLite brain.
 *
 * Each brain is a fresh directory whose config names the engine (`engine: 'rust'` or `engine: 'pglite'`). The
 * command runs in a child process (`src/cli.ts`), so the whole command path runs: argv parsing, the binding and scope
 * checks, the registration core, the token-ttl write, the shared-exposure notice and the printed block. Then
 * `auth clients --json` reads the stored client back. Client ids, secrets and clock stamps are masked; everything
 * else must be the same on both brains.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: an operator can register an OAuth client from the CLI on a Rust brain, and the stored client is the
 *    one PGLite stores.
 * 2. Fails when: any step of the command reaches raw SQL on the Rust engine (the typed `engine_capability_missing`
 *    refusal, exit 1), or the Rust brain prints or stores a different client.
 * 3. Existing coverage: test/engine-parity/oauth-clients.test.ts runs the registration core in process;
 *    test/engine-parity/admin-unowned-http.test.ts runs the HTTP route. Neither runs the CLI command itself.
 * 4. Seams: none. It needs the addon `bun run rust:build` writes and skips without it
 *    (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

type Backend = 'pglite' | 'rust';
interface Brain { backend: Backend; home: string }
interface Run { exitCode: number; stdout: string; stderr: string }

let root = '';
const brains = {} as Record<Backend, Brain>;

function childEnv(brain: Brain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key];
  }
  return {
    ...out,
    HOME: brain.home,
    GBRAIN_HOME: brain.home,
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0',
    TZ: 'UTC',
    ...(brain.backend === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(brain: Brain, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function makeBrain(backend: Backend): Brain {
  const home = join(root, backend, 'home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, database_path: join(root, backend, 'db') }));
  return { backend, home };
}

/** What two runs cannot share: the generated client id and secret, and clock stamps. */
const mask = (text: string) => text
  .replace(/gbrain_cl_[0-9a-f]{64}/g, '<client_id>')
  .replace(/gbrain_cs_[0-9a-f]{64}/g, '<client_secret>')
  .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<timestamp>');

const REGISTRATIONS: string[][] = [
  ['auth', 'register-client', 'cli-plain', '--grant-types', 'client_credentials', '--scopes', 'read'],
  ['auth', 'register-client', 'cli-scoped', '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', 'default', '--token-ttl', '7200'],
];

describe.skipIf(!HAVE_ADDON)('auth register-client on a Rust brain registers the client PGLite registers', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-rust-cli-register-'));
    brains.pglite = makeBrain('pglite');
    brains.rust = makeBrain('rust');
    // A PGLite brain needs its schema first; the Rust store creates its own when it opens.
    const init = await cli(brains.pglite, ['init', '--pglite', '--no-embedding', '--path', join(root, 'pglite', 'db'), '--json']);
    if (init.exitCode !== 0) throw new Error(`PGLite init failed (${init.exitCode}): ${init.stdout}\n${init.stderr}`);
  }, 300_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  for (const args of REGISTRATIONS) {
    test(args.slice(1).join(' '), async () => {
      const [pg, rust] = await Promise.all([cli(brains.pglite, args), cli(brains.rust, args)]);
      expect({ exitCode: pg.exitCode, registered: /OAuth client registered/.test(pg.stdout) }).toEqual({ exitCode: 0, registered: true });
      // A raw-SQL step on the Rust engine ends in the typed refusal on stderr and exit 1; the stderr is shown on failure.
      expect({ exitCode: rust.exitCode, stdout: mask(rust.stdout), stderr: rust.exitCode === 0 ? '' : rust.stderr })
        .toEqual({ exitCode: 0, stdout: mask(pg.stdout), stderr: '' });
    }, 120_000);
  }

  test('auth clients --json reads the same clients back', async () => {
    const [pg, rust] = await Promise.all([cli(brains.pglite, ['auth', 'clients', '--json']), cli(brains.rust, ['auth', 'clients', '--json'])]);
    expect(pg.exitCode).toBe(0);
    expect(['cli-plain', 'cli-scoped'].every((name) => pg.stdout.includes(`"${name}"`))).toBe(true);
    expect({ exitCode: rust.exitCode, json: JSON.parse(mask(rust.stdout) || 'null') })
      .toEqual({ exitCode: 0, json: JSON.parse(mask(pg.stdout)) });
  }, 120_000);
});
