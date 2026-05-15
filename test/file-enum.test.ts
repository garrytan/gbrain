import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateFilteredSince } from '../src/core/file-enum.ts';

describe('enumerateFilteredSince', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'file-enum-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns absolute paths of .md files matching prefix with mtime > since', async () => {
    const oldFile = join(tmpDir, 'Webex Old.md');
    const newFile = join(tmpDir, 'Webex New.md');
    const wrongPrefix = join(tmpDir, 'Other.md');
    writeFileSync(oldFile, 'old');
    writeFileSync(newFile, 'new');
    writeFileSync(wrongPrefix, 'other');
    const past = new Date('2026-01-01T00:00:00Z');
    utimesSync(oldFile, past, past);
    const result = await enumerateFilteredSince(tmpDir, '2026-03-01T00:00:00Z', 'Webex ');
    expect(result).toEqual([newFile]);
  });

  test('strict >, not >=', async () => {
    const file = join(tmpDir, 'Webex Boundary.md');
    writeFileSync(file, 'content');
    const fixed = new Date('2026-05-01T00:00:00Z');
    utimesSync(file, fixed, fixed);
    const result = await enumerateFilteredSince(tmpDir, '2026-05-01T00:00:00Z', 'Webex ');
    expect(result).toEqual([]);
  });

  test('non-.md files excluded', async () => {
    writeFileSync(join(tmpDir, 'Webex Foo.txt'), 'x');
    const result = await enumerateFilteredSince(tmpDir, '2020-01-01T00:00:00Z', 'Webex ');
    expect(result).toEqual([]);
  });
});
