/**
 * explicitCaptureType (#4655) — the ONE function that decides which page
 * type the write-time vocabulary check inspects. Edges the capture-op /
 * capture-CLI negative tests do not reach:
 *   - the explicit --type / type param beats a frontmatter type
 *   - BOM + CRLF frontmatter is still recognized
 *   - malformed YAML → undefined (mergeCaptureFrontmatter surfaces the error
 *     downstream unchanged; the vocabulary check must not double-report it)
 *   - non-string / empty `type:` → undefined (the default-'note' path is
 *     deliberately never a vocabulary-check target)
 *   - no frontmatter at all → undefined
 */

import { describe, expect, test } from 'bun:test';
import { explicitCaptureType } from '../src/core/capture-content.ts';

describe('explicitCaptureType', () => {
  test('an explicit --type / type param beats the frontmatter type', () => {
    expect(explicitCaptureType('---\ntype: meeting\n---\nbody', 'diary')).toBe('diary');
  });

  test('an EMPTY explicit param does not win — falls through to frontmatter', () => {
    expect(explicitCaptureType('---\ntype: meeting\n---\nbody', '')).toBe('meeting');
  });

  test('falls back to a non-empty string frontmatter type', () => {
    expect(explicitCaptureType('---\ntype: meeting\ntitle: Standup\n---\nbody')).toBe('meeting');
  });

  test('BOM + CRLF frontmatter is still recognized', () => {
    expect(explicitCaptureType('﻿---\r\ntype: meeting\r\ntitle: x\r\n---\r\nbody\r\n')).toBe('meeting');
  });

  test('malformed YAML → undefined (never throws)', () => {
    expect(explicitCaptureType('---\ntype: [unclosed\n---\nbody')).toBeUndefined();
    expect(explicitCaptureType('---\n: :\n  - broken: [\n---\nbody')).toBeUndefined();
  });

  test('non-string or empty `type:` → undefined (default-note path, never vocabulary-checked)', () => {
    expect(explicitCaptureType('---\ntype: 42\n---\nbody')).toBeUndefined();
    expect(explicitCaptureType("---\ntype: ''\n---\nbody")).toBeUndefined();
    expect(explicitCaptureType('---\ntype:\n---\nbody')).toBeUndefined();
    expect(explicitCaptureType('---\ntype: [a, b]\n---\nbody')).toBeUndefined();
  });

  test('no frontmatter → undefined', () => {
    expect(explicitCaptureType('Just a body.\n')).toBeUndefined();
    expect(explicitCaptureType('')).toBeUndefined();
    // A frontmatter-looking block that is not at the very start is body text.
    expect(explicitCaptureType('body first\n---\ntype: x\n---\n')).toBeUndefined();
  });
});
