/**
 * upstream-classifier.test.mjs — D4-A invariant.
 *
 * The full-flow E2E classifies failures into upstream / plumbing /
 * semantic / unknown so the ship gate doesn't block on transient external
 * outages. This test pins the classification table so future contributors
 * can't drift the soft-vs-hard-fail boundary silently.
 */

import { describe, expect, it } from 'vitest';
import { classifyFailure, verdictFor, preflightOpenAIStatus } from '../../code/lib/upstream-classifier.mjs';

describe('classifyFailure — HTTP status', () => {
  it('429 (rate limit) → upstream', () => {
    expect(classifyFailure({ status: 429 })).toBe('upstream');
    expect(classifyFailure({ statusCode: 429 })).toBe('upstream');
    expect(classifyFailure({ response: { status: 429 } })).toBe('upstream');
  });

  it('500/502/503/504 → upstream', () => {
    expect(classifyFailure({ status: 500 })).toBe('upstream');
    expect(classifyFailure({ status: 502 })).toBe('upstream');
    expect(classifyFailure({ status: 503 })).toBe('upstream');
    expect(classifyFailure({ status: 504 })).toBe('upstream');
  });

  it('401/403 (auth) → plumbing (our config)', () => {
    expect(classifyFailure({ status: 401 })).toBe('plumbing');
    expect(classifyFailure({ status: 403 })).toBe('plumbing');
  });

  it('400 (bad request) → plumbing (our payload)', () => {
    expect(classifyFailure({ status: 400 })).toBe('plumbing');
  });

  it('200 → not explicitly classified (falls through to unknown)', () => {
    // 200 shouldn't surface as a failure at all, but if it does, treat as unknown.
    expect(classifyFailure({ status: 200 })).toBe('unknown');
  });
});

describe('classifyFailure — WebSocket close codes', () => {
  it('1011 (server error) → upstream', () => {
    expect(classifyFailure({ closeCode: 1011 })).toBe('upstream');
  });

  it('1013 (try again later) → upstream', () => {
    expect(classifyFailure({ closeCode: 1013 })).toBe('upstream');
  });

  it('1006 (abnormal closure) → upstream (network layer)', () => {
    expect(classifyFailure({ closeCode: 1006 })).toBe('upstream');
  });
});

describe('classifyFailure — plumbing markers', () => {
  it('audioSendCount === 0 → plumbing', () => {
    expect(classifyFailure({ audioSendCount: 0 })).toBe('plumbing');
  });

  it('audioSendCount > 0 but audioPlayCount === 0 → plumbing', () => {
    expect(classifyFailure({ audioSendCount: 3, audioPlayCount: 0 })).toBe('plumbing');
  });

  it('iceFailure → plumbing', () => {
    expect(classifyFailure({ iceFailure: true })).toBe('plumbing');
  });

  it('healthCheckFailed → plumbing', () => {
    expect(classifyFailure({ healthCheckFailed: true })).toBe('plumbing');
  });
});

describe('classifyFailure — explicit type tags', () => {
  it('respects {type: "upstream"}', () => {
    expect(classifyFailure({ type: 'upstream' })).toBe('upstream');
  });

  it('respects {type: "plumbing"}', () => {
    expect(classifyFailure({ type: 'plumbing' })).toBe('plumbing');
  });

  it('respects {type: "semantic"}', () => {
    expect(classifyFailure({ type: 'semantic' })).toBe('semantic');
    expect(classifyFailure({ type: 'semantic_judge_fail' })).toBe('semantic');
  });
});

describe('classifyFailure — reason / code strings', () => {
  it('"rate_limit_exceeded" → upstream', () => {
    expect(classifyFailure({ reason: 'rate_limit_exceeded' })).toBe('upstream');
  });

  it('"upstream_degraded" → upstream', () => {
    expect(classifyFailure({ reason: 'upstream_degraded' })).toBe('upstream');
  });

  it('"semantic_fail" → semantic', () => {
    expect(classifyFailure({ reason: 'semantic_fail' })).toBe('semantic');
    expect(classifyFailure({ reason: 'judge_fail' })).toBe('semantic');
  });
});

describe('classifyFailure — message inspection', () => {
  it('"429" + api.openai.com → upstream', () => {
    expect(classifyFailure(new Error('Got 429 from api.openai.com'))).toBe('upstream');
  });

  it('"rate_limit" + api.anthropic.com → upstream', () => {
    expect(classifyFailure(new Error('rate_limit hit on api.anthropic.com'))).toBe('upstream');
  });

  it('"ECONNRESET" + api.openai.com → upstream', () => {
    expect(classifyFailure(new Error('ECONNRESET on api.openai.com'))).toBe('upstream');
  });

  it('"ECONNRESET" on localhost → plumbing', () => {
    expect(classifyFailure(new Error('ECONNRESET localhost:8765'))).toBe('plumbing');
  });

  it('plain Error with no clear signal → unknown', () => {
    expect(classifyFailure(new Error('weird thing happened'))).toBe('unknown');
  });
});

describe('classifyFailure — edge cases', () => {
  it('null → unknown', () => {
    expect(classifyFailure(null)).toBe('unknown');
  });

  it('undefined → unknown', () => {
    expect(classifyFailure(undefined)).toBe('unknown');
  });

  it('empty object → unknown', () => {
    expect(classifyFailure({})).toBe('unknown');
  });
});

describe('verdictFor()', () => {
  it('upstream → soft_fail', () => {
    expect(verdictFor('upstream')).toBe('soft_fail');
  });

  it('semantic → soft_fail', () => {
    expect(verdictFor('semantic')).toBe('soft_fail');
  });

  it('plumbing → hard_fail', () => {
    expect(verdictFor('plumbing')).toBe('hard_fail');
  });

  it('unknown → hard_fail (conservative)', () => {
    expect(verdictFor('unknown')).toBe('hard_fail');
  });

  it('anything else → hard_fail', () => {
    expect(verdictFor('garbage')).toBe('hard_fail');
  });
});

describe('preflightOpenAIStatus()', () => {
  it('returns ok when fetch is unavailable', async () => {
    const result = await preflightOpenAIStatus({ fetch: null });
    expect(result.status).toBe('ok');
  });

  it('returns ok when status page reports "none" indicator', async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ status: { indicator: 'none', description: 'All Systems Operational' } }),
    });
    const result = await preflightOpenAIStatus({ fetch: fakeFetch });
    expect(result.status).toBe('ok');
  });

  it('returns degraded when status page reports non-none indicator', async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ status: { indicator: 'major', description: 'Realtime API down' } }),
    });
    const result = await preflightOpenAIStatus({ fetch: fakeFetch });
    expect(result.status).toBe('degraded');
    expect(result.detail).toMatch(/Realtime API down/);
  });

  it('returns ok when fetch throws (treat status-page outage as non-signal)', async () => {
    const fakeFetch = async () => { throw new Error('status page down'); };
    const result = await preflightOpenAIStatus({ fetch: fakeFetch });
    expect(result.status).toBe('ok');
  });

  it('returns ok when status page returns non-200', async () => {
    const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await preflightOpenAIStatus({ fetch: fakeFetch });
    expect(result.status).toBe('ok');
  });
});
