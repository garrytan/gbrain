/**
 * v0.43 (#2095) — formatResult's volunteer_context human rendering
 * (ship coverage G3): pointer lines with confidence/arm/rationale,
 * the empty-result message, and the approximate stats summary.
 */
import { describe, test, expect } from 'bun:test';
import { formatResult } from '../src/cli.ts';

describe('formatResult — volunteer_context', () => {
  test('renders pointer lines with confidence, arm, rationale, and synopsis', () => {
    const out = formatResult('volunteer_context', {
      pages: [
        {
          slug: 'people/alice-example',
          source_id: 'default',
          display: 'Alice Example',
          confidence: 0.85,
          arm: 'title',
          rationale: 'exact title match "Alice Example"; mentioned in the newest turn',
          synopsis: 'Alice is an early founder.',
        },
      ],
      count: 1,
      window_turns: 3,
    });
    expect(out).toContain('Alice Example → people/alice-example (0.85, title)');
    expect(out).toContain('exact title match');
    expect(out).toContain('Alice is an early founder.');
  });

  test('empty result explains the confidence gate', () => {
    const out = formatResult('volunteer_context', { pages: [], count: 0, window_turns: 1 });
    expect(out).toContain('Nothing volunteered');
    expect(out).toContain('confidence gate');
  });

  test('stats mode renders totals, per-arm precision, and the approximate note', () => {
    const out = formatResult('volunteer_context', {
      days: 30,
      approximate: true,
      note: 'approximate: "used" = pages.last_retrieved_at > volunteered_at.',
      total_volunteered: 4,
      total_used: 3,
      by_arm: [
        { match_arm: 'alias', channel: 'reflex', volunteered: 2, used: 2, precision: 1 },
        { match_arm: 'title', channel: 'op', volunteered: 2, used: 1, precision: 0.5 },
      ],
    });
    expect(out).toContain('last 30 day(s)');
    expect(out).toContain('approximate');
    expect(out).toContain('total: 4 volunteered, 3 used');
    expect(out).toContain('alias/reflex: 2/2 used (precision 1)');
    expect(out).toContain('title/op: 1/2 used (precision 0.5)');
  });

  test('stats mode with zero events prints the empty-window line', () => {
    const out = formatResult('volunteer_context', {
      days: 7,
      approximate: true,
      note: 'approximate',
      total_volunteered: 0,
      total_used: 0,
      by_arm: [],
    });
    expect(out).toContain('no volunteer events in the window');
  });
});
