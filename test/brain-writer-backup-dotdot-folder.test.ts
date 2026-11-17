/**
 * createFrontmatterBackup (src/core/brain-writer.ts) keeps a file's folder
 * path under the backup root, so two same-named files in different folders
 * never share one backup, including when the first folder is named `..drafts`.
 *
 * Authoring gate:
 * 1. Protects: backing up `<source>/..drafts/note.md` and
 *    `<source>/..more/note.md` writes two different backup files, each with its
 *    own original bytes (a backup is the undo for `frontmatter validate --fix`);
 *    a file outside the source folder still falls back to its bare file name.
 * 2. Regression that fails it: the "outside the source" test matching any
 *    relative path that starts with the two characters `..` instead of only a
 *    `..` path component. Both backups then land on `note.md.bak` and the
 *    second silently overwrites the first.
 * 3. Why existing coverage misses it: brain-writer.test.ts and
 *    frontmatter-fix-slug-5053.test.ts back up files in ordinary folders only.
 * 4. Production seam: none. createFrontmatterBackup is exported; the backup
 *    root is passed in, so nothing is written under GBRAIN_HOME.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import { createFrontmatterBackup } from '../src/core/brain-writer.ts';

let scratch: string;
let source: string;
let backups: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gbrain-backup-dotdot-'));
  source = join(scratch, 'brain');
  backups = join(scratch, 'backups');
  mkdirSync(source, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeNote(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'note.md');
  writeFileSync(file, body);
  return file;
}

describe('createFrontmatterBackup with a first folder whose name starts with two dots', () => {
  test('keeps the folder path under the backup root', () => {
    const file = writeNote(join(source, '..drafts'), 'draft body\n');
    const backup = createFrontmatterBackup(file, { sourcePath: source, backupRoot: backups });
    expect(relative(backups, backup).split('/').slice(1).join('/')).toBe('..drafts/note.md.bak');
    expect(readFileSync(backup, 'utf8')).toBe('draft body\n');
  });

  test('two same-named files in different ..folders get two separate backups', () => {
    const a = writeNote(join(source, '..drafts'), 'draft body\n');
    const b = writeNote(join(source, '..more'), 'more body\n');
    const backupA = createFrontmatterBackup(a, { sourcePath: source, backupRoot: backups });
    const backupB = createFrontmatterBackup(b, { sourcePath: source, backupRoot: backups });
    expect(backupA).not.toBe(backupB);
    expect(readFileSync(backupA, 'utf8')).toBe('draft body\n');
    expect(readFileSync(backupB, 'utf8')).toBe('more body\n');
  });
});

describe('createFrontmatterBackup still files an outside file under its bare name', () => {
  test('a file in a plain folder beside the source folder', () => {
    const file = writeNote(join(scratch, 'elsewhere'), 'x\n');
    const backup = createFrontmatterBackup(file, { sourcePath: source, backupRoot: backups });
    expect(backup.endsWith('/note.md.bak')).toBe(true);
    expect(relative(backups, backup).split('/')).toHaveLength(2);
  });

  test('a file in a sibling folder that shares the source folder name prefix', () => {
    const file = writeNote(join(scratch, 'brain2'), 'x\n');
    const backup = createFrontmatterBackup(file, { sourcePath: source, backupRoot: backups });
    expect(relative(backups, backup).split('/')).toHaveLength(2);
    expect(backup.endsWith('/note.md.bak')).toBe(true);
  });

  test('a file in a ..outside folder beside the source folder', () => {
    const file = writeNote(join(scratch, '..outside'), 'x\n');
    const backup = createFrontmatterBackup(file, { sourcePath: source, backupRoot: backups });
    expect(relative(backups, backup).split('/')).toHaveLength(2);
    expect(backup.endsWith('/note.md.bak')).toBe(true);
  });
});
