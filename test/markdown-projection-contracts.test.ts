import { describe, expect, test } from 'bun:test';
import {
  parseAssertionFence,
  parseMarkdownProjection,
  projectionContentHash,
  renderAssertionFence,
  renderMarkdownProjection,
} from '../src/core/reconciler/markdown-contracts.ts';

describe('markdown projection contracts', () => {
  test('structured assertion fence round-trips byte-stably for unchanged data', () => {
    const rows = [
      {
        assertion_id: 'assertion:project-decision',
        property: 'decision.timeline',
        value: 'Keep Markdown as a projection of canonical memory.',
        source_refs: ['source:meeting#2026-05-20'],
      },
      {
        assertion_id: 'assertion:compiled-truth',
        property: 'compiled_truth.summary',
        value: 'Postgres owns semantic truth.',
        source_refs: ['source:design#phase10'],
      },
    ];

    const rendered = renderAssertionFence(rows);

    expect(parseAssertionFence(rendered)).toEqual(rows);
    expect(renderAssertionFence(parseAssertionFence(rendered))).toBe(rendered);
  });

  test('markdown page projections parse and render without byte drift when unchanged', () => {
    const rendered = renderMarkdownProjection({
      target_id: 'systems/mbrain',
      target_type: 'system_doc',
      title: 'MBrain',
      frontmatter: {
        type: 'system',
        tags: ['memory', 'postgres-runtime'],
      },
      compiled_truth: 'MBrain keeps durable memory in canonical state.',
      timeline: '- **2026-05-20** | Phase 10 reconciler specified.',
      assertions: [{
        assertion_id: 'assertion:mbrain-summary',
        property: 'compiled_truth.summary',
        value: 'MBrain keeps durable memory in canonical state.',
        source_refs: ['source:phase10-spec'],
      }],
    });
    const parsed = parseMarkdownProjection(rendered);

    expect(parsed.target_id).toBe('systems/mbrain');
    expect(parsed.target_type).toBe('system_doc');
    expect(parsed.frontmatter).toEqual({
      type: 'system',
      tags: ['memory', 'postgres-runtime'],
    });
    expect(parsed.projection_hash).toBe(projectionContentHash(parsed.body_without_hash));
    expect(renderMarkdownProjection(parsed)).toBe(rendered);
  });
});
