/**
 * `--brain <id>` must actually route to the named mounted brain.
 *
 * The bug: docs/architecture/brains-and-sources.md promises
 * `gbrain query "X" --brain media-team` runs against the team's DB, and
 * src/core/brain-resolver.ts implements the full 6-tier chain — but nothing
 * ever CALLED the resolver from the CLI dispatch path. `--brain media-team`
 * was silently ignored (unknown flag) and the command ran against the HOST
 * brain, returning confident wrong answers. Same silent-wrong-target class
 * as #1712/#3524 on the source axis.
 *
 * These tests spawn the real CLI against a fake home with two distinct
 * PGLite brains (host + one mount), each seeded with a uniquely-slugged
 * page, and assert on WHICH brain's data comes back:
 *   - control: no flag → host page (default unchanged);
 *   - `--brain team-a` → the mount's page, not the host's;
 *   - `--brain nope` (unregistered) → hard error, NOT a silent host fallback;
 *   - `GBRAIN_BRAIN_ID=team-a` → the mount's page (env tier wired too).
 *
 * Pre-fix, the --brain/env spawns list the HOST page and the unknown-brain
 * spawn exits 0 — all three fail behaviorally on an unfixed tree.
 *
 * Serial because it spawns subprocesses + writes tmpdirs.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let home: string;
let mountsPath: string;

async function seedBrain(databasePath: string, slug: string): Promise<void> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  await engine.initSchema();
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `content of ${slug}`,
    frontmatter: {},
  });
  await engine.disconnect();
}

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    HOME: home,
    GBRAIN_HOME: home,
    GBRAIN_MOUNTS_PATH: mountsPath,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    // Neutralize ambient routing signals from the invoking shell/CI.
    GBRAIN_BRAIN_ID: '',
    GBRAIN_SOURCE: '',
    GBRAIN_DATABASE_URL: '',
    DATABASE_URL: '',
    ...extra,
  };
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 90_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-brain-flag-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'team-a-clone'), { recursive: true });

  const hostDb = join(home, '.gbrain', 'brain.pglite');
  const teamDb = join(home, 'team-a.pglite');

  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: hostDb, embedding_dimensions: 1536 }) + '\n',
  );
  mountsPath = join(home, '.gbrain', 'mounts.json');
  writeFileSync(
    mountsPath,
    JSON.stringify({
      version: 1,
      mounts: [
        {
          id: 'team-a',
          path: join(home, 'team-a-clone'),
          engine: 'pglite',
          database_path: teamDb,
          enabled: true,
        },
      ],
    }) + '\n',
  );

  // Two brains, two distinct pages. WHICH slug comes back tells us WHICH
  // database the CLI actually queried.
  await seedBrain(hostDb, 'host-page');
  await seedBrain(teamDb, 'team-page');
}, 240_000);

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('--brain routes the CLI to the named mounted brain', () => {
  test('control: no brain signal → host brain (default unchanged)', async () => {
    const r = await runCli(['list'], cliEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('host-page');
    expect(r.stdout).not.toContain('team-page');
  }, 120_000);

  test('--brain team-a → the mount database, not host', async () => {
    const r = await runCli(['list', '--brain', 'team-a'], cliEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('team-page');
    expect(r.stdout).not.toContain('host-page');
  }, 120_000);

  test('--brain <unknown> hard-errors — never a silent host fallback', async () => {
    const r = await runCli(['list', '--brain', 'nope'], cliEnv());
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Unknown brain/i);
    // The silent-wrong-results bug: pre-fix this listed the host's pages.
    expect(r.stdout).not.toContain('host-page');
  }, 120_000);

  test('GBRAIN_BRAIN_ID=team-a env tier is wired through the same seam', async () => {
    const r = await runCli(['list'], cliEnv({ GBRAIN_BRAIN_ID: 'team-a' }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('team-page');
    expect(r.stdout).not.toContain('host-page');
  }, 120_000);
});

// ── Trust boundary: brain selection is NEVER caller-controlled ────────────
//
// Brain routing happens at engine-connect time in the local CLI process
// (trusted, remote === false). An untrusted caller over MCP must have no way
// to name a brain: no op declares a brain param, and neither context builder
// reads one from params. Fail-closed pins for the new surface.

describe('untrusted callers cannot cross brains', () => {
  test('no operation exposes a brain/brain_id param an MCP caller could set', async () => {
    const { operations } = await import('../src/core/operations.ts');
    for (const op of operations) {
      expect(`${op.name}:${'brain' in op.params}`).toBe(`${op.name}:false`);
      expect(`${op.name}:${'brain_id' in op.params}`).toBe(`${op.name}:false`);
    }
  });

  test('makeContext ignores caller-supplied params.brain (stays on the connected engine)', async () => {
    const { makeContext } = await import('../src/cli.ts');
    const stub = {
      kind: 'pglite',
      executeRaw: async () => [],
      getConfig: async () => null,
    } as any;
    const ctx = await makeContext(stub, { brain: 'team-a', brain_id: 'team-a' });
    expect(ctx.engine).toBe(stub);
    // Local process default is the host brain; params must not move it.
    expect(ctx.brainId ?? 'host').toBe('host');
  });

  test('remote dispatch context never derives a brain from params (fail-closed)', async () => {
    const { buildOperationContext } = await import('../src/mcp/dispatch.ts');
    const stub = { kind: 'pglite' } as any;
    const ctx = buildOperationContext(stub, { brain: 'team-a', brain_id: 'team-a' }, {
      remote: true,
      sourceId: 'default',
    });
    expect(ctx.engine).toBe(stub);
    expect(ctx.brainId).toBeUndefined();
  });
});
