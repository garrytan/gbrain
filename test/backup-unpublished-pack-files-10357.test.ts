import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessBackupRepository } from '../src/core/backup/repository.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

let tmp: string;
let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-backup-pack-'));
  root = join(tmp, 'source');
  mkdirSync(root);
  await makeGitFixture(root);
  git('branch', '-M', 'main');
  writeFileSync(join(root, 'note.md'), '# note\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  execFileSync('git', ['-C', tmp, 'init', '--bare', '-b', 'main', join(tmp, 'remote.git')], { stdio: 'ignore' });
  git('remote', 'add', 'origin', join(tmp, 'remote.git'));
  git('push', '-u', 'origin', 'main');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('untracked pack files of an adopted pack do not make the source dirty, but other edits still do', async () => {
  writeFileSync(join(root, 'LICENSE'), 'MIT\n');
  writeFileSync(join(root, 'skillpack.json'), '{}\n');
  mkdirSync(join(root, 'skills', 'memory'), { recursive: true });
  writeFileSync(join(root, 'skills', 'memory', 'SKILL.md'), '# skill\n');
  const clean = await assessBackupRepository(root, 'source_repo', 'default', new Date());
  expect(clean.state).not.toBe('dirty');
  writeFileSync(join(root, 'note.md'), '# edited\n');
  const dirty = await assessBackupRepository(root, 'source_repo', 'default', new Date());
  expect(dirty.state).toBe('dirty');
});

test('a lone untracked LICENSE without a pack manifest still reads dirty', async () => {
  rmSync(join(root, 'skillpack.json'));
  git('checkout', '--', 'note.md');
  const result = await assessBackupRepository(root, 'source_repo', 'default', new Date());
  expect(result.state).toBe('dirty');
});
