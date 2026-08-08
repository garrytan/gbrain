/**
 * Optional-param absent-idiom tolerance at the MCP dispatch layer.
 *
 * Real MCP clients driven by non-Claude models routinely send `""` or `null`
 * for optional params instead of omitting them. Before the
 * `normalizeOptionalParams` step, those calls slipped past `validateParams`
 * (both values type-check or are skipped) and reached handlers whose guards
 * disagree: `recall {since: ""}` and `recall {since: null}` took the
 * since-branch, parsed to no date, and SILENTLY returned zero facts — same
 * call with `since` omitted returns rows. A silent empty is worse than an
 * error: the model concludes the brain is empty.
 *
 * These tests pin the normalized behavior end to end through
 * `dispatchToolCall` (the one path both MCP transports share) against a real
 * PGLiteEngine, plus the deliberate NON-goals: required params stay loud,
 * type-mismatched junk stays loud, undeclared keys stay ignored.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, normalizeOptionalParams, validateParams } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import type { Operation } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const OPTS = { remote: true, sourceId: 'default' } as const;

function factsFrom(r: { content: Array<{ type: string; text: string }> }): unknown[] {
  const payload = JSON.parse(r.content[0].text);
  return payload.facts;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Remote callers see visibility=world only — seed accordingly.
  await engine.insertFact(
    { fact: 'Optional-param seed: the sky is blue', source: 'test:optional-params', visibility: 'world', embedding: null },
    { source_id: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall tolerates the absent-idioms for optional params', () => {
  test('baseline: recall with no filters returns the seeded fact', async () => {
    const r = await dispatchToolCall(engine, 'recall', {}, OPTS);
    expect(r.isError).toBeFalsy();
    expect(factsFrom(r).length).toBe(1);
  });

  test('since: "" behaves like since omitted (was: silent zero facts)', async () => {
    const r = await dispatchToolCall(engine, 'recall', { since: '' }, OPTS);
    expect(r.isError).toBeFalsy();
    expect(factsFrom(r).length).toBe(1);
  });

  test('since: null behaves like since omitted (was: silent zero facts)', async () => {
    const r = await dispatchToolCall(engine, 'recall', { since: null }, OPTS);
    expect(r.isError).toBeFalsy();
    expect(factsFrom(r).length).toBe(1);
  });

  test('entity: "" and session_id: "" behave like omitted (matches the handler\'s own length>0 guards)', async () => {
    const r = await dispatchToolCall(engine, 'recall', { entity: '', session_id: '' }, OPTS);
    expect(r.isError).toBeFalsy();
    expect(factsFrom(r).length).toBe(1);
  });

  test('a real since value still filters (normalization does not blur real dates)', async () => {
    const r = await dispatchToolCall(engine, 'recall', { since: '2099-01-01' }, OPTS);
    expect(r.isError).toBeFalsy();
    expect(factsFrom(r).length).toBe(0);
  });

  test('undeclared params (e.g. cursor: "") stay ignored, not errors', async () => {
    const r = await dispatchToolCall(engine, 'recall', { cursor: '' }, OPTS);
    expect(r.isError).toBeFalsy();
    expect(factsFrom(r).length).toBe(1);
  });
});

describe('deliberate non-goals stay loud', () => {
  test('null on a REQUIRED param is still a missing-parameter error', async () => {
    const r = await dispatchToolCall(engine, 'get_page', { slug: null }, OPTS);
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('invalid_params');
    expect(payload.message).toContain('Missing required parameter: slug');
  });

  test('type-mismatched junk on an optional param still errors (limit: "")', async () => {
    const r = await dispatchToolCall(engine, 'recall', { limit: '' }, OPTS);
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('invalid_params');
    expect(payload.message).toContain('"limit" must be a number');
  });
});

describe('normalizeOptionalParams unit behavior', () => {
  const op = operations.find(o => o.name === 'recall') as Operation;

  test('strips null and empty-string optionals; leaves everything else', () => {
    const input = { since: '', session_id: null, entity: 'kera', include_expired: false };
    const out = normalizeOptionalParams(op, input);
    expect('since' in out).toBe(false);
    expect('session_id' in out).toBe(false);
    expect(out.entity).toBe('kera');
    expect(out.include_expired).toBe(false);
  });

  test('copy-on-write: the caller\'s object is never mutated', () => {
    const input = { since: '' };
    const out = normalizeOptionalParams(op, input);
    expect(out).not.toBe(input);
    expect(input.since).toBe('');
  });

  test('no-op inputs return the same object (no gratuitous copies)', () => {
    const input = { entity: 'kera' };
    expect(normalizeOptionalParams(op, input)).toBe(input);
  });

  test('empty string is stripped only for string-typed optionals', () => {
    const getPage = operations.find(o => o.name === 'get_page') as Operation;
    // get_page.slug is required — "" must survive normalization untouched
    // (and required-null likewise), so validateParams stays the judge.
    const out = normalizeOptionalParams(getPage, { slug: '' });
    expect(out.slug).toBe('');
    expect(validateParams(getPage, out)).toBeNull();
  });
});
