import { describe, expect, test } from 'bun:test';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import type { ParsedPage } from '../src/core/import-file.ts';

function page(compiled_truth: string): ParsedPage {
  return {
    type: 'note',
    title: 'Example',
    compiled_truth,
    timeline: '',
    frontmatter: {},
    tags: [],
  };
}

describe('prepareCanonicalProjections fence validation', () => {
  test('ignores repeated facts and takes markers in backtick-fenced code, including longer fences', () => {
    const quoted = [FACTS_FENCE_BEGIN, FACTS_FENCE_END, TAKES_FENCE_BEGIN, TAKES_FENCE_END].join('\n');
    const triple = '`'.repeat(3);
    const quad = '`'.repeat(4);
    const body = [
      'Discussion of quoted markers:',
      '',
      `${quad}typescript`, quoted, triple,
      '',
      `${triple}markdown`, quoted, triple,
      '',
      quad, quoted, quad,
    ].join('\n');

    expect(() => prepareCanonicalProjections(page(body), 'notes/example', 'source')).not.toThrow();
  });

  test('still rejects multiple actual facts fences outside code blocks', () => {
    const body = `${FACTS_FENCE_BEGIN}\n${FACTS_FENCE_END}\n\n${FACTS_FENCE_BEGIN}\n${FACTS_FENCE_END}`;
    expect(() => prepareCanonicalProjections(page(body), 'notes/example', 'source')).toThrow(/at most one facts fence/);
  });

  test('still rejects multiple actual takes fences outside code blocks', () => {
    const body = `${TAKES_FENCE_BEGIN}\n${TAKES_FENCE_END}\n\n${TAKES_FENCE_BEGIN}\n${TAKES_FENCE_END}`;
    expect(() => prepareCanonicalProjections(page(body), 'notes/example', 'source')).toThrow(/at most one facts fence/);
  });
});
