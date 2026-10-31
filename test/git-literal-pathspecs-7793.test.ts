/**
 * #7793 (items 1 and 3): `literalPathspecs` fails closed on an empty path, and the read paths that used git's global
 * `--literal-pathspecs` flag build per-path `:(literal)` pathspecs instead, with the same meaning: a path named with glob
 * characters or a leading colon selects only that file. Real repositories, no seams. Repo-less brains never reach these
 * calls (no repository, no git read), so nothing here changes them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitChildEnv, literalPathspecs } from '../src/core/git-env.ts';
import { gitResidualCommits } from '../src/core/facts/purge-verify.ts';
import { readTreeBlobs } from '../src/core/persistence/sync-blobs.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=a@example.com', '-c', 'user.name=a', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7793-')));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, name), body);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', `add ${name}`);
  }
  return root;
}

describe('literalPathspecs', () => {
  test('prefixes each path and keeps the order', () => {
    expect(literalPathspecs(['a.md', '[ab].md', ':x.md', 'dir/*'])).toEqual([':(literal)a.md', ':(literal)[ab].md', ':(literal):x.md', ':(literal)dir/*']);
    expect(literalPathspecs([])).toEqual([]);
  });

  test('an empty path throws, because `:(literal)` alone matches the whole tree', () => {
    const root = repo({ 'a.md': 'one\n' });
    writeFileSync(join(root, 'a.md'), 'two\n');
    expect(git(root, 'status', '--porcelain', '--', ':(literal)')).toBe('M a.md');
    expect(() => literalPathspecs([''])).toThrow('empty path');
    expect(() => literalPathspecs(['a.md', ''])).toThrow('empty path');
  });

  test('. stays the explicit whole-tree scope that read callers use', () => {
    expect(literalPathspecs(['.'])).toEqual([':(literal).']);
  });
});

describe('converted read paths keep glob and leading-colon names literal', () => {
  test('readTreeBlobs returns only the named blobs', () => {
    const root = repo({ 'a.md': 'a\n', '[ab].md': 'glob\n', ':colon.md': 'colon\n' });
    const blobs = readTreeBlobs(root, 'HEAD', ['[ab].md', ':colon.md']);
    expect([...blobs.keys()].sort()).toEqual([':colon.md', '[ab].md']);
  });

  test('gitResidualCommits reads the history of the named file only', async () => {
    const root = repo({ 'a.md': 'the secret claim\n', '[ab].md': 'harmless\n', ':colon.md': 'the secret claim again\n' });
    const glob = await gitResidualCommits(root, ['[ab].md'], 'secret claim');
    expect(glob).toMatchObject({ status: 'out_of_reach', remaining: 0 });
    const colon = await gitResidualCommits(root, [':colon.md'], 'secret claim');
    expect(colon).toMatchObject({ remaining: 1 });
  });
});
