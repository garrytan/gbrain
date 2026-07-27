// v0.39 T1.5 — engine wiring regression test.
//
// Asserts that the `activePack` parameter threaded through parseMarkdown
// actually CHANGES type inference at runtime, while preserving byte-for-byte
// parity with the gbrain-base hardcoded behavior when no pack is passed.
//
// Pinned by codex finding #1 (engine inert at runtime is the central v0.38
// gap). Without this test, T1.5's API additions could be silently
// no-op'd by a future caller that forgets to thread the pack.

import { describe, test, expect } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';

describe('v0.39 T1.5 — parseMarkdown activePack threading', () => {
  test('no activePack passed → falls back to legacy inferType (gbrain-base parity)', () => {
    const result = parseMarkdown('# Alice', 'people/alice.md');
    expect(result.type).toBe('person');
  });

  test('activePack with custom type → uses pack inference (NOT legacy)', () => {
    // Synthetic pack that maps `Projects/` → `project-x` (a type that does NOT
    // exist in gbrain-base — proves the pack drives, not the hardcoded table).
    const result = parseMarkdown('# my project', 'Projects/foo.md', {
      activePack: {
        page_types: [
          { name: 'project-x', path_prefixes: ['Projects/'] },
        ],
      },
    });
    expect(result.type).toBe('project-x');
  });

  test('activePack empty → falls back to gbrain-base hardcoded', () => {
    const result = parseMarkdown('# alice', 'people/alice.md', {
      activePack: { page_types: [] },
    });
    expect(result.type).toBe('person');
  });

  test('frontmatter type wins over activePack inference', () => {
    const result = parseMarkdown(
      '---\ntype: meeting\n---\n# x',
      'people/alice.md',
      {
        activePack: {
          page_types: [{ name: 'person', path_prefixes: ['people/'] }],
        },
      },
    );
    expect(result.type).toBe('meeting');
  });

  test('Persona A scenario: Notion-shape paths get typed via active pack', () => {
    // Notion refugee imports `Projects/`, `Reading/`, `Daily Notes/`.
    // With activePack threading, these get correct types instead of `concept`.
    const pack = {
      page_types: [
        { name: 'project', path_prefixes: ['Projects/'] },
        { name: 'reading-note', path_prefixes: ['Reading/'] },
        { name: 'daily-note', path_prefixes: ['Daily Notes/'] },
      ],
    };
    expect(parseMarkdown('x', 'Projects/p1.md', { activePack: pack }).type).toBe('project');
    expect(parseMarkdown('x', 'Reading/a1.md', { activePack: pack }).type).toBe('reading-note');
    expect(parseMarkdown('x', 'Daily Notes/today.md', { activePack: pack }).type).toBe('daily-note');
    // Unmapped path falls back to `concept`.
    expect(parseMarkdown('x', 'Other/foo.md', { activePack: pack }).type).toBe('concept');
  });
});
