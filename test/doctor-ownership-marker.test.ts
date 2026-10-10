/**
 * #5186 (W14 P1.5a): `tracked_ownership_marker` warns when a source checkout
 * has an ownership marker in its Git index. An ignore rule never un-tracks a
 * file, so the fix is `git rm --cached <path>` (the push deny list is the
 * backstop). Untracked or ignored markers are fine; a source that is not a Git
 * checkout emits nothing.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { trackedOwnershipMarkerCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-tracked-marker-'));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).toString().trim();
}
function checkout(name: string): string {
  const work = join(dir, name);
  mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'example@example.invalid']);
  git(work, ['config', 'user.name', 'Example']);
  writeFileSync(join(work, 'note.md'), 'first\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'first']);
  return work;
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

test('tracked_ownership_marker is registered and categorized', () => {
  expect(DOCTOR_CHECK_REGISTRY.some(entry => entry.emits.includes('tracked_ownership_marker'))).toBe(true);
  expect(categorizeCheck('tracked_ownership_marker')).toBe('brain');
});

test('no source emits nothing; a marker in the index warns with git rm --cached; untracked markers and plain directories are quiet', async () => {
  expect(await trackedOwnershipMarkerCheck(engine)).toBeNull();
  const clean = checkout('clean'), untracked = checkout('untracked'), tracked = checkout('tracked');
  const plain = join(dir, 'plain'); mkdirSync(plain);
  writeFileSync(join(plain, '.gbrain-owner.json'), '{"version":1}\n');
  for (const [id, path] of [['clean', clean], ['untracked', untracked], ['tracked', tracked], ['plain', plain]]) {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, path]);
  }
  writeFileSync(join(untracked, '.gbrain-owner.json'), '{"version":1}\n');
  writeFileSync(join(untracked, `.gbrain-owner-${'0'.repeat(64)}.json`), '{"version":1}\n');

  let check = await trackedOwnershipMarkerCheck(engine);
  expect(check?.status).toBe('ok');
  expect(check?.details).toMatchObject({ checkouts: 3, tracked: [] });

  mkdirSync(join(tracked, 'brain'));
  writeFileSync(join(tracked, 'brain', '.gbrain-owner.json'), '{"version":1,"token":"not-a-real-token"}\n');
  writeFileSync(join(tracked, `.gbrain-owner-${'0'.repeat(64)}.json`), '{"version":1}\n');
  writeFileSync(join(tracked, 'brain', '.gbrain-owner.json.11111111-2222-3333-4444-555555555555.tmp'), '{}\n');
  writeFileSync(join(tracked, 'brain', 'page.md'), 'a page\n');
  git(tracked, ['add', '-A']);
  check = await trackedOwnershipMarkerCheck(engine);
  expect(check?.status).toBe('warn');
  expect(check?.message).toContain('Ownership marker file(s) are tracked by Git');
  expect(check?.message).not.toContain('not-a-real-token');
  const details = check!.details as { tracked: Array<{ root: string; source_ids: string[]; paths: string[] }> };
  expect(details.tracked).toHaveLength(1);
  expect(details.tracked[0]).toMatchObject({ root: tracked, source_ids: ['tracked'] });
  expect(details.tracked[0]!.paths.sort()).toEqual([
    `.gbrain-owner-${'0'.repeat(64)}.json`, 'brain/.gbrain-owner.json', 'brain/.gbrain-owner.json.11111111-2222-3333-4444-555555555555.tmp']);
  const fix = check!.fix as { argv: string[]; actor: string; verify: { argv: string[] } };
  expect(fix.actor).toBe('user');
  expect(fix.argv.slice(0, 5)).toEqual(['git', '-C', tracked, 'rm', '--cached']);
  expect(fix.argv.slice(5).sort()).toEqual(details.tracked[0]!.paths.sort());
  expect(fix.verify.argv).toEqual(['gbrain', 'doctor', '--only', 'tracked_ownership_marker', '--json']);

  git(tracked, ['rm', '-q', '--cached', ...details.tracked[0]!.paths]);
  check = await trackedOwnershipMarkerCheck(engine);
  expect(check?.status).toBe('ok');
});
