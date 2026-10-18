/**
 * #6510: the Git-scope manifest hashes a tracked file through its Git spelling and refuses only real symlinks.
 *
 * On macOS APFS (normalization-insensitive) Git's index spells `café.md` in NFC while `realpath` answers with the
 * on-disk NFD entry, and master's `realpath(path) === path` proxy refused the checkout with `writer_manifest_unsafe`
 * although nothing was a symlink; a case-insensitive volume whose index case differs from the on-disk case fails the
 * same way. The fix lstat's every directory component and the leaf (per read, no cache) and never consults the alias.
 *
 * Linux (ext4) is normalization-sensitive, so the positive case is SYNTHETIC: a same-inode hard link supplies the NFD
 * entry and `fs.realpathSync` is spied to return that spelling for the NFC path, exactly what APFS would answer (the
 * spy fixture idea is PR #6520's, @javieraldape). It is a behavioural fail-first on master (old refusal vs. the correct
 * digest), not an APFS reproduction; the case-spelling case runs only where the tmpdir is case-insensitive. The
 * negatives (leaf/parent symlink, submodule, tracked symlink, and a parent swapped to a symlink after the first file
 * was read) pass before and after and pin what the fix must keep refusing; the hand-edited index escape stays pinned
 * in test/persistence-manifest-git-scope.test.ts.
 *
 * `spyOn(fs, …)` is process-global; every spy is synchronous and restored in `finally`.
 */
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { worktreeManifest } from '../src/core/persistence/worktree-manifest.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString().trim();
const unsafe = expect.objectContaining({ code: 'writer_manifest_unsafe' });
const NFC = 'caf\u00e9.md', NFD = NFC.normalize('NFD');

/** A Git checkout (precomposed index) holding one tracked file named in NFC; `fn` gets the root and both spellings. */
function fixture(fn: (root: string, nfc: string, nfd: string) => void): void {
  const home = fs.mkdtempSync(join(tmpdir(), 'gbrain-manifest-unicode-'));
  const root = fs.realpathSync(home);
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'core.precomposeunicode', 'true');
    const nfc = join(root, NFC);
    fs.writeFileSync(nfc, 'Synthetic commitment: keep the complete file.\n');
    git(root, 'add', NFC);
    fn(root, nfc, nfc.normalize('NFD'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

/** `fs.realpathSync(path)` answers `real` (what a normalization- or case-insensitive volume would say); everything else is real. */
function withSpelling(path: string, real: string, fn: () => void): void {
  const original = fs.realpathSync;
  const probe = spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, opts?: unknown) =>
    String(p) === path ? real : original(p, opts as never)) as typeof fs.realpathSync);
  try { fn(); } finally { probe.mockRestore(); }
}

test('positive (synthetic): a canonically equivalent realpath spelling keeps the Git path key and the file digest', () => {
  fixture((root, nfc, nfd) => {
    // APFS resolves both spellings to one entry; ext4 needs a same-inode alias for the NFD name to exist at all.
    if (!fs.existsSync(nfd)) fs.linkSync(nfc, nfd);
    const baseline = worktreeManifest(root, { withFiles: true });
    expect(Object.keys(baseline.files!)).toEqual([NFC]);
    withSpelling(nfc, nfd, () => {
      const manifest = worktreeManifest(root, { withFiles: true });
      expect(manifest.digest).toBe(baseline.digest);
      expect(manifest.file_count).toBe(1);
      expect(manifest.files).toEqual(baseline.files);
    });
  });
});

test('a case-spelling mismatch between the index and the disk is not a symlink (case-insensitive volumes only)', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'gbrain-manifest-case-'));
  try {
    fs.writeFileSync(join(home, 'Probe.txt'), 'x');
    if (!fs.existsSync(join(home, 'probe.txt'))) return; // normalization- and case-sensitive host: nothing to prove here
    const root = fs.realpathSync(home);
    git(root, 'init', '-q');
    fs.mkdirSync(join(root, 'notes'));
    fs.writeFileSync(join(root, 'notes', 'a.md'), 'Synthetic note.\n');
    // The index spells the path with another case than the disk does.
    git(root, 'update-index', '--add', '--cacheinfo', '100644', git(root, 'hash-object', join(root, 'notes', 'a.md')), 'Notes/A.md');
    const manifest = worktreeManifest(root, { withFiles: true });
    expect(Object.keys(manifest.files!)).toEqual(['Notes/A.md']);
    expect(manifest.file_count).toBe(1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a leaf symlink is still refused, whatever spelling realpath answers', () => {
  fixture((root, nfc, nfd) => {
    fs.rmSync(nfc);
    const target = join(root, 'target.md');
    fs.writeFileSync(target, 'Synthetic linked target.\n');
    fs.symlinkSync(target, nfc);
    expect(() => worktreeManifest(root)).toThrow(unsafe);
    withSpelling(nfc, nfd, () => expect(() => worktreeManifest(root)).toThrow(unsafe));
  });
});

