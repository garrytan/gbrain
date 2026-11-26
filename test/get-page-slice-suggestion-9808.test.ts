import { describe, expect, test } from 'bun:test';
import { parseSliceRequest } from '../src/core/ops/get-page-slice.ts';

const REFUSED: Array<Record<string, unknown>> = [
  { section: 'Goals', include_content: true }, { grep: 'x', include_content: true }, { section: 'Goals', content_only: true },
  { grep: 'x', lines: { from: 1, count: 2 } }, { grep: 'x', bytes: { from: 0, count: 10 } }, { section: 'Goals', around_chunk_id: 3 },
  { grep: 'x', cursor: 'gpw1.x' }, { section: 'Goals', grep: 'x' }, { context: 2 }, { section: 'Goals', context: 2 },
  { section: '  ' }, { grep: '' }, { grep: 'x', context: -1 }, { section: 'Goals', body: 'none' }, { grep: 'x', view: 'markdown' },
];

function suggestionFor(ctx: { remote: boolean; transport?: 'http' | 'stdio' }, params: Record<string, unknown>): string {
  try {
    parseSliceRequest(ctx, { slug: 'notes/sections', ...params });
  } catch (e) {
    return String((e as { suggestion?: string }).suggestion ?? '');
  }
  throw new Error(`expected a refusal for ${JSON.stringify(params)}`);
}

describe('get_page slice refusal suggestions are valid calls (#9808)', () => {
  for (const transport of ['http', 'stdio'] as const) {
    test(`MCP (${transport}): every example call parses and is accepted`, () => {
      for (const params of REFUSED) {
        const suggestion = suggestionFor({ remote: true, transport }, params);
        const m = suggestion.match(/Example: get_page (\{.*\})\.$/);
        expect({ params, matched: !!m }).toEqual({ params, matched: true });
        const call = JSON.parse(m![1]) as Record<string, unknown>;
        expect(typeof call.slug).toBe('string');
        expect(parseSliceRequest({ remote: true, transport }, call)).toBeDefined();
      }
    });
  }

  test('CLI: every example is a gbrain get command with the slug and plain flags', () => {
    for (const params of REFUSED) {
      const suggestion = suggestionFor({ remote: false }, params);
      expect({ params, ok: /Example: gbrain get notes\/acme-example-log --(section Goals|grep widget --context 2)\.$/.test(suggestion) })
        .toEqual({ params, ok: true });
    }
  });
});
