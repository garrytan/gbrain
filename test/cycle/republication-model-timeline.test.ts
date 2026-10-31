import { expect, test } from 'bun:test';
import { preserveCanonicalFences } from '../../src/core/cycle/concept-publication.ts';
import { parseMarkdown, serializeMarkdown } from '../../src/core/markdown.ts';
import { upsertTakeRow } from '../../src/core/takes-fence.ts';

// Model timelines must neither block narrative refreshes nor become canonical history.
// Regresses when replacement history reaches the preservation guard. Existing
// synthesis coverage exercises fence edits, not model timelines on empty history.
// Calls the production helper directly without an additional test seam.
for (const timeline of ['', '## Timeline\n\n- **2025-01-01** | Canonical event']) {
  test(`republication discards a model timeline with ${timeline ? 'existing' : 'empty'} history`, () => {
    const compiled_truth = upsertTakeRow('Original narrative.\n\n## Facets\n\nCurated section.', {
      claim: 'Canonical claim', kind: 'take', holder: 'brain', weight: 0.7, active: true,
    }).body;
    const page = { compiled_truth, timeline };
    const replacement = 'Updated narrative.\n\n## Timeline\n\n- **2026-10-01** | Model event\n\n## Role\n\nUpdated role.';
    const compiled = preserveCanonicalFences(page, replacement);
    const out = parseMarkdown(serializeMarkdown({}, compiled, timeline,
      { type: 'person', title: 'Example', tags: [] }), 'people/example');

    expect(out.timeline).toBe(timeline);
    expect(compiled).toContain('Updated narrative.');
    expect(compiled).toContain('## Role\n\nUpdated role.');
    expect(compiled).not.toContain('Model event');
    expect(compiled).not.toContain('## Timeline');
    expect(compiled).toContain(compiled_truth.slice(compiled_truth.indexOf('## Facets')).trimEnd());
    expect(out.compiled_truth).toBe(compiled);
  });
}
