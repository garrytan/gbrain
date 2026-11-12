/**
 * #7738 — a compiled body that carries its own dated '## Timeline …' section
 * (enrich's person write-up asks for '## Timeline highlights') must round-trip
 * through serializeMarkdown/parseMarkdown unchanged when the page has no
 * timeline. Without a sentinel the bare-section fallback re-read that section
 * as the page timeline, so enrich refused its own paid write-up as lossy.
 * Bodies that never split keep their exact bytes.
 */
import { describe, test, expect } from 'bun:test';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { preserveCanonicalFences } from '../src/core/cycle/concept-publication.ts';
import { editableView } from '../src/core/persistence/page-edit.ts';
import { spliceTimelineBlock, spliceTimelineIntoFileText } from '../src/core/timeline-write-through.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';

const meta = { type: 'person' as const, title: 'Alice Example', tags: [] as string[] };

function roundTrip(compiled: string, timeline: string) {
  const parsed = parseMarkdown(serializeMarkdown({}, compiled, timeline, meta), 'people/alice-example.md');
  return { compiled_truth: parsed.compiled_truth, timeline: parsed.timeline };
}

describe('a body with its own dated timeline section round-trips (#7738)', () => {
  const body = '## Overview\nAlice Example works at Acme Example.\n\n## Timeline highlights\n- 2024-01-01: joined Acme Example\n- 2025-03-02: promoted';

  test('no page timeline: the section stays in compiled_truth', () => {
    expect(roundTrip(body, '')).toEqual({ compiled_truth: body, timeline: '' });
  });

  test('with a page timeline: both halves survive', () => {
    expect(roundTrip(body, '- 2026-01-01: met')).toEqual({ compiled_truth: body, timeline: '- 2026-01-01: met' });
  });

  test('a later unrelated section after the dated one also stays', () => {
    const withTail = body + '\n\n## Notes\nprose';
    expect(roundTrip(withTail, '')).toEqual({ compiled_truth: withTail, timeline: '' });
  });

  test('a body that would not split serializes byte for byte as before', () => {
    const plain = '## Overview\nprose\n\n## History\nThe company was founded long ago, in prose.';
    const out = serializeMarkdown({}, plain, '', meta);
    expect(out).not.toContain('<!-- timeline -->');
    expect(out.endsWith(plain + '\n')).toBe(true);
    expect(roundTrip(plain, '')).toEqual({ compiled_truth: plain, timeline: '' });
  });

  test('enrich keeps a write-up whose own section is dated instead of refusing it as lossy', () => {
    const page = { compiled_truth: 'Alice Example is a stub.', timeline: '', body_storage: 'inline' } as any;
    expect(preserveCanonicalFences(page, body)).toBe(body);
  });
test('edit_page sees the same bytes get_page serves, sentinel included', () => {
    const page = { slug: 'people/alice-example', source_id: 'default', type: 'person', title: 'Alice Example', compiled_truth: body, timeline: '', frontmatter: {} } as any;
    expect(editableView(page, [], false)).toBe(serializePageToMarkdown(page, []));
  });

  test('the first timeline write after such a body agrees between file and database', () => {
    const file = serializeMarkdown({}, body, '', meta);
    const block = '- **2026-05-01** | met';
    const written = parseMarkdown(spliceTimelineIntoFileText(file, '2026-05-01', block), 'people/alice-example.md');
    expect(written.compiled_truth).toBe(body);
    expect(written.timeline).toBe(spliceTimelineBlock('', '2026-05-01', block).trim());
  });

  test('a body split by its own --- and ## Timeline gets no stray marker', () => {
    const dashed = 'Intro prose.\n\n---\n\n## Timeline\n- 2024-01-01: x';
    expect(serializeMarkdown({}, dashed, '', meta)).not.toContain('<!-- timeline -->');
  });
});
