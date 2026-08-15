/**
 * v0.37.0 (D9 / D4) — dream cycle hook: synthesize phase MUST skip pages
 * with `mode: lsd` frontmatter (noise-by-design). Pinned via the same
 * `isDreamOutput` helper that drives the self-consumption guard.
 */

import { describe, test, expect } from 'bun:test';
import {
  isDreamOutput,
  isLsdOutput,
  isBrainstormOutput,
} from '../../src/core/cycle/transcript-discovery.ts';

const LSD_FRONTMATTER = `---
title: "LSD: why are AI coding tools converging on the same UX?"
mode: lsd
generated_at: 2026-05-19T12:00:00Z
question: "why are AI coding tools converging on the same UX?"
---

# Some inverted-judge idea here.
`;

const BRAINSTORM_FRONTMATTER = `---
title: "Brainstorm: lab automation"
mode: brainstorm
generated_at: 2026-05-19T12:00:00Z
question: "what's the bottleneck on lab automation?"
---

# Some defensible idea here.
`;

const DREAM_OUTPUT_FRONTMATTER = `---
title: "Dream: monthly synthesis"
dream_generated: true
dream_cycle_date: 2026-05-01
---

Body.
`;

const REGULAR_TRANSCRIPT = `# Some meeting transcript

Person A: We should talk about lab automation.
Person B: Agreed.
`;

describe('v0.37.0 — LSD frontmatter skip in dream-cycle', () => {
  test('LSD page is detected by isLsdOutput', () => {
    expect(isLsdOutput(LSD_FRONTMATTER)).toBe(true);
  });

  test('brainstorm page is NOT detected by isLsdOutput', () => {
    expect(isLsdOutput(BRAINSTORM_FRONTMATTER)).toBe(false);
  });

  test('regular transcript is NOT detected by isLsdOutput', () => {
    expect(isLsdOutput(REGULAR_TRANSCRIPT)).toBe(false);
  });

  test('brainstorm page is detected by isBrainstormOutput', () => {
    expect(isBrainstormOutput(BRAINSTORM_FRONTMATTER)).toBe(true);
  });

  test('LSD page is NOT detected by isBrainstormOutput', () => {
    expect(isBrainstormOutput(LSD_FRONTMATTER)).toBe(false);
  });

  test('isDreamOutput SKIPS LSD pages (D4 noise-by-design)', () => {
    expect(isDreamOutput(LSD_FRONTMATTER)).toBe(true);
  });

  test('isDreamOutput still skips legitimate dream output', () => {
    expect(isDreamOutput(DREAM_OUTPUT_FRONTMATTER)).toBe(true);
  });

  test('isDreamOutput does NOT skip brainstorm pages (they are user-validated content)', () => {
    expect(isDreamOutput(BRAINSTORM_FRONTMATTER)).toBe(false);
  });

  test('isDreamOutput does NOT skip regular transcripts', () => {
    expect(isDreamOutput(REGULAR_TRANSCRIPT)).toBe(false);
  });

  test('--unsafe-bypass-dream-guard does NOT bypass LSD skip', () => {
    // Bypass is for self-consumption recovery only; LSD must always be skipped.
    expect(isDreamOutput(LSD_FRONTMATTER, true)).toBe(true);
  });

  test('--unsafe-bypass-dream-guard DOES bypass dream output skip', () => {
    expect(isDreamOutput(DREAM_OUTPUT_FRONTMATTER, true)).toBe(false);
  });

  test('LSD marker tolerates double-quoted value', () => {
    const dq = LSD_FRONTMATTER.replace('mode: lsd', 'mode: "lsd"');
    expect(isLsdOutput(dq)).toBe(true);
  });

  test('LSD marker tolerates single-quoted value', () => {
    const sq = LSD_FRONTMATTER.replace('mode: lsd', "mode: 'lsd'");
    expect(isLsdOutput(sq)).toBe(true);
  });
});
