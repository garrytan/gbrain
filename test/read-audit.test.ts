import { describe, test, expect } from 'bun:test';
import { buildReadAuditInput } from '../src/core/eval-capture.ts';

describe('buildReadAuditInput', () => {
  test('maps read context into EvalCandidateInput with params_jsonb', () => {
    const input = buildReadAuditInput({
      tool_name: 'get_page',
      query: 'read slug test/x',
      params: { slug: 'test/x', include_deleted: false },
      retrieved_slugs: ['test/x'],
      retrieved_chunk_ids: [],
      source_ids: ['default'],
      latency_ms: 5,
      remote: true,
      job_id: null,
      subagent_id: null,
      mcp_token_name: 'z',
    });
    expect(input.tool_name).toBe('get_page');
    expect(input.params_jsonb).toEqual({ slug: 'test/x', include_deleted: false });
    expect(input.vector_enabled).toBe(false);
    expect(input.mcp_token_name).toBe('z');
    expect(input.detail).toBeNull();
    expect(input.expand_enabled).toBeNull();
  });
});
