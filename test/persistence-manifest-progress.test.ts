/** #5790 / DX-O10: manifest hashing progress and digest compatibility. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { compactStoredManifest, humanManifestProgress, MANIFEST_PROGRESS_MIN_FILES, worktreeManifest } from '../src/core/persistence/ownership.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';
import { DEFAULT_CLI_OPTIONS, _resetCliOptionsForTest, setCliOptions } from '../src/core/cli-options.ts';
import { writeLargeWorktree } from './helpers/large-worktree.ts';

function sink() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', chunk => chunks.push(chunk.toString('utf8')));
  return { stream, read: () => chunks.join('') };
}

function withWorktree<T>(count: number, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-manifest-progress-'));
  try { writeLargeWorktree(root, count); return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('worktree manifest hashing', () => {
  afterEach(() => _resetCliOptionsForTest());

  test('reports files hashed of total on stderr above 5,000 files', () => withWorktree(MANIFEST_PROGRESS_MIN_FILES + 1, root => {
    const { stream, read } = sink();
    const manifest = worktreeManifest(root, { progress: { mode: 'human', stream, minIntervalMs: 0, minItems: 1 } });
    expect(manifest.file_count).toBe(MANIFEST_PROGRESS_MIN_FILES + 1);
    expect(read()).toContain('sources.manifest_hash');
    expect(read()).toContain(`/${MANIFEST_PROGRESS_MIN_FILES + 1}`);
  }));

  test('stays silent at or below 5,000 files and without a progress request', () => withWorktree(MANIFEST_PROGRESS_MIN_FILES, root => {
    const { stream, read } = sink();
    worktreeManifest(root, { progress: { mode: 'human', stream, minIntervalMs: 0, minItems: 1 } });
    expect(read()).toBe('');
  }));

  test('progress is offered in human mode only', () => {
    expect(humanManifestProgress()).toMatchObject({ mode: 'auto' });
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, progressJson: true });
    expect(humanManifestProgress()).toBeUndefined();
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, quiet: true });
    expect(humanManifestProgress()).toBeUndefined();
  });

  test('the digest is unchanged from the per-file map older binaries stored', () => withWorktree(25, root => {
    const files: Record<string, string> = {};
    const visit = (dir: string) => { for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path); else files[relative(root, path).split(sep).join('/')] = sha256(readFileSync(path));
    } };
    visit(root);
    expect(worktreeManifest(root)).toEqual({ digest: digest(files), file_count: 25 });
  }));

  test('a legacy stored manifest drops only its per-file map', () => {
    const legacy = { digest: 'd'.repeat(64), files: { 'a.md': 'f'.repeat(64), 'b.md': 'e'.repeat(64) }, canonical_stamp: 'stamp', self_transfer: { hostId: 'h' } };
    expect(compactStoredManifest(legacy)).toEqual({ digest: 'd'.repeat(64), file_count: 2, canonical_stamp: 'stamp', self_transfer: { hostId: 'h' } });
    expect(compactStoredManifest({ digest: 'd'.repeat(64), file_count: 7 })).toEqual({ digest: 'd'.repeat(64), file_count: 7 });
  });
});
