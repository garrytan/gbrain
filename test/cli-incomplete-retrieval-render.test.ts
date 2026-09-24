import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { captureRetrievalMeta, formatResult, resetRetrievalMetaForTests } from '../src/cli.ts';

afterEach(() => resetRetrievalMetaForTests());

describe('CLI incomplete retrieval is visible without changing JSON result shape', () => {
  test.each(['vector_candidates_incomplete', 'projection_pending', 'projection_status_unknown'])(
    '%s is visible for empty and partial results', stage => {
      captureRetrievalMeta('retrieval', { degraded: [{ stage }] });
      expect(formatResult('search', [], {})).toContain(`degraded: ${stage}`);
      expect(formatResult('search', [], {})).not.toContain('clean miss');
      const partial = formatResult('query', [{ slug: 'notes/synthetic', score: 1, chunk_text: 'Synthetic note' }], {});
      expect(partial).toContain(`Retrieval incomplete: ${stage}.`);
      expect(partial).toContain('notes/synthetic');
    },
  );

  test('JSON remains a bare result array while stderr reports incompleteness', () => {
    captureRetrievalMeta('retrieval', { degraded: [{ stage: 'vector_candidates_incomplete' }] });
    const write = spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(JSON.parse(formatResult('search', [], { json: true }))).toEqual([]);
      expect(write).toHaveBeenCalledWith('Retrieval incomplete: vector_candidates_incomplete.\n');
    } finally { write.mockRestore(); }
  });
});
