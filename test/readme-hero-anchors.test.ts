/**
 * v0.36.0.0 (D9) — README hero anchor regression test.
 *
 * Pins load-bearing strings in the first ~50 lines of README.md so future
 * "cleanup" PRs can't silently drop the headline framing or the
 * OpenClaw/Hermes credit. The anchors are intentionally NARROW (substrings,
 * not full hero text) so legitimate voice/structure edits don't fight the
 * test.
 *
 * If this test fails, ask: did we deliberately rotate the headline?
 *   - If yes: update the anchors here AND in the corresponding plan/spec.
 *   - If no: the README rewrite dropped something it shouldn't have.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('README hero anchors (D9 regression guard)', () => {
  const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
  // First 50 lines is enough headroom for hero + first sub-section.
  const hero = readme.split('\n').slice(0, 50).join('\n');

  test('mentions OpenClaw (the public agent platform credit)', () => {
    expect(hero).toContain('OpenClaw');
  });

  test('mentions Hermes (the public agent platform credit)', () => {
    expect(hero).toContain('Hermes');
  });

  test('leads with controlled memory and the two distinct setup paths', () => {
    // The accepted harness onboarding plan deliberately rotates the headline.
    // Keep the primary local path ahead of the separate hosted connection.
    expect(hero).toContain('Give the agent you already use a memory you control');
    expect(hero).toContain('facts with their sources');
    expect(hero.indexOf('Add GBrain to my existing agent')).toBeLessThan(
      hero.indexOf('Connect my existing hosted brain'),
    );
    expect(hero).toContain('Start with keyless memory');
  });

  test('includes at least one production number (pages/people/companies)', () => {
    // Matches "17,888 pages", "4,383 people", "723 companies" style.
    expect(hero).toMatch(/\d{1,3},?\d{3}\s+(pages|people|companies)/i);
  });

  test('includes BrainBench framing (P@5 or R@5)', () => {
    // Either P@5 or R@5 anchors the retrieval-eval credibility story.
    expect(hero).toMatch(/P@5|R@5/);
  });
});
