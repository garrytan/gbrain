/**
 * v0.41 D3 + E6 — error classifier unit tests.
 *
 * Pins each bucket against real production error string shapes from
 * `minion_jobs.last_error`. Covers the narrowed tool-error sub-buckets
 * per codex pass-2 #4 (only `tool_schema_mismatch` self-fixes; `tool_crash`
 * / `tool_unavailable` / `tool_permission` route through normal dead-letter).
 *
 * RECOVERABLE_CLUSTERS guard test pins the E6 self-fix qualification list
 * so future widening is an explicit code change, not silent drift.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyJobError,
  clusterErrors,
  RECOVERABLE_CLUSTERS,
} from '../src/core/minions/error-classify.ts';

describe('classifyJobError', () => {
  test('null / undefined / empty → unknown', () => {
    expect(classifyJobError(null)).toBe('unknown');
    expect(classifyJobError(undefined)).toBe('unknown');
    expect(classifyJobError('')).toBe('unknown');
  });

  test('rate_lease_full — gbrain internal', () => {
    expect(classifyJobError('rate lease "anthropic:messages" full (8/8)')).toBe('rate_lease_full');
    expect(classifyJobError('rate lease "openai:responses" full (32/32)')).toBe('rate_lease_full');
  });

  test('prompt_too_long — Anthropic 400', () => {
    expect(classifyJobError('400 prompt is too long: 1707509 tokens > 1000000 maximum')).toBe('prompt_too_long');
    expect(classifyJobError('context length exceeded')).toBe('prompt_too_long');
  });

  test('tool_unavailable — registry config', () => {
    expect(classifyJobError('tool "ghost" is not in the registry for this subagent')).toBe('tool_unavailable');
    expect(classifyJobError('tool "shell" is not available')).toBe('tool_unavailable');
  });

  test('tool_permission — capability decision', () => {
    expect(classifyJobError('tool "put_page" permission denied: slug outside namespace')).toBe('tool_permission');
    expect(classifyJobError('tool "shell" forbidden')).toBe('tool_permission');
  });

  test('tool_schema_mismatch — bad args (self-fixable)', () => {
    expect(classifyJobError('invalid input: missing required field "slug"')).toBe('tool_schema_mismatch');
    expect(classifyJobError('tool_use validation failed: param X required')).toBe('tool_schema_mismatch');
    expect(classifyJobError('malformed argument shape')).toBe('tool_schema_mismatch');
  });

  test('tool_crash — real impl bug (NOT self-fixable)', () => {
    expect(classifyJobError('tool "git_commit" failed: ENOENT')).toBe('tool_crash');
    expect(classifyJobError('tool.execute error: Cannot read property of undefined')).toBe('tool_crash');
  });

  test('malformed_json — model emitted bad JSON (self-fixable)', () => {
    expect(classifyJobError('failed to parse JSON response')).toBe('malformed_json');
    expect(classifyJobError('Unexpected token } in JSON at position 47')).toBe('malformed_json');
    expect(classifyJobError('expected JSON, got plain text')).toBe('malformed_json');
  });

  test('auth — 401 / API key', () => {
    expect(classifyJobError('401 Unauthorized: invalid API key')).toBe('auth');
    expect(classifyJobError('api_key_invalid')).toBe('auth');
  });

  test('rate_limit — upstream 429', () => {
    expect(classifyJobError('429 Too Many Requests')).toBe('rate_limit');
    expect(classifyJobError('rate limit exceeded')).toBe('rate_limit');
  });

  test('http_5xx — upstream server errors', () => {
    expect(classifyJobError('500 Internal Server Error')).toBe('http_5xx');
    expect(classifyJobError('502 Bad Gateway')).toBe('http_5xx');
    expect(classifyJobError('Anthropic API: overloaded_error')).toBe('http_5xx');
  });

  test('timeout — local timeout', () => {
    expect(classifyJobError('aborted: timeout')).toBe('timeout');
    expect(classifyJobError('operation timed out after 30s')).toBe('timeout');
  });

  test('context_canceled — abort signal', () => {
    expect(classifyJobError('aborted: cancel')).toBe('context_canceled');
    expect(classifyJobError('signal aborted: worker shutdown')).toBe('context_canceled');
  });

  test('unknown — no pattern matches (operator-visible signal to widen classifier)', () => {
    expect(classifyJobError('mysterious novel error message')).toBe('unknown');
    expect(classifyJobError('catastrophic failure at 03:14:00')).toBe('unknown');
  });

  test('most-specific wins — tool_unavailable beats tool_crash for "not in registry" message', () => {
    // "tool 'ghost' is not in the registry" could superficially match a
    // looser tool_crash regex; classifier order ensures unavailable wins.
    expect(classifyJobError('tool "ghost" is not in the registry for this subagent')).toBe('tool_unavailable');
  });
});

describe('clusterErrors', () => {
  test('groups by bucket; returns sorted by count desc, then bucket asc', () => {
    const errors = [
      { id: 1, last_error: 'rate lease "anthropic:messages" full (8/8)' },
      { id: 2, last_error: 'rate lease "anthropic:messages" full (8/8)' },
      { id: 3, last_error: 'rate lease "anthropic:messages" full (8/8)' },
      { id: 4, last_error: 'prompt is too long: 1.8M tokens' },
      { id: 5, last_error: '500 Internal Server Error' },
    ];
    const clusters = clusterErrors(errors);
    expect(clusters[0]!.cluster).toBe('rate_lease_full');
    expect(clusters[0]!.count).toBe(3);
    expect(clusters[0]!.sample_ids).toEqual([1, 2, 3]);
    // Then prompt_too_long (1) before http_5xx (1) by alpha tiebreaker.
    expect(clusters[1]!.cluster).toBe('http_5xx');
    expect(clusters[2]!.cluster).toBe('prompt_too_long');
  });

  test('caps sample_ids at 3 per bucket', () => {
    const errors = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      last_error: 'rate lease "anthropic:messages" full (8/8)',
    }));
    const clusters = clusterErrors(errors);
    expect(clusters[0]!.sample_ids).toEqual([1, 2, 3]);
    expect(clusters[0]!.count).toBe(10);
  });

  test('empty input → empty array', () => {
    expect(clusterErrors([])).toEqual([]);
  });
});

describe('RECOVERABLE_CLUSTERS guard (codex pass-2 #4)', () => {
  test('only the three narrowed buckets self-fix', () => {
    expect(RECOVERABLE_CLUSTERS.has('prompt_too_long')).toBe(true);
    expect(RECOVERABLE_CLUSTERS.has('tool_schema_mismatch')).toBe(true);
    expect(RECOVERABLE_CLUSTERS.has('malformed_json')).toBe(true);
  });

  test('tool_crash + tool_unavailable + tool_permission are NOT self-fixable', () => {
    expect(RECOVERABLE_CLUSTERS.has('tool_crash')).toBe(false);
    expect(RECOVERABLE_CLUSTERS.has('tool_unavailable')).toBe(false);
    expect(RECOVERABLE_CLUSTERS.has('tool_permission')).toBe(false);
  });

  test('rate_lease_full does NOT self-fix (Bug 2 handles it differently)', () => {
    // The lease-full bypass path is the right handler for this; self-fix
    // would mask the cap-too-tight signal the operator needs to see.
    expect(RECOVERABLE_CLUSTERS.has('rate_lease_full')).toBe(false);
  });
});
