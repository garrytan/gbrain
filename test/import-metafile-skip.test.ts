/**
 * Closes #345: the bulk-import walker must skip SYNC_SKIP_FILES metafiles
 * (README.md / index.md / log.md / schema.md / RESOLVER.md), the same way
 * incremental `sync` (isSyncable) does.
 *
 * Root cause this locks: a directory-import pass imported every directory
 * README.md as a page (titled "People", "Companies", …), because
 * collectSyncableFiles only filtered by extension. Those index-titled pages
 * then trigram-corrupted fuzzy entity resolution and inflated orphan count.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { collectSyncableFiles } from '../src/commands/import.ts';

let tmp: string;

function write(relPath: string, content: string): void {
  const full = join(tmp, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-import-metafile-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('collectSyncableFiles metafile exclusion (closes #345)', () => {
  function seed(): void {
    write('people/example-person.md', '# Example Person\n');
    write('people/README.md', '# People\n\nOne page per person.\n');
    write('companies/README.md', '# Companies\n');
    write('README.md', '# Brain\n');
    write('index.md', '# Brain Index\n');
    write('log.md', '# Brain Log\n');
    write('schema.md', '# Brain Schema\n');
    write('RESOLVER.md', '# Brain Resolver\n');
  }

  test('FS-walk path excludes README/index/log/schema/RESOLVER, keeps real pages', () => {
    seed();
    const got = collectSyncableFiles(tmp).map(f => basename(f));
    expect(got).toContain('example-person.md');
    for (const meta of ['README.md', 'index.md', 'log.md', 'schema.md', 'RESOLVER.md']) {
      expect(got).not.toContain(meta);
    }
  });

  test('git-fast-path also excludes metafiles', () => {
    seed();
    execFileSync('git', ['-C', tmp, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', tmp, 'add', '-A'], { stdio: 'ignore' });
    const got = collectSyncableFiles(tmp).map(f => basename(f));
    expect(got).toContain('example-person.md');
    expect(got.filter(n => n === 'README.md')).toHaveLength(0);
    expect(got).not.toContain('index.md');
    expect(got).not.toContain('log.md');
    expect(got).not.toContain('schema.md');
    expect(got).not.toContain('RESOLVER.md');
  });
});
