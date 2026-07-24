import { describe, expect, test } from 'bun:test';
import { stripGapsSection } from '../src/core/think/index.ts';
import { buildThinkSystemPrompt } from '../src/core/think/prompt.ts';

// `gbrain think` returns gaps in the structured `gaps` array, which both the
// CLI (`src/commands/think.ts`) and the persisted synthesis page
// (`persistSynthesis`) render exactly once. Older prompts also asked for a
// "Gaps" section inside the answer prose, so a model that still emits one made
// the output print "## Gaps" twice. `stripGapsSection` removes the prose
// section so the structured array is the single source of truth.

describe('stripGapsSection', () => {
  test('removes a trailing "## Gaps" section', () => {
    const answer = 'The answer with a claim [people/alice].\n\n## Gaps\n- no update since 2026-03-22 [projects/acme]\n- pricing not recorded';
    const out = stripGapsSection(answer);
    expect(out).not.toContain('## Gaps');
    expect(out).not.toContain('no update since');
    expect(out).toContain('The answer with a claim [people/alice].');
  });

  test('removes a level-3 "### Gaps" section', () => {
    const out = stripGapsSection('Body text.\n\n### Gaps\n- missing thing');
    expect(out).not.toMatch(/#+\s+Gaps/i);
    expect(out).toBe('Body text.');
  });

  test('is case-insensitive', () => {
    expect(stripGapsSection('Body.\n\n## GAPS\n- x')).toBe('Body.');
    expect(stripGapsSection('Body.\n\n## gaps\n- x')).toBe('Body.');
  });

  test('returns the answer unchanged when there is no Gaps section', () => {
    const answer = 'Just an answer.\n\n## Conflicts\n- a vs b';
    expect(stripGapsSection(answer)).toBe(answer);
  });

  test('does not match a heading that merely starts with "Gaps"', () => {
    const answer = 'Body.\n\n## Gaps in the coverage\n- this is real content';
    expect(stripGapsSection(answer)).toBe(answer);
  });

  test('stops at the next same-or-higher heading (preserves later content)', () => {
    const answer = 'Intro.\n\n## Gaps\n- missing x\n\n## Sources\n- [a]';
    const out = stripGapsSection(answer);
    expect(out).not.toContain('missing x');
    expect(out).toContain('## Sources');
    expect(out).toContain('- [a]');
  });

  test('handles empty / falsy input', () => {
    expect(stripGapsSection('')).toBe('');
  });

  test('the bug repro: strip + structured render yields exactly one "## Gaps"', () => {
    // Mirrors the render in src/commands/think.ts: print the (stripped) answer,
    // then append one "## Gaps" block from the structured `gaps` array.
    const answer = 'Answer prose [people/alice].\n\n## Gaps\n- the prose gap, slightly different wording';
    const gaps = ['the structured gap'];
    const rendered =
      stripGapsSection(answer) + '\n\n## Gaps\n' + gaps.map((g) => `- ${g}`).join('\n');
    expect((rendered.match(/## Gaps/g) ?? []).length).toBe(1);
    expect(rendered).toContain('the structured gap');
  });
});

describe('buildThinkSystemPrompt — gaps go in the structured array, not the answer body', () => {
  test('the answer schema no longer lists "Gaps" as a body section', () => {
    const out = buildThinkSystemPrompt({});
    expect(out).not.toContain('Sections: Answer, Conflicts (optional), Gaps');
    expect(out).toContain('gaps belong in the gaps array');
  });

  test('still requires the structured "gaps" array', () => {
    const out = buildThinkSystemPrompt({});
    expect(out).toContain('"gaps"');
  });

  test('preserves the Conflicts section and the Hard rules', () => {
    const out = buildThinkSystemPrompt({});
    expect(out).toContain('Conflicts');
    expect(out).toContain('Hard rules:');
    expect(out).toContain('Cite EVERY substantive claim');
  });

  test('willSave mode routes gaps to the structured array (no body Gaps section)', () => {
    const out = buildThinkSystemPrompt({ willSave: true });
    expect(out).not.toContain('cover Answer, Conflicts, and Gaps thoroughly');
    expect(out).toContain('structured "gaps" array');
  });
});
