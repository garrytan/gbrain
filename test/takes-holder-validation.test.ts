/**
 * Validate v0.32 EXP-4 holder runtime grammar.
 *
 * Cross-modal eval (2026-05-10) scored attribution at 6.5/10. The #1 error
 * was holder/subject confusion — agents writing `holder=Garry` (capitalized),
 * `holder=people/Garry-Tan` (mixed case), or `holder=world/garry-tan`
 * (slug stuffed into world). Codex review #3 caught that the initial regex
 * (`[a-z0-9-]+`) would also warn on legitimate slugs like `companies/acme.io`
 * and `people/foo_bar` — it must reuse the actual SLUG_SEGMENT_PATTERN
 * (`[a-z0-9._-]`) from sync.ts.
 *
 * This file exercises:
 *   - HOLDER_REGEX and isValidHolder() in isolation
 *   - parseTakesFence end-to-end emission of TAKES_HOLDER_INVALID warnings
 *   - sync.classifyErrorCode regex coverage for TAKES_HOLDER_INVALID
 *   - SLUG_SEGMENT_PATTERN export from sync.ts (Codex #3 — single source)
 */
import { describe, test, expect } from 'bun:test';
import {
  isValidHolder,
  HOLDER_REGEX,
  parseTakesFence,
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from '../src/core/takes-fence.ts';
import { classifyErrorCode, SLUG_SEGMENT_PATTERN } from '../src/core/sync.ts';

describe('isValidHolder — canonical forms', () => {
  test('world is valid', () => {
    expect(isValidHolder('world')).toBe(true);
  });

  test('brain is valid', () => {
    expect(isValidHolder('brain')).toBe(true);
  });

  test('people/<slug> is valid', () => {
    expect(isValidHolder('people/garry-tan')).toBe(true);
    expect(isValidHolder('people/jared-friedman')).toBe(true);
  });

  test('companies/<slug> is valid', () => {
    expect(isValidHolder('companies/clipboard-health')).toBe(true);
  });

  test('codex #3: dots in slug are valid (companies/acme.io)', () => {
    expect(isValidHolder('companies/acme.io')).toBe(true);
  });

  test('codex #3: underscores in slug are valid (people/foo_bar)', () => {
    expect(isValidHolder('people/foo_bar')).toBe(true);
  });

  test('codex #3: dotted-version slugs are valid (notes/v1.0.0 shape)', () => {
    expect(isValidHolder('companies/v1.0.0')).toBe(true);
  });
});

describe('isValidHolder — legacy bare-slug form (v0.32 transition)', () => {
  test('bare lowercase identifier is allowed (production brains shipped this way)', () => {
    expect(isValidHolder('garry')).toBe(true);
    expect(isValidHolder('alice')).toBe(true);
  });

  test('bare slug with dot/underscore allowed', () => {
    expect(isValidHolder('foo.bar')).toBe(true);
    expect(isValidHolder('my_user')).toBe(true);
  });
});

describe('isValidHolder — eval-flagged error modes (caught)', () => {
  test('uppercase letters rejected', () => {
    expect(isValidHolder('Garry')).toBe(false);
    expect(isValidHolder('GARRY')).toBe(false);
  });

  test('mixed case in slug rejected', () => {
    expect(isValidHolder('people/Garry-Tan')).toBe(false);
    expect(isValidHolder('companies/Acme')).toBe(false);
  });

  test('slug stuffed into world rejected', () => {
    expect(isValidHolder('world/garry-tan')).toBe(false);
  });

  test('unrecognized prefix rejected', () => {
    expect(isValidHolder('users/garry')).toBe(false);
    expect(isValidHolder('agents/openclaw')).toBe(false);
  });

  test('whitespace-only rejected', () => {
    expect(isValidHolder(' ')).toBe(false);
    expect(isValidHolder('   ')).toBe(false);
  });

  test('empty string rejected', () => {
    expect(isValidHolder('')).toBe(false);
  });

  test('contains spaces rejected', () => {
    expect(isValidHolder('garry tan')).toBe(false);
    expect(isValidHolder('people/garry tan')).toBe(false);
  });

  test('contains forward-slash beyond namespace rejected', () => {
    expect(isValidHolder('people/garry/extra')).toBe(false);
  });
});

describe('HOLDER_REGEX export shape', () => {
  test('is a RegExp instance', () => {
    expect(HOLDER_REGEX).toBeInstanceOf(RegExp);
  });

  test('is anchored (does not match substrings)', () => {
    // The regex must use ^...$ so partial-match attacks like "world\nGarry"
    // don't slip through.
    expect(HOLDER_REGEX.test('world extra')).toBe(false);
    expect(HOLDER_REGEX.test('extra world')).toBe(false);
  });
});

describe('SLUG_SEGMENT_PATTERN — shared contract (Codex #3)', () => {
  test('exports the actual slugifySegment grammar', () => {
    // Pattern matches the same character class slugifySegment() keeps:
    // [a-z0-9._-]. Anchoring is up to consumers (HOLDER_REGEX wraps in ^...$).
    expect(SLUG_SEGMENT_PATTERN).toBeInstanceOf(RegExp);
    const m = 'garry-tan'.match(SLUG_SEGMENT_PATTERN);
    expect(m).not.toBeNull();
    expect(m![0]).toBe('garry-tan');
  });

  test('matches the strict subset that v0.32 holder validation expects', () => {
    // Sanity check: ensure HOLDER_REGEX uses SLUG_SEGMENT_PATTERN's source
    // (not a stricter invented copy). If this drifts, the test catches it.
    expect(HOLDER_REGEX.source).toContain(SLUG_SEGMENT_PATTERN.source);
  });
});

describe('parseTakesFence — TAKES_HOLDER_INVALID warning emission', () => {
  function bodyWithHolder(holder: string): string {
    return `## Takes\n\n${TAKES_FENCE_BEGIN}\n` +
      `| # | claim | kind | who | weight | since | source |\n` +
      `|---|-------|------|-----|--------|-------|--------|\n` +
      `| 1 | test claim | take | ${holder} | 0.5 | 2026-01 | manual |\n` +
      `${TAKES_FENCE_END}\n`;
  }

  test('valid canonical holder → no TAKES_HOLDER_INVALID warning', () => {
    const { takes, warnings } = parseTakesFence(bodyWithHolder('people/garry-tan'));
    expect(takes).toHaveLength(1);
    expect(warnings.some(w => w.includes('TAKES_HOLDER_INVALID'))).toBe(false);
  });

  test('legacy bare-slug → no TAKES_HOLDER_INVALID warning (v0.32 compat)', () => {
    const { takes, warnings } = parseTakesFence(bodyWithHolder('garry'));
    expect(takes).toHaveLength(1);
    expect(warnings.some(w => w.includes('TAKES_HOLDER_INVALID'))).toBe(false);
  });

  test('uppercase holder → warning emitted, row preserved', () => {
    const { takes, warnings } = parseTakesFence(bodyWithHolder('Garry'));
    expect(takes).toHaveLength(1); // Codex #4 — markdown source-of-truth: row preserved
    expect(takes[0].holder).toBe('Garry'); // raw value retained
    const holderWarn = warnings.find(w => w.includes('TAKES_HOLDER_INVALID'));
    expect(holderWarn).toBeDefined();
    expect(holderWarn).toContain('"Garry"');
  });

  test('world/garry-tan → warning emitted', () => {
    const { warnings } = parseTakesFence(bodyWithHolder('world/garry-tan'));
    const holderWarn = warnings.find(w => w.includes('TAKES_HOLDER_INVALID'));
    expect(holderWarn).toBeDefined();
    expect(holderWarn).toContain('"world/garry-tan"');
  });

  test('users/garry → warning emitted', () => {
    const { warnings } = parseTakesFence(bodyWithHolder('users/garry'));
    const holderWarn = warnings.find(w => w.includes('TAKES_HOLDER_INVALID'));
    expect(holderWarn).toBeDefined();
  });
});

describe('classifyErrorCode — TAKES_HOLDER_INVALID coverage', () => {
  test('matches the literal token', () => {
    expect(classifyErrorCode('TAKES_HOLDER_INVALID: "Garry" in row 1')).toBe('TAKES_HOLDER_INVALID');
  });

  test('case-insensitive', () => {
    expect(classifyErrorCode('takes_holder_invalid: bad value')).toBe('TAKES_HOLDER_INVALID');
  });

  test('does not collide with TAKES_TABLE_MALFORMED', () => {
    expect(classifyErrorCode('TAKES_TABLE_MALFORMED: only 4 cells')).toBe('TAKES_TABLE_MALFORMED');
    expect(classifyErrorCode('TAKES_HOLDER_INVALID: bad')).toBe('TAKES_HOLDER_INVALID');
  });

  test('TAKES_ROW_NUM_COLLISION still classifies as TAKES_TABLE_MALFORMED bucket', () => {
    expect(classifyErrorCode('TAKES_ROW_NUM_COLLISION: duplicate row_num 3')).toBe('TAKES_TABLE_MALFORMED');
  });

  test('unrelated error message falls through to UNKNOWN', () => {
    expect(classifyErrorCode('something else entirely')).toBe('UNKNOWN');
  });
});
