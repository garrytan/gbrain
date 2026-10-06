/**
 * #5063: `git_convergence` compares each source checkout (and sync.repo_path)
 * with its last fetched upstream: commits not pushed warn past 6 hours and fail
 * past 24; stale uncommitted changes warn; roots without an upstream are skipped.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-convergence-'));
const HOUR = 3_600_000;

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).toString().trim();
}
function checkout(name: string): string {
  const bare = join(dir, `${name}.git`), work = join(dir, name);
  git(dir, ['init', '-q', '--bare', bare]);
  git(dir, ['clone', '-q', bare, work]);
  git(work, ['config', 'user.email', 'example@example.invalid']);
  git(work, ['config', 'user.name', 'Example']);
  writeFileSync(join(work, 'note.md'), 'first\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'first']); git(work, ['push', '-q', 'origin', 'HEAD']);
  git(work, ['branch', '--set-upstream-to', `origin/${git(work, ['branch', '--show-current'])}`]);
  return work;
}
function commitAt(work: string, file: string, ageMs: number) {
  writeFileSync(join(work, file), `${file}\n`);
  git(work, ['add', '-A']);
  const date = new Date(Date.now() - ageMs).toISOString();
  git(work, ['commit', '-q', '-m', file], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test('git_convergence is registered and categorized', () => {
  expect(DOCTOR_CHECK_REGISTRY.some(entry => entry.emits.includes('git_convergence'))).toBe(true);
  expect(categorizeCheck('git_convergence')).toBe('brain');
});

test('converged, ahead (6-24h warn, >24h fail), dirty and upstream-less checkouts', async () => {
  const synced = checkout('synced'), recent = checkout('recent'), old = checkout('old'), dirty = checkout('dirty');
  const noUpstream = join(dir, 'plain'); git(dir, ['init', '-q', noUpstream]);
  for (const [id, path] of [['synced', synced], ['recent', recent], ['old', old], ['dirty', dirty], ['plain', noUpstream]]) {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, path]);
  }
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('mail','mail',$1,'{\"kind\":\"google\"}'::jsonb)", [old]);

  let check = await gitConvergenceCheck(engine);
  expect(check?.status).toBe('ok');

  commitAt(recent, 'recent.md', 8 * HOUR);
  writeFileSync(join(dirty, 'draft.md'), 'work in progress\n');
  const stale = (Date.now() - 10 * HOUR) / 1000; utimesSync(join(dirty, 'draft.md'), stale, stale);
  check = await gitConvergenceCheck(engine);
  expect(check?.status).toBe('warn');
  expect(check?.message).toContain('1 commit(s) not on the upstream');
  expect(check?.message).toContain('1 uncommitted change(s)');

  commitAt(old, 'old.md', 30 * HOUR);
  check = await gitConvergenceCheck(engine);
  expect(check?.status).toBe('fail');
  const details = check!.details as { roots: Array<{ source_ids: string[]; ahead: number; status: string }>; skipped: Array<{ source_ids: string[]; skipped: string }>; fetched: boolean };
  expect(details.roots.find(root => root.source_ids.includes('old'))).toMatchObject({ ahead: 1, status: 'fail' });
  expect(details.roots.find(root => root.source_ids.includes('old'))!.source_ids).not.toContain('mail');
  expect(details.skipped).toEqual([expect.objectContaining({ source_ids: ['plain'], skipped: 'no upstream branch' })]);
  expect(details.fetched).toBe(false);
});
