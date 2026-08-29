/**
 * #3765 — `--repo` / the sync_brain `repo` param must anchor SOURCE resolution
 * at the repo dir, not the caller's cwd.
 *
 * Pre-fix: `gbrain sync --repo <dir>` parsed the path but resolved the source
 * from cwd, and the sync_brain op threaded only ctx.sourceId — so a repo
 * pointing at source B's checkout synced under the WRONG source (wrong
 * anchors, wrong page source_id, wrong `syncLockId(sourceId)` lock key).
 *
 * Coverage:
 *   1. resolveSourceForRepoPath unit: local_path tier, dotfile tier, null.
 *   2. sync_brain op: repo pointing at a registered source's checkout routes
 *      pages into THAT source; explicit source_id param wins; conflict with a
 *      non-default ctx.sourceId refuses with a structured OperationError.
 *   3. CLI runSync: --repo routes to the repo's source even when the ambient
 *      chain would have picked 'default'.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { resolveSourceForRepoPath } from '../src/core/source-resolver.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';

const SRC_A = 'vault-a-3765';
const SRC_B = 'vault-b-3765';

let engine: PGLiteEngine;
let repoA: string;
let repoB: string;
let unregistered: string;

function makeGitRepo(prefix: string, slugStem: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, 'topics'), { recursive: true });
  writeFileSync(join(dir, `topics/${slugStem}.md`), [
    '---',
    'type: concept',
    `title: ${slugStem}`,
    '---',
    '',
    `Body for ${slugStem}, long enough to import cleanly.`,
    '',
  ].join('\n'));
  execSync('git add -A && git commit -m seed', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function pagesIn(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [sourceId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repoA = makeGitRepo('gbrain-3765-a-', 'alpha-note');
  repoB = makeGitRepo('gbrain-3765-b-', 'beta-note');
  unregistered = makeGitRepo('gbrain-3765-u-', 'unreg-note');

  // TWO non-default sources so the sole_non_default convenience tier (5.5)
  // can never mask the repo-derived routing under test.
  await runSources(engine, ['add', SRC_A, '--path', repoA, '--no-federated']);
  await runSources(engine, ['add', SRC_B, '--path', repoB, '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const d of [repoA, repoB, unregistered]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
}, 60_000);

describe('#3765 resolveSourceForRepoPath (unit)', () => {
  test('registered local_path containing the dir resolves (longest prefix)', async () => {
    const hit = await resolveSourceForRepoPath(engine, repoA);
    expect(hit).not.toBeNull();
    expect(hit!.source_id).toBe(SRC_A);
    expect(hit!.tier).toBe('local_path');

    // A subdirectory of the checkout also resolves.
    const sub = await resolveSourceForRepoPath(engine, join(repoA, 'topics'));
    expect(sub?.source_id).toBe(SRC_A);
  });

  test('a .gbrain-source dotfile inside the repo dir wins over local_path', async () => {
    // Plant a pin for SRC_B inside repoA's tree — dotfile tier fires first.
    const pin = join(repoA, '.gbrain-source');
    writeFileSync(pin, `${SRC_B}\n`, { mode: 0o644 });
    try {
      const hit = await resolveSourceForRepoPath(engine, repoA);
      expect(hit?.source_id).toBe(SRC_B);
      expect(hit?.tier).toBe('dotfile');
    } finally {
      rmSync(pin, { force: true });
    }
  });

  test('an unregistered dir resolves to null (caller falls back to ambient)', async () => {
    const hit = await resolveSourceForRepoPath(engine, unregistered);
    expect(hit).toBeNull();
  });
});

describe('#3765 sync_brain op routes repo to its source', () => {
  const baseCtx = () =>
    ({
      engine,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
    }) as unknown as OperationContext;

  test('repo param pointing at SRC_B checkout lands pages in SRC_B, not default', async () => {
    const op = operationsByName['sync_brain']!;
    const before = await pagesIn('default');
    const result = await op.handler(baseCtx(), {
      repo: repoB,
      no_embed: true,
      no_pull: true,
      full: true,
    });
    expect(result).toBeDefined();
    expect(await pagesIn(SRC_B)).toBeGreaterThan(0);
    // Pre-fix: ctx.sourceId was undefined, so pages landed in 'default'.
    expect(await pagesIn('default')).toBe(before);
  }, 60_000);

  test('explicit source_id param wins over the repo-derived source', async () => {
    const op = operationsByName['sync_brain']!;
    // Dry run — routing decision is the thing under test; explicit source_id
    // must not be overridden by repo derivation (and must validate).
    const result = await op.handler(baseCtx(), {
      repo: repoB,
      source_id: SRC_A,
      dry_run: true,
      no_embed: true,
      no_pull: true,
    });
    expect(result).toBeDefined();
  }, 60_000);

  test('unknown explicit source_id refuses with invalid_params', async () => {
    const op = operationsByName['sync_brain']!;
    expect(
      op.handler(baseCtx(), { repo: repoB, source_id: 'no-such-source', dry_run: true }),
    ).rejects.toThrow(/not found|archived/i);
  });

  test('conflict: repo-derived source vs non-default ctx.sourceId refuses structurally', async () => {
    const op = operationsByName['sync_brain']!;
    const ctx = { ...baseCtx(), sourceId: SRC_A } as unknown as OperationContext;
    let err: unknown;
    try {
      await op.handler(ctx, { repo: repoB, dry_run: true, no_pull: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OperationError);
    const oe = err as OperationError;
    expect(oe.code).toBe('invalid_params');
    expect(oe.message).toContain(SRC_B);
    expect(oe.message).toContain(SRC_A);
  });

  test('no conflict when ctx.sourceId matches the repo-derived source', async () => {
    const op = operationsByName['sync_brain']!;
    const ctx = { ...baseCtx(), sourceId: SRC_B } as unknown as OperationContext;
    const result = await op.handler(ctx, {
      repo: repoB,
      dry_run: true,
      no_embed: true,
      no_pull: true,
    });
    expect(result).toBeDefined();
  }, 60_000);
});

describe('#3765 CLI runSync --repo routing', () => {
  test('--repo routes to the repo source when the ambient chain would pick default', async () => {
    const { runSync } = await import('../src/commands/sync.ts');

    const origExit = process.exit;
    process.exit = ((_code?: number) => {
      throw new Error('__exit__');
    }) as typeof process.exit;
    const before = await pagesIn('default');
    try {
      await runSync(engine, ['--full', '--no-embed', '--no-pull', '--repo', repoA]);
    } catch (e) {
      if ((e as Error).message !== '__exit__') throw e;
    } finally {
      process.exit = origExit;
    }

    // Two non-default sources exist, so tier 5.5 can't fire; pre-fix the cwd
    // chain fell through to 'default' and repoA's pages landed there.
    expect(await pagesIn(SRC_A)).toBeGreaterThan(0);
    expect(await pagesIn('default')).toBe(before);
  }, 60_000);
});
