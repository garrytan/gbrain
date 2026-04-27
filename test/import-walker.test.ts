import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectMarkdownFiles } from '../src/commands/import.ts';

describe('collectMarkdownFiles', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mbrain-import-root-'));
    outside = mkdtempSync(join(tmpdir(), 'mbrain-import-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('includes real markdown files inside the root', () => {
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'other.md'), '# other\n');

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).toContain(join(root, 'notes', 'other.md'));
  });

  test('skips markdown files that are not syncable brain pages', () => {
    writeFileSync(join(root, 'README.md'), '# resolver\n');
    writeFileSync(join(root, 'schema.md'), '# schema\n');
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(join(root, 'people', 'alice.md'), '# Alice\n');
    writeFileSync(join(root, 'people', 'README.md'), '# people resolver\n');
    mkdirSync(join(root, 'people', 'alice.raw'), { recursive: true });
    writeFileSync(join(root, 'people', 'alice.raw', 'source.md'), '# raw source\n');
    mkdirSync(join(root, 'ops'), { recursive: true });
    writeFileSync(join(root, 'ops', 'deploy.md'), '# deploy log\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'notes.md'), '# package notes\n');

    const files = collectMarkdownFiles(root);

    expect(files).toContain(join(root, 'people', 'alice.md'));
    expect(files).not.toContain(join(root, 'README.md'));
    expect(files).not.toContain(join(root, 'schema.md'));
    expect(files).not.toContain(join(root, 'people', 'README.md'));
    expect(files).not.toContain(join(root, 'people', 'alice.raw', 'source.md'));
    expect(files).not.toContain(join(root, 'ops', 'deploy.md'));
    expect(files).not.toContain(join(root, 'node_modules', 'pkg', 'notes.md'));
  });

  test('skips a symlink file pointing outside the import root', () => {
    const secretFile = join(outside, 'secret.md');
    writeFileSync(secretFile, '# secret\n');
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    symlinkSync(secretFile, join(root, 'innocent.md'));

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).not.toContain(join(root, 'innocent.md'));
    expect(files).not.toContain(secretFile);
  });

  test('does not descend into a symlinked directory', () => {
    const externalDir = join(outside, 'external');
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, 'external.md'), '# external\n');
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    symlinkSync(externalDir, join(root, 'linked-notes'));

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).not.toContain(join(root, 'linked-notes', 'external.md'));
    expect(files).not.toContain(join(externalDir, 'external.md'));
  });

  test('rejects a symlinked import root', () => {
    writeFileSync(join(outside, 'external.md'), '# external\n');
    const linkedRoot = join(tmpdir(), `mbrain-import-root-link-${Date.now()}`);
    symlinkSync(outside, linkedRoot);

    try {
      const files = collectMarkdownFiles(linkedRoot);
      expect(files).toEqual([]);
    } finally {
      rmSync(linkedRoot, { force: true });
    }
  });

  test('throws for a missing import root instead of silently succeeding', () => {
    expect(() => collectMarkdownFiles(join(root, 'does-not-exist'))).toThrow();
  });
});
