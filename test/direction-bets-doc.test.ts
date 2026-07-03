import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('Wave 4 direction bets documentation', () => {
  test('tracks D-1..D-5 as gated direction bets instead of immediate default behavior', () => {
    const doc = readFileSync(
      new URL('../docs/designs/2026-07-03-mbrain-direction-bets.md', import.meta.url),
      'utf-8',
    );

    for (const id of ['D-1', 'D-2', 'D-3', 'D-4', 'D-5']) {
      expect(doc).toContain(`## ${id}`);
    }

    expect(doc).toContain('Activation gate');
    expect(doc).toContain('No autonomous compiled-truth rewrite');
    expect(doc).toContain('EV-1');
    expect(doc).toContain('EV-2');
    expect(doc).toContain('SessionStart activation card');
  });
});
