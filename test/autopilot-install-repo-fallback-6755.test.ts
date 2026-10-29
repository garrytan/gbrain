/**
 * #6755: `gbrain autopilot --install` with neither --repo nor sync.repo_path
 * falls back to the default source's local_path (a managed source keeps its
 * repo there), then refuses as before when that is unset too. Runs the
 * installer in-process on the ephemeral-container target against a stub
 * engine; process.exit is replaced for the refusal case and restored.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import { runAutopilot } from '../src/commands/autopilot.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

async function install(brain: { syncRepoPath?: string; defaultSourcePath?: string }, extra: string[] = []) {
  const gbrainHome = emptyHome();
  const home = mkdtempSync(join(tmpdir(), 'gbrain-ap-fallback-home-'));
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-ap-fallback-bin-'));
  writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const stderr: string[] = [];
  let exitCode: number | undefined;
  await withEnv({ GBRAIN_HOME: gbrainHome, HOME: home, PATH: `${bin}:${process.env.PATH}`, GBRAIN_NON_INTERACTIVE: '1' }, async () => {
    const log = console.log;
    const error = console.error;
    const exit = process.exit;
    console.log = () => {};
    console.error = (...p: unknown[]) => { stderr.push(p.map(String).join(' ')); };
    process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error('process.exit'); }) as typeof process.exit;
    _resetCliExitVerdictForTests();
    try {
      const engine = {
        kind: 'postgres',
        getConfig: async (key: string) => key === 'sync.repo_path' ? brain.syncRepoPath ?? null : null,
        executeRaw: async (sql: string) => /FROM sources WHERE id = 'default'/.test(sql) ? [{ local_path: brain.defaultSourcePath ?? null }] : [],
      } as never;
      await runAutopilot(engine, ['--install', '--target', 'ephemeral-container', '--no-inject', '--yes', ...extra]);
    } catch (e) {
      if (!(e instanceof Error && e.message === 'process.exit')) throw e;
    } finally {
      console.log = log;
      console.error = error;
      process.exit = exit;
    }
  });
  const wrapper = join(gbrainHome, '.gbrain', 'autopilot-run.sh');
  return { exitCode, stderr: stderr.join('\n'), wrapper: existsSync(wrapper) ? readFileSync(wrapper, 'utf8') : null };
}

afterAll(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('autopilot --install repo resolution (#6755)', () => {
  test('no --repo and no sync.repo_path: installs against the default source local_path', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-ap-fallback-repo-'));
    const r = await install({ defaultSourcePath: repo });
    expect(r.exitCode).toBeUndefined();
    expect(r.wrapper).toContain(`autopilot --repo '${repo}'`);
  });

  test('sync.repo_path still wins over the default source local_path', async () => {
    const configured = mkdtempSync(join(tmpdir(), 'gbrain-ap-fallback-configured-'));
    const r = await install({ syncRepoPath: configured, defaultSourcePath: '/elsewhere' });
    expect(r.wrapper).toContain(`autopilot --repo '${configured}'`);
    expect(r.wrapper).not.toContain('/elsewhere');
  });

  test('--repo wins over both', async () => {
    const flag = mkdtempSync(join(tmpdir(), 'gbrain-ap-fallback-flag-'));
    const r = await install({ syncRepoPath: '/configured', defaultSourcePath: '/elsewhere' }, ['--repo', flag]);
    expect(r.wrapper).toContain(`autopilot --repo '${flag}'`);
  });

  // /ship coverage audit (GBRA-207, #7630).
  // Value: protects=a relative sync.repo_path is skipped, not fatal: install falls through to an absolute default local_path, and refuses when both are relative;
  //   fails_when=installRepoFallback returns null on a relative sync.repo_path without consulting local_path, or bakes "." into the wrapper;
  //   why_new=sync-relative-anchor-refusal-7630 asserts only the all-relative null, never the fall-through to an absolute local_path; seam=none;
  //   no_claim=a real supervisor install (ephemeral-container target, stub engine)
  test('#7630: a relative sync.repo_path falls through to an absolute default local_path; relative everywhere refuses', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-ap-fallback-relative-'));
    const fellThrough = await install({ syncRepoPath: '.', defaultSourcePath: repo });
    expect(fellThrough.exitCode).toBeUndefined();
    expect(fellThrough.wrapper).toContain(`autopilot --repo '${repo}'`);
    expect(fellThrough.wrapper).not.toContain("autopilot --repo '.'");
    const refused = await install({ syncRepoPath: '.', defaultSourcePath: 'notes' });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('No repo path');
    expect(refused.stderr).toContain('unset or relative');
    expect(refused.wrapper).toBeNull();
  });

  test('no path anywhere: refuses with exit 1 and writes nothing', async () => {
    const r = await install({});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No repo path');
    expect(r.wrapper).toBeNull();
  });
});