test('a symlink parent directory is still refused, whatever spelling realpath answers', () => {
  fixture((root, nfc) => {
    const parent = join(root, 'caf\u00e9');
    const target = join(root, 'target'); fs.mkdirSync(target);
    fs.writeFileSync(join(target, 'note.md'), 'Synthetic parent-link target.\n');
    fs.symlinkSync(target, parent, process.platform === 'win32' ? 'junction' : 'dir');
    // A regular index entry under the parent, not a symlink Git mode: only the component check can see the link.
    git(root, 'update-index', '--add', '--cacheinfo', '100644', git(root, 'hash-object', nfc), 'caf\u00e9/note.md');
    const path = join(parent, 'note.md');
    expect(() => worktreeManifest(root)).toThrow(unsafe);
    withSpelling(path, path.normalize('NFD'), () => expect(() => worktreeManifest(root)).toThrow(unsafe));
  });
});

test('a parent directory swapped to a symlink after the first file of the manifest was read is refused (no manifest-long cache)', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'gbrain-manifest-swap-'));
  try {
    const root = fs.realpathSync(home);
    const outside = fs.mkdtempSync(join(tmpdir(), 'gbrain-manifest-swap-outside-'));
    try {
      git(root, 'init', '-q');
      fs.mkdirSync(join(root, 'd'));
      fs.writeFileSync(join(root, 'd', 'a.md'), 'first\n');
      fs.writeFileSync(join(root, 'd', 'b.md'), 'second\n');
      git(root, 'add', 'd/a.md', 'd/b.md');
      // Outside the root: a directory holding a same-named b.md with other bytes.
      fs.writeFileSync(join(outside, 'b.md'), 'OUTSIDE THE ROOT\n');
      // Between the two reads (paths are hashed in sorted order), replace d/ by a symlink to the outside directory.
      const original = fs.readFileSync;
      let swapped = false;
      const probe = spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathLike | number, opts?: unknown) => {
        const bytes = original(p as never, opts as never);
        if (String(p) === join(root, 'd', 'a.md') && !swapped) {
          swapped = true;
          fs.renameSync(join(root, 'd'), join(outside, 'd-moved'));
          fs.symlinkSync(outside, join(root, 'd'), process.platform === 'win32' ? 'junction' : 'dir');
        }
        return bytes;
      }) as typeof fs.readFileSync);
      try { expect(() => worktreeManifest(root, { scope: 'git' })).toThrow(unsafe); } finally { probe.mockRestore(); }
      expect(swapped).toBe(true);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a tracked symlink (mode 120000) and a submodule (160000) refuse from the index before any read', () => {
  fixture((root) => {
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'synthetic');
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-index', '--add', '--cacheinfo', '160000', head, 'caf\u00e9');
    expect(() => worktreeManifest(root)).toThrow(unsafe);
    git(root, 'update-index', '--force-remove', 'caf\u00e9');
    const linkBlob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'target.md' }).toString().trim();
    git(root, 'update-index', '--add', '--cacheinfo', '120000', linkBlob, 'link.md');
    expect(() => worktreeManifest(root)).toThrow(unsafe);
  });
});

test('a tracked file missing on disk counts as deleted, a directory in a file slot too', () => {
  fixture((root, nfc) => {
    fs.rmSync(nfc);
    expect(worktreeManifest(root, { withFiles: true })).toMatchObject({ file_count: 0, files: {} });
    fs.mkdirSync(nfc);
    expect(worktreeManifest(root, { withFiles: true })).toMatchObject({ file_count: 0, files: {} });
  });
});
