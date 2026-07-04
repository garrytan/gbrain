import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findSupersededByTargetGaps, runBacklinks } from '../src/commands/backlinks.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('check-backlinks superseded_by validation', () => {
  test('reports dangling superseded_by targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-backlinks-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'concepts'), { recursive: true });
    writeFileSync(join(root, 'concepts', 'old-memory.md'), [
      '---',
      'title: Old Memory',
      'type: concept',
      'created: 2026-07-04',
      'superseded_by: concepts/new-memory',
      '---',
      '',
      '# Old Memory',
      '',
      'Retired content.',
    ].join('\n'));

    expect(findSupersededByTargetGaps(root)).toEqual([{
      sourcePage: 'concepts/old-memory.md',
      targetSlug: 'concepts/new-memory',
    }]);

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      await runBacklinks(['check', '--dir', root]);
    } finally {
      console.log = originalLog;
    }

    expect(lines.join('\n')).toContain('dangling superseded_by target');
    expect(lines.join('\n')).toContain('concepts/old-memory.md superseded_by -> concepts/new-memory');
  });

  test('accepts existing superseded_by targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-backlinks-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'concepts'), { recursive: true });
    writeFileSync(join(root, 'concepts', 'old-memory.md'), [
      '---',
      'title: Old Memory',
      'type: concept',
      'created: 2026-07-04',
      'superseded_by: concepts/new-memory.md',
      '---',
      '',
      '# Old Memory',
      '',
      'Retired content.',
    ].join('\n'));
    writeFileSync(join(root, 'concepts', 'new-memory.md'), [
      '---',
      'title: New Memory',
      'type: concept',
      'created: 2026-07-04',
      '---',
      '',
      '# New Memory',
      '',
      'Current content.',
    ].join('\n'));

    expect(findSupersededByTargetGaps(root)).toEqual([]);
  });
});
