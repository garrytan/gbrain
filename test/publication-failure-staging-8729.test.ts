/**
 * #8729: stagingFailureDetail reads a body_staging_expired refusal's JSON detail into a bounded error_detail.
 *
 * 1. Protects: the flip's generation_incomplete refusal keeps its staging id, rows, segment count and covered bytes, so
 *    `sources writer failures` shows which staging was short and by how much.
 * 2. Fails when: the detail is dropped (error_detail NULL), an unexpected key or a non-uuid staging id passes through.
 */
import { expect, test } from 'bun:test';
import { stagingFailureDetail } from '../src/core/persistence/publication-failure.ts';

const id = '0b5e8f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

test('a generation_incomplete refusal keeps its staging and coverage counts', () => {
  const detail = JSON.stringify({ staging_id: id.toUpperCase(), reason: 'generation_incomplete', rows: 7, segment_count: 8, covered_bytes: 900, body_bytes: 1024, extra: 'x' });
  expect(stagingFailureDetail({ code: 'body_staging_expired', detail })).toEqual({ origin: 'body_staging',
    staging: { staging_id: id, reason: 'generation_incomplete', rows: 7, segment_count: 8, covered_bytes: 900, body_bytes: 1024 } });
  const gap = JSON.stringify({ staging_id: id, reason: 'generation_incomplete', rows: 7, segment_count: 8, covered_bytes: null, body_bytes: 1024 });
  expect(stagingFailureDetail({ code: 'body_staging_expired', detail: gap })?.staging.covered_bytes).toBeNull();
});

test('other codes, non-uuid ids and unparseable details give no detail', () => {
  expect(stagingFailureDetail({ code: 'revision_conflict', detail: JSON.stringify({ staging_id: id }) })).toBeUndefined();
  expect(stagingFailureDetail({ code: 'body_staging_expired', detail: JSON.stringify({ staging_id: 'conversations/chat-example' }) })).toBeUndefined();
  expect(stagingFailureDetail({ code: 'body_staging_expired', detail: '{' })).toBeUndefined();
  expect(stagingFailureDetail({ code: 'body_staging_expired', detail: JSON.stringify({ staging_id: id, state: 'bogus' }) })).toEqual({ origin: 'body_staging', staging: { staging_id: id } });
});
