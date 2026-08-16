/**
 * T15/FOV-1 — the CLI surfaces retrieval degradation on empty results, and
 * the thin-client parser tolerates the D8 second content block.
 *
 * Before this, `cli.ts` returned a bare "No results." BEFORE the --explain
 * branch, and `unpackToolResult` discarded `_meta` — so both CLI surfaces
 * printed nothing diagnosable while the server knew exactly why the result
 * was empty.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { formatResult, captureRetrievalMeta, resetRetrievalMetaForTests } from '../src/cli.ts';
import { unpackToolResult, extractResponseMeta } from '../src/core/mcp-client.ts';

afterEach(() => resetRetrievalMetaForTests());

describe('formatResult empty-result rendering (T15)', () => {
  test('no meta captured → bare No results (old servers / non-retrieval paths)', () => {
    expect(formatResult('search', [], {})).toBe('No results.\n');
  });

  test('degraded meta → cause named inline', () => {
    captureRetrievalMeta('retrieval', {
      returned_count: 0,
      retrieved_count: 3,
      degraded: [{ stage: 'embed_unavailable' }, { stage: 'embed_unavailable' }],
    });
    const out = formatResult('query', [], {});
    expect(out).toContain('No results.');
    expect(out).toContain('retrieved 3 before trimming');
    expect(out).toContain('degraded: embed_unavailable');
    expect((out.match(/embed_unavailable/g) ?? []).length).toBe(1);
  });

  test('clean-miss meta → clean miss named', () => {
    captureRetrievalMeta('retrieval', { returned_count: 0, retrieved_count: 0, degraded: [] });
    expect(formatResult('search', [], {})).toContain('clean miss — no retrieval degradation');
  });

  test('non-retrieval keys are ignored by the capture', () => {
    captureRetrievalMeta('warnings', [{ code: 'unknown_param', param: 'lmit' }]);
    expect(formatResult('search', [], {})).toBe('No results.\n');
  });

  test('--json path is untouched (machine output stays a bare array)', () => {
    captureRetrievalMeta('retrieval', { degraded: [{ stage: 'embed_timeout' }] });
    expect(formatResult('search', [], { json: true })).toBe('[]\n');
  });
});

describe('thin-client envelope handling (ENG-17 skew guard)', () => {
  const twoBlockEnvelope: unknown = {
    content: [
      { type: 'text', text: '[]' },
      { type: 'text', text: '0 results. degraded: embed_unavailable.' },
    ],
    _meta: { retrieval: { returned_count: 0, degraded: [{ stage: 'embed_unavailable' }] } },
  };

  test('unpackToolResult parses content[0] only — the D8 second block never trips it', () => {
    expect(unpackToolResult<unknown[]>(twoBlockEnvelope)).toEqual([]);
  });

  test('extractResponseMeta lifts _meta; absent on old servers → undefined', () => {
    const meta = extractResponseMeta(twoBlockEnvelope);
    expect((meta as any).retrieval.degraded[0].stage).toBe('embed_unavailable');
    expect(extractResponseMeta({ content: [{ type: 'text', text: '[]' }] })).toBeUndefined();
    expect(extractResponseMeta({ content: [{ type: 'text', text: '[]' }], _meta: ['not-an-object'] })).toBeUndefined();
  });
});
