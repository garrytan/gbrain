/**
 * #6510: Git's NFC spelling and a filesystem's NFD realpath must hash the
 * same regular file, without allowing symlink traversal or a different inode.
 * Existing manifest tests cover Git modes/escape but not Unicode equivalence.
 * The fixture uses real Git/files/links; only realpath's returned spelling is
 * simulated on normalization-sensitive hosts. No production-only seam added.
 */
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { worktreeManifest } from '../src/core/persistence/worktree-manifest.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
const unsafe = expect.objectContaining({ code: 'writer_manifest_unsafe' });

function fixture(fn: (root: string, nfc: string, nfd: string) => void): void {
  const home = fs.mkdtempSync(join(tmpdir(), 'gbrain-manifest-unicode-'));
  const root = fs.realpathSync(home);
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'core.precomposeunicode', 'true');
    const nfc = join(root, 'caf\u00e9.md'), nfd = nfc.normalize('NFD');
    fs.writeFileSync(nfc, 'Synthetic commitment: keep the complete file.\n');
    git(root, 'add', 'caf\u00e9.md');
    fn(root, nfc, nfd);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function withSpelling(path: string, real: string, fn: () => void): void {
  const original = fs.realpathSync;
  const probe = spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, opts?: unknown) =>
    String(p) === path ? real : original(p, opts as never)) as typeof fs.realpathSync);
  try { fn(); } finally { probe.mockRestore(); }
}

test('canonically equivalent realpath preserves the Git path key and file digest', () => {
  fixture((root, nfc, nfd) => {
    // APFS already resolves both spellings; Linux needs a same-inode alias.
    if (!fs.existsSync(nfd)) fs.linkSync(nfc, nfd);
    let baselineDigest = '';
    withSpelling(nfc, nfc, () => { baselineDigest = worktreeManifest(root).digest; });
    withSpelling(nfc, nfd, () => {
      const manifest = worktreeManifest(root, { withFiles: true });
      expect(manifest.digest).toBe(baselineDigest);
      expect(manifest.file_count).toBe(1);
      expect(Object.keys(manifest.files!)).toEqual(['caf\u00e9.md']);
    });
  });
});

test('Unicode equivalence alone cannot authorize a different file', () => {
  fixture((root, nfc, nfd) => {
    // On a normalization-insensitive filesystem a separate spelling cannot be
    // a separate file. Simulate that hostile identity with an lstat result.
    const other = join(root, 'other.md'); fs.writeFileSync(other, 'Not the tracked file.\n');
    const original = fs.lstatSync;
    const info = fs.lstatSync(other);
    const stats = spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, opts?: unknown) =>
      String(p) === nfd ? info : original(p, opts as never)) as typeof fs.lstatSync);
    try {
      withSpelling(nfc, nfd, () => expect(() => worktreeManifest(root)).toThrow(unsafe));
    } finally { stats.mockRestore(); }
  });
});

test('a canonically equivalent leaf symlink is still refused', () => {
  fixture((root, nfc, nfd) => {
    fs.rmSync(nfc);
    fs.writeFileSync(nfd, 'Synthetic linked target.\n');
    // Use another path on APFS, where NFC and NFD refer to the same entry.
    const target = join(root, 'target.md'); fs.renameSync(nfd, target);
    fs.symlinkSync(target, nfc);
    withSpelling(nfc, nfd, () => expect(() => worktreeManifest(root)).toThrow(unsafe));
  });
});

test('a symlink parent remains refused even when realpath spelling normalizes equal', () => {
  fixture((root, nfc) => {
    const parent = join(root, 'caf\u00e9');
    const target = join(root, 'target'); fs.mkdirSync(target);
    fs.writeFileSync(join(target, 'note.md'), 'Synthetic parent-link target.\n');
    fs.symlinkSync(target, parent, process.platform === 'win32' ? 'junction' : 'dir');
    // Store a regular index entry under the parent, not a symlink Git mode.
    git(root, 'update-index', '--add', '--cacheinfo', '100644', git(root, 'hash-object', nfc).toString().trim(), 'caf\u00e9/note.md');
    const path = join(parent, 'note.md');
    withSpelling(path, path.normalize('NFD'), () => expect(() => worktreeManifest(root)).toThrow(unsafe));
  });
});

test('a Unicode-named Git submodule refuses before hashing', () => {
  fixture((root, nfc) => {
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'synthetic');
    const head = git(root, 'rev-parse', 'HEAD').toString().trim();
    git(root, 'update-index', '--add', '--cacheinfo', '160000', head, 'caf\u00e9');
    expect(() => worktreeManifest(root)).toThrow(unsafe);
  });
});
