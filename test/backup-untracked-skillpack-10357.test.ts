/**
 * #10357: a shared-skill pack the publisher adopted into a git-backed source root (skillpack.json, skills/ and its
 * LICENSE) is published from the database and never committed, so `gbrain backup check` read the source dirty forever.
 * Protects: while the root skillpack.json is untracked, the untracked pack files do not make the worktree dirty, and
 * the source verifies against its remote; any other change (an edited page, an untracked non-pack file) still reads
 * dirty, and pack files without an untracked root manifest still read dirty.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessBackupRepository } from '../src/core/backup/repository.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

function pushedRepo(): string {
  const bare = tmp('gbrain-10357-bare-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const root = join(tmp('gbrain-10357-'), 'brain'); mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'note.md'), '# note\n');
  git(root, 'add', '-A'); git(root, '-c', 'user.email=example@example.invalid', '-c', 'user.name=Example', 'commit', '-qm', 'note');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}
function adoptPack(root: string) {
  writeFileSync(join(root, 'skillpack.json'), '{"api_version":"gbrain-skillpack-v1","name":"pack-example","skills":["skills/memory-example"]}\n');
  writeFileSync(join(root, 'LICENSE'), 'MIT\n');
  mkdirSync(join(root, 'skills', 'memory-example'), { recursive: true });
  writeFileSync(join(root, 'skills', 'memory-example', 'SKILL.md'), '---\nname: memory-example\n---\n');
}
const assess = (root: string) => assessBackupRepository(root, 'source_repo', 'source-a', new Date(), { remaining: 1 });

test('an adopted pack left untracked does not make the source dirty, and the source still verifies', async () => {
  const root = pushedRepo();
  adoptPack(root);
  const verdict = await assess(root);
  expect(verdict.state).toBe('ok');
  expect(verdict.verification?.state).toBe('verified');
});

test('other changes beside an untracked pack still read dirty', async () => {
  const edited = pushedRepo();
  adoptPack(edited);
  writeFileSync(join(edited, 'note.md'), '# edited\n');
  expect((await assess(edited)).state).toBe('dirty');
  const extra = pushedRepo();
  adoptPack(extra);
  writeFileSync(join(extra, 'draft.md'), '# draft\n');
  expect((await assess(extra)).state).toBe('dirty');
});

test('pack-shaped files without an untracked root skillpack.json still read dirty', async () => {
  const bare = pushedRepo();
  writeFileSync(join(bare, 'LICENSE'), 'MIT\n');
  mkdirSync(join(bare, 'skills', 'memory-example'), { recursive: true });
  writeFileSync(join(bare, 'skills', 'memory-example', 'SKILL.md'), '# skill\n');
  expect((await assess(bare)).state).toBe('dirty');
  const tracked = pushedRepo();
  adoptPack(tracked);
  git(tracked, 'add', 'skillpack.json'); git(tracked, '-c', 'user.email=example@example.invalid', '-c', 'user.name=Example', 'commit', '-qm', 'pack');
  git(tracked, 'push', '-q');
  expect((await assess(tracked)).state).toBe('dirty');
});
