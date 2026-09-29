/**
 * `gbrain sources harden --all` (#5182): a source that cannot be hardened is
 * reported and skipped over — it never aborts the run or hides the aggregate —
 * and any source needing attention sets the non-zero exit verdict.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runHarden } from '../src/commands/sources-harden.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { backupStatusPath } from '../src/core/backup/status-file.ts';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

const MANAGED_KEY = 'gbrain.durability.managed';
let base: string;
let out: string[];
let err: string[];
const readOnlyGitDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }).trim();
}
function cfg(work: string, key: string): string { try { return git(work, 'config', '--local', '--get', key); } catch { return ''; } }
function makeRepo(name: string): string {
  const bare = join(base, `${name}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const work = join(base, name);
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t'); git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
  return work;
}
function engineFor(rows: Array<{ id: string; local_path: string | null }>): BrainEngine {
  return { executeRaw: async () => rows.map(row => ({ ...row, config: {} })) } as unknown as BrainEngine;
}
async function run(rows: Array<{ id: string; local_path: string | null }>, ...args: string[]) {
  await withEnv({ HOME: base, GBRAIN_HOME: base, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_GITHUB_PAT: undefined },
    () => runHarden(engineFor(rows), ['--all', '--no-cron', '--no-verify', ...args]));
}
const jsonOut = () => JSON.parse(out.filter(line => line.trim().startsWith('{')).join('\n')) as {
  reports: Array<{ source_id: string; managed?: boolean; steps: Array<{ step: string; status: string }> }>;
  errors?: Array<{ source_id: string; code?: string; message: string; suggestion?: string }>;
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gbrain-harden-cli-'));
  out = []; err = [];
  spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.join(' ')); });
  spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { err.push(parts.join(' ')); });
  _resetCliExitVerdictForTests(); process.exitCode = 0;
});
afterEach(() => {
  for (const dir of readOnlyGitDirs.splice(0)) chmodSync(dir, 0o755);
  (console.log as unknown as { mockRestore(): void }).mockRestore();
  (console.error as unknown as { mockRestore(): void }).mockRestore();
  _resetCliExitVerdictForTests(); process.exitCode = 0;
  rmSync(base, { recursive: true, force: true });
});

describe('sources harden --all (#5182)', () => {
  test('hardens managed git, unmanaged git and skips a managed non-git source without aborting', async () => {
    const managed = makeRepo('managed-example');
    const plain = makeRepo('plain-example');
    const nonGit = join(base, 'non-git-example'); mkdirSync(nonGit);
    await withEnv({ GBRAIN_HOME: base }, async () => {
      recordManagedRoots(randomUUID(), [{ local_path: managed }, { local_path: nonGit }]);
      mkdirSync(dirname(backupStatusPath()), { recursive: true });
      writeFileSync(backupStatusPath(), '{}'); // cached verdict must be invalidated
    });
    await run([{ id: 'managed-example', local_path: managed }, { id: 'non-git-example', local_path: nonGit },
      { id: 'plain-example', local_path: plain }], '--json');

    const result = jsonOut();
    expect(result.reports.map(r => r.source_id)).toEqual(['managed-example', 'plain-example']);
    expect(result.reports[0].managed).toBe(true);
    expect(result.reports[0].steps.map(s => s.step)).toContain('outbox');
    expect(result.reports[1].steps.map(s => s.step)).not.toContain('outbox');
    expect(result.errors).toBeUndefined();
    expect(err.join('\n')).toContain('[non-git-example] skipped');
    expect(cfg(managed, MANAGED_KEY)).toBe('true');
    expect(cfg(plain, MANAGED_KEY)).toBe('');
    expect(existsSync(join(managed, 'scripts'))).toBe(false);
    expect(existsSync(join(plain, 'scripts', 'brain-commit-push.sh'))).toBe(true);
    expect(currentExitCode()).toBe(0);
    await withEnv({ GBRAIN_HOME: base }, async () => { expect(existsSync(backupStatusPath())).toBe(false); });
  });

  test('a source that fails is reported with its error code and fix hint while the others still complete', async () => {
    const first = makeRepo('first-example');
    const broken = makeRepo('broken-example');
    const last = makeRepo('last-example');
    await withEnv({ GBRAIN_HOME: base }, async () => { recordManagedRoots(randomUUID(), [{ local_path: broken }]); });
    const pat = join(base, 'pat.txt'); writeFileSync(pat, 'ghp_TESTSECRETTOKEN0123456789abcdef\n', { mode: 0o600 });
    // A read-only git directory makes the repo-local credential wiring fail for this source only.
    chmodSync(join(broken, '.git'), 0o555); readOnlyGitDirs.push(join(broken, '.git'));
    await run([{ id: 'first-example', local_path: first }, { id: 'broken-example', local_path: broken },
      { id: 'last-example', local_path: last }], '--json', '--pat-file', pat);

    const result = jsonOut();
    expect(result.reports.map(r => r.source_id)).toEqual(['first-example', 'last-example']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toMatchObject({ source_id: 'broken-example' });
    expect(result.errors![0].message.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('ghp_TESTSECRETTOKEN');
    expect(cfg(first, 'gbrain.durability.managedcredential')).toBe('true');
    expect(cfg(last, 'gbrain.durability.managedcredential')).toBe('true');
    expect(currentExitCode()).toBe(3);
  });

  test('predicate failures surface the error code and Fix hint for every affected source and exit non-zero', async () => {
    const a = makeRepo('alpha-example');
    const b = makeRepo('beta-example');
    const registry = join(base, '.gbrain', 'persistence', 'managed-roots');
    mkdirSync(registry, { recursive: true }); writeFileSync(join(registry, 'broken.json'), '{');
    await run([{ id: 'alpha-example', local_path: a }, { id: 'beta-example', local_path: b }]);

    const text = err.join('\n');
    for (const id of ['alpha-example', 'beta-example']) expect(text).toContain(`[${id}]`);
    expect(text).toContain('writer_coordinator_required');
    expect(text).toContain('Fix:');
    expect(text).toContain('Repair the local persistence registry');
    expect(cfg(a, MANAGED_KEY)).toBe('');
    expect(cfg(b, MANAGED_KEY)).toBe('');
    expect(currentExitCode()).toBe(3);
  });

  test('--json reports the structured error entries for predicate failures', async () => {
    const a = makeRepo('gamma-example');
    const registry = join(base, '.gbrain', 'persistence', 'managed-roots');
    mkdirSync(registry, { recursive: true }); writeFileSync(join(registry, 'broken.json'), '{');
    await run([{ id: 'gamma-example', local_path: a }], '--json');
    const result = jsonOut();
    expect(result.reports).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ source_id: 'gamma-example', code: 'writer_coordinator_required',
      suggestion: expect.stringContaining('Repair the local persistence registry') })]);
    expect(currentExitCode()).toBe(3);
  });

  test('a clean run keeps the legacy exit verdict and JSON shape (no errors key)', async () => {
    const plain = makeRepo('delta-example');
    await run([{ id: 'delta-example', local_path: plain }], '--json');
    const result = jsonOut();
    expect(Object.keys(result)).toEqual(['reports']);
    expect(currentExitCode()).toBe(0);
  });
});
