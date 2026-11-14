/**
 * GST-2634: a read-only mirror (sync off, so autopilot's git-reconcile skips it, and no publishable remote: a disabled
 * sentinel push URL, or `mirror_read_only`) whose only commits ahead of upstream are the access policy files
 * (`.gbrain/access.yml`, `.gbrain/access.approved`) can never publish them, so `git_convergence` reports it as info,
 * not warn or fail. A page file in the ahead commit still warns or fails, and on a `mirror_read_only` source the fix
 * text never suggests a push or `git-durability --enable`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-convergence-mirror-'));
const HOUR = 3_600_000;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).toString().trim();
}

/** A checkout one commit ahead of its upstream, 30 hours old, touching `files`; `sentinel` disables its push URL. */
function mirror(name: string, files: string[], sentinel: boolean): string {
  const bare = join(dir, name + '.git'), work = join(dir, name);
  git(dir, ['init', '-q', '--bare', bare]);
  git(dir, ['clone', '-q', bare, work]);
  git(work, ['config', 'user.email', 'example@example.invalid']);
  git(work, ['config', 'user.name', 'Example']);
  writeFileSync(join(work, 'note.md'), 'first\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'first']); git(work, ['push', '-q', 'origin', 'HEAD']);
  git(work, ['branch', '--set-upstream-to', 'origin/' + git(work, ['branch', '--show-current'])]);
  if (sentinel) git(work, ['remote', 'set-url', '--push', 'origin', 'DISABLED']);
  for (const file of files) { mkdirSync(dirname(join(work, file)), { recursive: true }); writeFileSync(join(work, file), file + '\n'); }
  git(work, ['add', '-A']);
  const date = new Date(Date.now() - 30 * HOUR).toISOString();
  git(work, ['commit', '-q', '-m', 'owner-only access rules'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return work;
}

const addSource = (id: string, path: string, config: Record<string, unknown>) =>
  engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, path, JSON.stringify(config)]);

test('a sync-off mirror with a sentinel push URL and one policy-only local commit is info', async () => {
  await addSource('mirror-a', mirror('policy-only', ['.gbrain/access.yml', '.gbrain/access.approved'], true), { syncEnabled: false });
  const check = await gitConvergenceCheck(engine);
  expect(check?.status).toBe('ok');
  expect(check?.severity).toBe('info');
});

test('the same mirror with a page file in the ahead commit still fails', async () => {
  await addSource('mirror-a', mirror('page-ahead', ['.gbrain/access.yml', 'notes/page-example.md'], true), { syncEnabled: false });
  const check = await gitConvergenceCheck(engine);
  expect(check?.status).toBe('fail');
});

test('a page change that only a merge commit ahead of upstream carries still fails', async () => {
  const work = mirror('merge-ahead', ['.gbrain/access.yml'], true);
  const main = git(work, ['branch', '--show-current']);
  git(work, ['checkout', '-q', '-b', 'side', 'origin/' + main]);
  mkdirSync(join(work, '.gbrain'), { recursive: true });
  writeFileSync(join(work, '.gbrain/access.approved'), 'approved\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'approved rules']);
  git(work, ['checkout', '-q', main]);
  git(work, ['merge', '-q', '--no-ff', '--no-commit', 'side']);
  writeFileSync(join(work, 'note.md'), 'edited in the merge\n');
  git(work, ['add', '-A']);
  const date = new Date(Date.now() - 30 * HOUR).toISOString();
  git(work, ['commit', '-q', '-m', 'merge side'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  await addSource('mirror-m', work, { syncEnabled: false });
  const check = await gitConvergenceCheck(engine);
  expect(check?.status).toBe('fail');
});

test('a mirror_read_only source: policy-only is info, and a page commit fails without a push or git-durability fix', async () => {
  await addSource('mirror-b', mirror('ro-policy', ['.gbrain/access.yml'], false), { syncEnabled: false, mirror_read_only: true });
  expect((await gitConvergenceCheck(engine))?.severity).toBe('info');
  await resetPgliteState(engine);
  await addSource('mirror-b', mirror('ro-page', ['notes/page-example.md'], false), { syncEnabled: false, mirror_read_only: true });
  const check = await gitConvergenceCheck(engine);
  expect(check?.status).toBe('fail');
  const text = JSON.stringify([check?.message, check?.fix ?? null]);
  expect(text).not.toContain('git-durability');
  expect(text).not.toMatch(/push/i);
});

test('a policy-only commit on a source whose sync is on still fails', async () => {
  await addSource('source-c', mirror('sync-on', ['.gbrain/access.yml'], true), {});
  expect((await gitConvergenceCheck(engine))?.status).toBe('fail');
});
