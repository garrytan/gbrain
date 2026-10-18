/**
 * #6696 C7: `matchesRepairPath`, the `--only` / `--skip` matcher of `gbrain repair file-drift`. A value with no `*` keeps
 * exact-path semantics (the other repair kinds' `--only`); only a value with `*` is a glob.
 */
import { describe, expect, test } from 'bun:test';
import { matchesRepairPath } from '../src/core/repair/path-glob.ts';

describe('matchesRepairPath', () => {
  test('a value without * is an exact path, even when it holds other glob characters', () => {
    expect(matchesRepairPath('concepts/agi.md', ['concepts/agi.md'])).toBe(true);
    expect(matchesRepairPath('concepts/agi.md', ['concepts/agi'])).toBe(false);
    expect(matchesRepairPath('concepts/agi.md', ['concepts'])).toBe(false);
    expect(matchesRepairPath('concepts/ab.md', ['concepts/a?.md'])).toBe(false);
    expect(matchesRepairPath('concepts/a?.md', ['concepts/a?.md'])).toBe(true);
  });

  test('* matches within one segment and ** across segments', () => {
    expect(matchesRepairPath('concepts/agi.md', ['concepts/*'])).toBe(true);
    expect(matchesRepairPath('concepts/deep/agi.md', ['concepts/*'])).toBe(false);
    expect(matchesRepairPath('concepts/deep/agi.md', ['concepts/**'])).toBe(true);
    expect(matchesRepairPath('people/alice-example.md', ['concepts/**'])).toBe(false);
    expect(matchesRepairPath('people/alice-example.md', undefined)).toBe(false);
  });
});
