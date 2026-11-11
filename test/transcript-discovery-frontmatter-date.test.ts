/**
 * #7267: a transcript whose filename has no leading YYYY-MM-DD is dated by
 * its frontmatter `date:`, so synthesis names and dates its notes after the
 * day the conversation happened instead of the day the cycle ran, and the
 * --date/--from/--to window sees that date. A filename date still wins, and
 * an impossible calendar day or unreadable frontmatter counts as no date.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverTranscripts, readSingleTranscript } from '../src/core/cycle/transcript-discovery.ts';

const body = 'alice-example and bob-example review the launch checklist. '.repeat(60);
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-fm-date-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function dated(): Map<string, string | null> {
  return new Map(discoverTranscripts({ corpusDir: dir, minChars: 1000 }).map(t => [t.basename, t.inferredDate]));
}

describe('#7267 transcript date from frontmatter', () => {
  test('an undated filename takes the frontmatter date, in discovery and --input', () => {
    const file = join(dir, 'Weekly sync.md');
    writeFileSync(file, `---\ndate: 2026-08-13\n---\n${body}`);
    writeFileSync(join(dir, 'Quoted date.md'), `---\ntitle: Planning\ndate: '2026-08-14T15:00:00Z'\n---\n${body}`);
    expect(dated().get('Weekly sync')).toBe('2026-08-13');
    expect(dated().get('Quoted date')).toBe('2026-08-14');
    expect(readSingleTranscript(file, { minChars: 1000 })?.inferredDate).toBe('2026-08-13');
  });

  test('a filename date wins over the frontmatter date', () => {
    writeFileSync(join(dir, '2026-09-01-standup.md'), `---\ndate: 2026-08-13\n---\n${body}`);
    expect(dated().get('2026-09-01-standup')).toBe('2026-09-01');
  });

  test('no date, an impossible day, a body-only date line or malformed frontmatter stays undated', () => {
    writeFileSync(join(dir, 'No date.txt'), body);
    writeFileSync(join(dir, 'Impossible day.md'), `---\ndate: 2026-02-30\n---\n${body}`);
    writeFileSync(join(dir, 'Body line.md'), `---\ntitle: Notes\n---\ndate: 2026-08-13\n${body}`);
    writeFileSync(join(dir, 'Malformed.md'), `---\ndate: [unclosed\n---\n${body}`);
    writeFileSync(join(dir, 'Header.txt'), `--- BEGIN TRANSCRIPT\n${body}`);
    expect([...dated().entries()].sort()).toEqual([
      ['Body line', null], ['Header', null], ['Impossible day', null], ['Malformed', null], ['No date', null],
    ]);
  });

  test('the date window filters on the frontmatter date', () => {
    writeFileSync(join(dir, 'Weekly sync.md'), `---\ndate: 2026-08-13\n---\n${body}`);
    writeFileSync(join(dir, 'Undated.md'), body);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 1000, date: '2026-08-13' }).map(t => t.basename)).toEqual(['Weekly sync']);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 1000, from: '2026-08-01', to: '2026-08-31' }).map(t => t.basename)).toEqual(['Weekly sync']);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 1000, from: '2026-09-01' })).toEqual([]);
  });
});
