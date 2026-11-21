import { describe, expect, test } from 'bun:test';
import { parseSliceRequest } from '../src/core/ops/get-page-slice.ts';

const ctx = { remote: true, transport: 'http' } as const;

function suggestionFor(params: Record<string, unknown>): string {
  let suggestion = '';
  try {
    parseSliceRequest(ctx, params);
  } catch (e) {
    suggestion = String((e as { suggestion?: string }).suggestion ?? '');
  }
  return suggestion;
}

describe('get_page slice conflict suggestion (#9808)', () => {
  test.each([
    [{ section: 'A', include_content: true }, 'get_page {"section": "Next steps"}'],
    [{ grep: 'x', include_content: true }, 'get_page {"grep": "widget"}'],
    [{ section: 'A', grep: 'x' }, 'get_page {"grep": "widget"}'],
  ])('example is a valid single-parameter call for %j', (params, call) => {
    const suggestion = suggestionFor(params);
    expect(suggestion).toContain(call);
    expect(suggestion).not.toContain('"slug"');
  });
});
