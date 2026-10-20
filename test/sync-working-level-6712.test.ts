/**
 * #6712 PR 4b (design v3.2 §2.1), probe 41: in working mode the level of a path is the bytes on disk (or absent), whatever the index says. A staged
 * edit, a staged new file, `git rm --cached`, a staged deletion and a staged file removed from disk all read the disk,
 * in the `clean_eol`/`clean_lfs` domains. The index only feeds committed mode's `Dp` categories.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { shadowConvergence } from '../src/core/persistence/sync-pass.ts';
import { probeDirtiness, readIndexLevel, readTreeLevel } from '../src/core/persistence/sync-git-stream.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const blobOid = (content: string | Buffer) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function repo(files: Record<string, string | Buffer>, attributes?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-working-level-'));
  dirs.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'user.name', 'Writer Example');
  if (attributes) writeFileSync(join(root, '.gitattributes'), attributes);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

async function workingProbe(root: string, paths: string[]) {
  return probeDirtiness(root, root, paths, await readTreeLevel(root, 'HEAD', ''), await readIndexLevel(root), { working: true });
}

describe('probe 41: the working level is the disk bytes, whatever the index says', () => {
  test('every staged shape probes exactly as the same disk does with a pristine index', async () => {
    const content = Buffer.from('large binary payload\n'.repeat(40));
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(content)}\nsize ${content.length}\n`;
    const root = repo({ 'edit.md': 'old\n', 'cached.md': 'c\n', 'removed.md': 'r\n', 'eol.md': 'a\nb\n', 'big.bin': pointer, 'back.md': 'back\n' },
      'eol.md text\n*.bin filter=lfs -text\n');
    writeFileSync(join(root, 'edit.md'), 'staged edit\n');
    writeFileSync(join(root, 'added.md'), 'added\n');
    writeFileSync(join(root, 'vanished.md'), 'vanished\n');
    git(root, 'add', 'edit.md', 'added.md', 'vanished.md');
    unlinkSync(join(root, 'vanished.md'));
    git(root, 'rm', '-q', '--cached', 'cached.md');
    git(root, 'rm', '-q', 'removed.md');
    writeFileSync(join(root, 'eol.md'), 'a\r\nb\r\n');
    writeFileSync(join(root, 'big.bin'), content);
    git(root, 'update-index', '--chmod=+x', 'eol.md', 'big.bin');
    writeFileSync(join(root, 'back.md'), 'staged then reverted\n');
    git(root, 'add', 'back.md');
    writeFileSync(join(root, 'back.md'), 'back\n');
    const paths = ['edit.md', 'added.md', 'vanished.md', 'cached.md', 'removed.md', 'eol.md', 'big.bin', 'back.md', 'never.md'];

    const staged = await workingProbe(root, paths);
    git(root, 'reset', '-q');
    const pristine = await workingProbe(root, paths);
    for (const path of paths) expect([path, staged.get(path)]).toEqual([path, pristine.get(path)]);
    expect(Object.fromEntries([...staged].map(([path, probe]) => [path, probe.dp]))).toEqual({
      'edit.md': 'modified', 'added.md': 'untracked', 'vanished.md': 'deleted', 'cached.md': 'clean', 'removed.md': 'deleted',
      'eol.md': 'clean_eol', 'big.bin': 'clean_lfs', 'back.md': 'clean', 'never.md': 'deleted' });
    expect(staged.get('edit.md')).toEqual({ dp: 'modified', rawOid: blobOid('staged edit\n'), rawSha256: sha256('staged edit\n') });
    expect(staged.get('added.md')).toEqual({ dp: 'untracked', rawOid: blobOid('added\n'), rawSha256: sha256('added\n') });
    expect(staged.get('vanished.md')).toEqual({ dp: 'deleted', rawOid: null, rawSha256: null });
  });

  const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
  const setup = ({ root }: { root: string }) => {
    git(root, 'init', '-q');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, '.gitattributes'), 'notes/eol.md text\n');
    for (const name of ['alpha', 'beta', 'gamma', 'eol']) writeFileSync(join(root, 'notes', name + '.md'), note(name, 'Synthetic ' + name + ' one.'));
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  };

  test('a managed pass classifies a staged deletion as a delete, a staged file gone from disk as gone, and a CRLF file as matched', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
    writeFileSync(join(root, 'notes', 'alpha.md'), note('alpha', 'A staged edit.'));
    git(root, 'add', 'notes/alpha.md');
    git(root, 'rm', '-q', 'notes/beta.md');
    writeFileSync(join(root, 'notes', 'zeta.md'), note('zeta', 'Staged, then removed from disk.'));
    git(root, 'add', 'notes/zeta.md');
    unlinkSync(join(root, 'notes', 'zeta.md'));
    writeFileSync(join(root, 'notes', 'eol.md'), note('eol', 'Synthetic eol one.').replaceAll('\n', '\r\n'));
    git(root, 'update-index', '--chmod=+x', 'notes/eol.md');
    const receipt = (await shadowConvergence(engine, { sourceId: 'default', workingTree: true }))!;
    expect(receipt.mode).toBe('working');
    expect(receipt.counts).toEqual({ matched: 2, import: 1, delete: 1, gone: 1 });
    expect(receipt.samples.import!.map(sample => sample.path)).toEqual(['notes/alpha.md']);
    expect(receipt.samples.delete!.map(sample => sample.path)).toEqual(['notes/beta.md']);
  }, { setup }), 120_000);
});
