/**
 * v0.42.x — Life Chronicle (#2390) quick-capture (Phase A.5).
 * Pure-function tests for the type-routed default slug and the --type event
 * frontmatter sugar. No engine needed.
 */
import { describe, test, expect } from 'bun:test';
import matter from 'gray-matter';
import { __testing } from '../src/commands/capture.ts';
const { defaultSlug, mergeCaptureFrontmatter } = __testing;

const FIXED = new Date('2026-06-18T00:00:00Z');

describe('defaultSlug type routing', () => {
  test('diary → life/diary/', () => {
    expect(defaultSlug('a private thought', FIXED, 'diary')).toMatch(/^life\/diary\/2026-06-18-[0-9a-f]{8}$/);
  });
  test('event → life/events/', () => {
    expect(defaultSlug('an event', FIXED, 'event')).toMatch(/^life\/events\/2026-06-18-[0-9a-f]{8}$/);
  });
  test('note / default → inbox/', () => {
    expect(defaultSlug('a note', FIXED, 'note')).toMatch(/^inbox\/2026-06-18-[0-9a-f]{8}$/);
    expect(defaultSlug('a note', FIXED)).toMatch(/^inbox\//);
  });
});

describe('--type event frontmatter sugar', () => {
  test('builds the event block from flags', () => {
    const out = mergeCaptureFrontmatter('Sarah committed to Q3', {
      type: 'event', who: 'people/sarah-chen,people/bob', what: 'committed to Q3',
      where: 'Zoom', kind: 'commitment', depth: 'meetings/2026-06-18-sync',
    });
    const fm = matter(out).data as Record<string, any>;
    expect(fm.type).toBe('event');
    expect(fm.event.who).toEqual(['people/sarah-chen', 'people/bob']);
    expect(fm.event.what).toBe('committed to Q3');
    expect(fm.event.kind).toBe('commitment');
    expect(fm.event.depth).toBe('meetings/2026-06-18-sync');
  });

  test('non-event capture gets no event block', () => {
    const fm = matter(mergeCaptureFrontmatter('just a note', { type: 'note' })).data as Record<string, any>;
    expect(fm.event).toBeUndefined();
  });

  test('diary capture is typed diary, no event block', () => {
    const fm = matter(mergeCaptureFrontmatter('felt uncertain today', { type: 'diary' })).data as Record<string, any>;
    expect(fm.type).toBe('diary');
    expect(fm.event).toBeUndefined();
  });

  test('user-declared event keys win over flags (per-key merge)', () => {
    const body = `---\ntype: event\nevent:\n  kind: decision\n---\nbody`;
    const fm = matter(mergeCaptureFrontmatter(body, { type: 'event', kind: 'commitment', what: 'x' })).data as Record<string, any>;
    expect(fm.event.kind).toBe('decision'); // user wins
    expect(fm.event.what).toBe('x');        // flag fills the gap
  });
});
