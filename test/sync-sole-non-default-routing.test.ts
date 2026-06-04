/**
 * v0.41.13 (#1434) — performSync without --source auto-routes to the only
 * registered non-default source AND prints the nudge.
 *
 * Codex review of the original plan caught the load-bearing gap: adding the
 * `sole_non_default` tier to source-resolver.ts is dead code unless
 * `runSync` actually calls the resolver in the no-explicit-source case.
 * Pre-fix at commands/sync.ts:1500-1505, the resolver was skipped when
 * neither --source nor GBRAIN_SOURCE was set, leaving sourceId undefined.
 *
 * This test proves the wiring works end-to-end on PGLite: register one
 * non-default source, call performSync with no source arg, assert pages
 * land in that source (NOT 'default') AND the nudge appears on stderr.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

async function pageCountBySource(): Promise<Record<string, number>> {
  const rows = await engine.executeRaw<{ source_id: string; n: number }>(
    `SELECT source_id, COUNT(*)::int AS n FROM pages GROUP BY source_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source_id] = r.n;
  return out;
}

describe('#1434 — runSync auto-routes to sole_non_default source', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-snd-routing-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/foo.md'), [
      '---',
      'type: concept',
      'title: Foo',
      '---',
      '',
      'baseline.',
    ].join('\n'));
    execSync('git add -A && git commit -m initial', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('sole non-default source: performSync without --source routes there', async () => {
    // local_path is required for tier 5.5 to fire — point at the synthetic
    // git repo so resolveSourceWithTier sees one non-default source with
    // a local_path AND falls through brain_default (unset).
    await runSources(engine, ['add', 'studiovault', '--path', repoPath, '--no-federated']);
    const { runSync } = await import('../src/commands/sync.ts');

    // Capture stderr to verify the nudge fires.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as unknown as { write: typeof origWrite }).write = (
      chunk: unknown,
      ...rest: unknown[]
    ): boolean => {
      const s = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString() : String(chunk);
      captured.push(s);
      return origWrite(chunk as Parameters<typeof origWrite>[0], ...(rest as []));
    };

    try {
      // runSync takes (engine, args). With no --source it relies on the
      // resolver to pick sole_non_default. --full to bypass git-diff
      // bookmarking. --no-embed since we have no embedding provider.
      // --repo points at the synthetic vault.
      // Note: runSync calls process.exit on some paths — guard accordingly.
      const origExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('__exit__');
      }) as typeof process.exit;

      try {
        await runSync(engine, ['--full', '--no-embed', '--repo', repoPath]);
      } catch (e) {
        if ((e as Error).message !== '__exit__') throw e;
      } finally {
        process.exit = origExit;
      }
      // Exit code 0 (success) or undefined (no exit called) both fine
      expect(exitCode === undefined || exitCode === 0).toBe(true);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }

    // IRON RULE: pages landed in studiovault, NOT in default.
    const counts = await pageCountBySource();
    expect(counts['studiovault']).toBeGreaterThan(0);
    expect(counts['default'] ?? 0).toBe(0);

    // The nudge appears on stderr.
    const stderrText = captured.join('');
    expect(stderrText).toContain("routing to source 'studiovault'");
    expect(stderrText).toContain('sole non-default source registered');
  }, 60_000);

  test('explicit --source overrides auto-routing (no nudge)', async () => {
    await runSources(engine, ['add', 'studiovault', '--path', repoPath, '--no-federated']);
    const { runSync } = await import('../src/commands/sync.ts');

    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as unknown as { write: typeof origWrite }).write = (
      chunk: unknown,
      ...rest: unknown[]
    ): boolean => {
      const s = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString() : String(chunk);
      captured.push(s);
      return origWrite(chunk as Parameters<typeof origWrite>[0], ...(rest as []));
    };

    try {
      const origExit = process.exit;
      process.exit = ((_code?: number) => { throw new Error('__exit__'); }) as typeof process.exit;
      try {
        await runSync(engine, ['--full', '--no-embed', '--repo', repoPath, '--source', 'default']);
      } catch (e) {
        if ((e as Error).message !== '__exit__') throw e;
      } finally {
        process.exit = origExit;
      }
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }

    // No nudge — user picked explicitly.
    const stderrText = captured.join('');
    expect(stderrText).not.toContain('sole non-default source registered');

    // Pages went to 'default' as requested.
    const counts = await pageCountBySource();
    expect(counts['default']).toBeGreaterThan(0);
  }, 60_000);

  test('2+ non-default sources: no auto-route, no nudge, falls through to default', async () => {
    // Both need local_path to be counted by the sole_non_default helper.
    // Pre-existing helper filters local_path IS NOT NULL.
    const secondRepo = mkdtempSync(join(tmpdir(), 'gbrain-snd-routing-second-'));
    await runSources(engine, ['add', 'studiovault', '--path', repoPath, '--no-federated']);
    await runSources(engine, ['add', 'second-vault', '--path', secondRepo, '--no-federated']);
    const { runSync } = await import('../src/commands/sync.ts');

    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as unknown as { write: typeof origWrite }).write = (
      chunk: unknown,
      ...rest: unknown[]
    ): boolean => {
      const s = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString() : String(chunk);
      captured.push(s);
      return origWrite(chunk as Parameters<typeof origWrite>[0], ...(rest as []));
    };

    try {
      const origExit = process.exit;
      process.exit = ((_code?: number) => { throw new Error('__exit__'); }) as typeof process.exit;
      try {
        await runSync(engine, ['--full', '--no-embed', '--repo', repoPath]);
      } catch (e) {
        if ((e as Error).message !== '__exit__') throw e;
      } finally {
        process.exit = origExit;
      }
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }

    const stderrText = captured.join('');
    expect(stderrText).not.toContain('sole non-default source registered');

    // Multi-source brains fall through to seed_default — same as pre-fix.
    const counts = await pageCountBySource();
    expect(counts['default'] ?? 0).toBeGreaterThan(0);
    expect(counts['studiovault'] ?? 0).toBe(0);
    expect(counts['second-vault'] ?? 0).toBe(0);
  }, 60_000);
});
