/**
 * serializeMarkdown is parseMarkdown's inverse for the timeline split. A body
 * that carries its own dated `## Timeline …` section (the enrich prompt
 * suggests `## Timeline highlights` for people) with an empty timeline must
 * parse back as written: without the sentinel, parse's bare-section fallback
 * (#2225) moved that section into the timeline, and every model-written page
 * like it was refused CONCEPT_REPUBLICATION_LOSSY by preserveCanonicalFences.
 * Pure (no engine). Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { preserveCanonicalFences } from '../src/core/cycle/concept-publication.ts';

const META = { type: 'person' as const, title: 'Alice Example', tags: [] };
const DATED = [
  '## Overview', '', 'Alice runs operations at WidgetCo. [Source: meetings/m1]', '',
  '## Timeline highlights', '', '- 2026-01-05: Joined WidgetCo. [Source: meetings/m1]', '- 2026-03-02: Led the launch. [Source: meetings/m2]',
].join('\n');
const FACTS = ['<!--- gbrain:facts:begin -->', '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Runs operations at WidgetCo | fact | 1.0 | world | high | 2026-01-05 |  | meetings/m1 |  |', '<!--- gbrain:facts:end -->'].join('\n');

describe('serializeMarkdown keeps a body-owned timeline section in the body', () => {
  test('a dated ## Timeline section with an empty timeline round-trips unchanged', () => {
    const parsed = parseMarkdown(serializeMarkdown({}, DATED, '', META), 'people/alice-example.md');
    expect(parsed.compiled_truth).toBe(DATED);
    expect(parsed.timeline).toBe('');
  });

  test('with a timeline, the body section stays in the body and the timeline stays the timeline', () => {
    const timeline = '- 2026-04-01 | meetings/m3 — Quarterly review';
    const parsed = parseMarkdown(serializeMarkdown({}, DATED, timeline, META), 'people/alice-example.md');
    expect(parsed.compiled_truth).toBe(DATED);
    expect(parsed.timeline).toBe(timeline);
  });

  test('a body with nothing timeline-shaped serializes exactly as before (no sentinel)', () => {
    const body = '## Overview\n\nAlice runs operations.\n\n## History\n\nShe started in design, then moved to operations.';
    const out = serializeMarkdown({}, body, '', META);
    expect(out).not.toContain('<!-- timeline -->');
    expect(out.endsWith(`\n\n${body}\n`)).toBe(true);
  });

  test('preserveCanonicalFences accepts a model body with a dated timeline section and carries the facts fence', () => {
    const page = { compiled_truth: `Stub.\n\n## Facts\n\n${FACTS}`, timeline: '' };
    const composed = preserveCanonicalFences(page, DATED);
    expect(composed).toContain('## Timeline highlights');
    expect(composed).toContain(FACTS);
    const parsed = parseMarkdown(serializeMarkdown({}, composed, '', META), 'people/alice-example.md');
    expect(parsed.compiled_truth).toBe(composed);
    expect(parsed.timeline).toBe('');
  });
});
