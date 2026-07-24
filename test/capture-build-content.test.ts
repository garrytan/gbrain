/**
 * v0.39.3.0 BUG-1: capture --file doubles frontmatter on files that
 * already have frontmatter. The fix replaces buildContent's
 * always-prepend behavior with a gray-matter-backed merge that user-wins
 * for declared keys.
 *
 * These tests pin the merge contract per CQ2 (boil-the-lake, 13 cases).
 * Each test feeds a known input through `mergeCaptureFrontmatter` and
 * asserts the resulting frontmatter + body shape. We round-trip via
 * gray-matter's `matter()` parser so assertions are against the parsed
 * shape rather than fragile string-equality.
 */

import { describe, test, expect } from 'bun:test';
import matter from 'gray-matter';
import { __testing as captureTesting } from '../src/commands/capture.ts';

const { mergeCaptureFrontmatter, deriveTitle } = captureTesting;

function parse(out: string) {
  const m = matter(out);
  return { fm: m.data as Record<string, unknown>, body: m.content };
}

describe('mergeCaptureFrontmatter — 13 cases (CQ2 boil-the-lake)', () => {
  test('1. file without frontmatter wraps as today (no regression)', () => {
    const input = 'remember to follow up';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm, body } = parse(out);
    expect(fm.type).toBe('note');
    expect(fm.title).toBe('remember to follow up');
    expect(fm.captured_via).toBe('capture-cli');
    expect(typeof fm.captured_at).toBe('string');
    // Body wrapped under derived heading since input lacks markdown structure
    expect(body).toContain('# remember to follow up');
    expect(body).toContain('remember to follow up');
    // EXACTLY one frontmatter block (regression for BUG-1).
    // Split on `^---$` boundary: a single block yields 3 segments
    // (pre-opening empty, fm body, after-closing body); two blocks yield 5.
    expect(out.split(/^---\s*$/m).length).toBe(3);
  });

  test('2. file with frontmatter and no title — capture derives title from body', () => {
    const input = '---\ntype: meeting\n---\n\nNotes from the team sync\n\nMore stuff';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm, body } = parse(out);
    expect(fm.type).toBe('meeting'); // user's type preserved
    expect(fm.title).toBe('Notes from the team sync'); // derived from body
    expect(body.trim()).toContain('Notes from the team sync');
    // Single frontmatter block
    const blocks = out.match(/^---\s*$/gm);
    expect(blocks?.length).toBe(2); // opening + closing
  });

  test('3. file with frontmatter that has title — user title wins', () => {
    const input = '---\ntitle: User Defined Title\ntype: idea\n---\n\nbody text';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    expect(fm.title).toBe('User Defined Title');
    expect(fm.type).toBe('idea');
  });

  test('4. file with captured_at — user value wins (NOT overwritten by now)', () => {
    const userTs = '2020-01-01T00:00:00.000Z';
    const input = `---\ncaptured_at: ${userTs}\ntype: note\n---\n\nbody`;
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    // gray-matter's YAML parser auto-coerces ISO timestamps to Date objects.
    // Compare via .toISOString() so the contract holds across either shape.
    const got = fm.captured_at;
    const gotIso = got instanceof Date ? got.toISOString() : String(got);
    expect(gotIso).toBe(userTs);
  });

  test('5. frontmatter + body-side horizontal rule — TOP frontmatter merged, rule preserved', () => {
    const input = '---\ntitle: Top\n---\n\nfirst section\n\n---\n\nsecond section';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm, body } = parse(out);
    expect(fm.title).toBe('Top');
    // The body-side `---` horizontal rule must survive intact
    expect(body).toContain('first section');
    expect(body).toContain('---');
    expect(body).toContain('second section');
  });

  test('6. title extraction never picks `---` as the title', () => {
    // No-frontmatter path: deriveTitle skips `---` lines
    expect(deriveTitle('---\n\nreal first line')).toBe('real first line');
    // Bare `---` followed by content
    expect(deriveTitle('---\n# heading\nrest')).toBe('heading');
    // Only `---` and blanks → falls back to 'Capture'
    expect(deriveTitle('---\n---\n')).toBe('Capture');
  });

  test('7. CJK title preserved through merge', () => {
    const input = '---\ntitle: 測試 brain entry\n---\n\nbody';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    expect(fm.title).toBe('測試 brain entry');
  });

  test('8. Windows CRLF line endings in frontmatter preserved', () => {
    const input = '---\r\ntype: meeting\r\ntitle: CRLF Test\r\n---\r\n\r\nbody line\r\n';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    expect(fm.type).toBe('meeting');
    expect(fm.title).toBe('CRLF Test');
  });

  test('9. UTF-8 BOM at start handled cleanly', () => {
    const input = '﻿---\ntitle: BOM Test\n---\n\nbody';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    expect(fm.title).toBe('BOM Test');
    // Output should not contain doubled frontmatter blocks (single block = 3 split segments)
    expect(out.split(/^---\s*$/m).length).toBe(3);
  });

  test('10. empty frontmatter ---\\n---\\n merged with auto-fields', () => {
    const input = '---\n---\n\nbody content';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    expect(fm.type).toBe('note'); // auto-filled
    expect(fm.title).toBe('body content'); // derived
    expect(fm.captured_via).toBe('capture-cli'); // auto-filled
  });

  test('11. malformed YAML in frontmatter throws (no silent half-merge)', () => {
    // gray-matter parses { foo: : invalid } as throwing YAML
    const input = '---\nfoo: : :::\nbar: [unclosed\n---\n\nbody';
    expect(() => mergeCaptureFrontmatter(input, {})).toThrow(/malformed frontmatter/);
  });

  test('12. no trailing newline before body', () => {
    const input = '---\ntitle: Tight\n---\nbody right after';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm, body } = parse(out);
    expect(fm.title).toBe('Tight');
    expect(body.trim()).toContain('body right after');
  });

  test('13. user description/tags/slug pass through verbatim', () => {
    const input = `---
type: meeting
title: Standup
description: weekly engineering sync
tags: [work, weekly]
slug: meetings/2026-05-22
---

Notes from the sync`;
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    expect(fm.description).toBe('weekly engineering sync');
    expect(fm.tags).toEqual(['work', 'weekly']);
    expect(fm.slug).toBe('meetings/2026-05-22');
    expect(fm.title).toBe('Standup'); // user wins
    expect(fm.type).toBe('meeting'); // user wins (no --type override)
  });

  // BUG-1 regression guard: the exact reported failure shape
  test('REGRESSION (BUG-1): file with `---` opening never produces title: "---"', () => {
    const input = '---\ntitle: Pre-existing Title\ntags: [test, frontmatter]\n---\n\n# Pre-existing content\n\nbody';
    const out = mergeCaptureFrontmatter(input, {});
    const { fm } = parse(out);
    expect(fm.title).toBe('Pre-existing Title');
    expect(fm.title).not.toBe('---');
    // Critically: only one frontmatter block (not two stacked) — split yields 3 segments
    expect(out.split(/^---\s*$/m).length).toBe(3);
  });

  // CLI --type flag precedence (per plan: CLI flag > userFm > 'note')
  test('--type CLI flag wins over user frontmatter type', () => {
    const input = '---\ntype: meeting\ntitle: X\n---\n\nbody';
    const out = mergeCaptureFrontmatter(input, { type: 'observation' });
    const { fm } = parse(out);
    expect(fm.type).toBe('observation');
  });

  test('--type CLI flag wins over default note in no-frontmatter path', () => {
    const out = mergeCaptureFrontmatter('plain text', { type: 'idea' });
    const { fm } = parse(out);
    expect(fm.type).toBe('idea');
  });
});

describe('deriveTitle (no-frontmatter path)', () => {
  test('strips leading # markers', () => {
    expect(deriveTitle('# A heading\nrest')).toBe('A heading');
    expect(deriveTitle('### Triple hash\nrest')).toBe('Triple hash');
  });

  test('caps at 80 chars with explicit ellipsis', () => {
    const long = 'a'.repeat(120);
    expect(deriveTitle(long)).toBe('a'.repeat(79) + '…');
    expect([...deriveTitle(long)].length).toBe(80);
  });

  test('exactly 80 chars is not truncated', () => {
    const exact = 'a'.repeat(80);
    expect(deriveTitle(exact)).toBe(exact);
  });

  test('does not split astral Unicode while truncating', () => {
    const title = deriveTitle('😀'.repeat(120));
    expect(title.endsWith('…')).toBe(true);
    expect([...title].length).toBe(80);
    // No lone surrogate halves left behind by the cut.
    expect([...title].some((ch) => ch.length === 1 && /[\uD800-\uDFFF]/.test(ch))).toBe(false);
  });

  test('falls back to Capture for empty input', () => {
    expect(deriveTitle('')).toBe('Capture');
    expect(deriveTitle('\n\n  \n')).toBe('Capture');
  });
});
