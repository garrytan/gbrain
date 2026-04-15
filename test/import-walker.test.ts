import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectMarkdownFiles } from '../src/commands/import.ts';

describe('collectMarkdownFiles', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-import-root-'));
    outside = mkdtempSync(join(tmpdir(), 'gbrain-import-outside-'));
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
});
