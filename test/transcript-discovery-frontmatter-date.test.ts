/**
 * A transcript without a leading ISO date in its filename takes its date from
 * the frontmatter `date:` line, so synthesis names its notes after the meeting
 * day instead of the cycle day, and --date/--from/--to filters see it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverTranscripts, readSingleTranscript, transcriptDate } from '../src/core/cycle/transcript-discovery.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-fm-date-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const body = 'x'.repeat(3000);

describe('transcript date from frontmatter', () => {
  test('filename date wins; frontmatter date is the fallback; else null', () => {
    const fm = `---\ntitle: Weekly sync\ndate: '2026-08-13'\n---\n${body}`;
    expect(transcriptDate('2026-09-01-weekly-sync', fm)).toBe('2026-09-01');
    expect(transcriptDate('Weekly sync', fm)).toBe('2026-08-13');
    expect(transcriptDate('Weekly sync', `---\ntitle: x\n---\ndate: 2026-08-13\n${body}`)).toBeNull();
    expect(transcriptDate('Weekly sync', body)).toBeNull();
    expect(transcriptDate('Weekly sync', `---\ndate: [unclosed\n---\n${body}`)).toBeNull();
  });

  test('discovery and --input carry the frontmatter date and filter on it', () => {
    const file = join(tmpDir, 'Weekly sync.md');
    writeFileSync(file, `---\ndate: 2026-08-13\n---\n${body}`);
    writeFileSync(join(tmpDir, 'Undated notes.md'), body);

    const all = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(all.map(t => [t.basename, t.inferredDate])).toEqual([
      ['Undated notes', null],
      ['Weekly sync', '2026-08-13'],
    ]);
    expect(discoverTranscripts({ corpusDir: tmpDir, minChars: 1000, date: '2026-08-13' }).map(t => t.basename))
      .toEqual(['Weekly sync']);
    expect(discoverTranscripts({ corpusDir: tmpDir, minChars: 1000, from: '2026-09-01' })).toHaveLength(0);
    expect(readSingleTranscript(file, { minChars: 1000 })?.inferredDate).toBe('2026-08-13');
  });
});
