// #7663: preserveCanonicalFences treats a timeline the model wrote itself
// like a fence: dropped from the replacement, with the page's own timeline
// carried over.
//
// Protects: enrich and synthesize_concepts republish a page whose model
// write-up ends with a `## Timeline` section instead of holding it with
// CONCEPT_REPUBLICATION_LOSSY (which left the page stale and re-bought the
// model call every night).
// Fails when: the replacement's timeline section reaches the composed body,
// where the final parse reads it as the page timeline.

import { describe, test, expect } from 'bun:test';
import { preserveCanonicalFences } from '../../src/core/cycle/concept-publication.ts';
import { parseMarkdown, serializeMarkdown } from '../../src/core/markdown.ts';

const PAGE_TIMELINE = '- **2026-09-01** | Joined acme-example';
const REPLACEMENTS = [
  'Para one.\n\n## Role\n\nPara two.',
  'Para one.\n\n---\n\nPara two.',
  'Para one.\n\n## Facts\n\n- a fact',
  'Para one.\n\n## Recent activity\n\n- **2026-10-01** | x',
  'Para one.\n\n## Timeline\n\n- **2026-10-01** | x',
];

function page(timeline: string) {
  return { compiled_truth: 'Old narrative.', timeline, body_storage: 'inline' as const };
}

describe('preserveCanonicalFences and a model-written timeline (#7663)', () => {
  for (const timeline of ['', PAGE_TIMELINE]) {
    for (const replacement of REPLACEMENTS) {
      test(`${JSON.stringify(replacement)} with ${timeline ? 'a' : 'no'} page timeline republishes with the page timeline`, () => {
        const compiled = preserveCanonicalFences(page(timeline), replacement);
        const out = parseMarkdown(serializeMarkdown({}, compiled, timeline, { type: 'person', title: 'alice example', tags: [] }), 'page');
        expect(out.timeline).toBe(timeline);
        expect(out.compiled_truth).toContain('Para one.');
        expect(out.compiled_truth).not.toMatch(/^##\s+Timeline/m);
      });
    }
  }

  test('the model timeline section is dropped and the narrative around it is kept', () => {
    const compiled = preserveCanonicalFences(page(''), 'Para one.\n\n## Timeline\n\n- **2026-10-01** | x\n\n## Role\n\nPara two.');
    expect(compiled).toBe('Para one.\n\n## Role\n\nPara two.');
  });
});
