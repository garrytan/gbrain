/**
 * v0.39.3.0 WARN-10 + CV11 + T4 — brainstorm timeout classifier.
 *
 * Pre-fix: brainstorm + lsd silently produced no output on PgBouncer
 * transaction-mode environments when listPrefixSampledPages or hybrid
 * search exceeded the statement timeout. The error surfaced as a
 * generic 'gbrain: unknown error' fallback, consuming the cost-preview
 * wait and producing zero ideas.
 *
 * Per CV11 + T4: orchestrator-level wrap classifies any SQLSTATE 57014
 * (query_canceled — covers statement_timeout, lock_timeout, user_cancel)
 * as a typed `StructuredAgentError` with code='brainstorm_timeout' and
 * a hint covering all three PG cancel sub-causes. Non-57014 errors
 * rethrow as-is.
 *
 * Per A3: reuse StructuredAgentError (the v0.19.0 envelope) — no new
 * error class.
 *
 * Tests cover the pure classifier helper (isQueryCanceledError +
 * classifyBrainstormError) at unit level. The orchestrator-wrap +
 * CLI-formatter end-to-end behavior is implicit: classifier returns
 * the typed error → orchestrator throws it → CLI formatter prints
 * 'Error [brainstorm_timeout]: ... Hint: ...' (cli.ts:188-191 pattern).
 */

import { describe, test, expect } from 'bun:test';
import { isQueryCanceledError, classifyBrainstormError } from '../src/core/brainstorm/error-classify.ts';
import { StructuredAgentError } from '../src/core/errors.ts';

describe('isQueryCanceledError — SQLSTATE 57014 detection across driver shapes', () => {
  test('postgres.js shape: { code: "57014" } → true', () => {
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    expect(isQueryCanceledError(err)).toBe(true);
  });

  test('alternate shape: { sqlState: "57014" } → true', () => {
    const err = Object.assign(new Error('query canceled'), { sqlState: '57014' });
    expect(isQueryCanceledError(err)).toBe(true);
  });

  test('message-only fallback: "canceling statement due to ..." → true', () => {
    expect(isQueryCanceledError(new Error('canceling statement due to statement timeout'))).toBe(true);
    expect(isQueryCanceledError(new Error('canceling statement due to lock timeout'))).toBe(true);
    expect(isQueryCanceledError(new Error('canceling statement due to user request'))).toBe(true);
  });

  test('case-insensitive SQLSTATE in message: "SQLSTATE: 57014" → true', () => {
    expect(isQueryCanceledError(new Error('PG error sqlstate: 57014'))).toBe(true);
  });

  test('different error codes do NOT match (non-cancel PG errors rethrow)', () => {
    const err42 = Object.assign(new Error('division by zero'), { code: '22012' });
    const err23 = Object.assign(new Error('FK violation'), { code: '23503' });
    expect(isQueryCanceledError(err42)).toBe(false);
    expect(isQueryCanceledError(err23)).toBe(false);
  });

  test('non-DB errors do NOT match', () => {
    expect(isQueryCanceledError(new Error('connection refused'))).toBe(false);
    expect(isQueryCanceledError(new Error('OAuth token expired'))).toBe(false);
    expect(isQueryCanceledError(new Error('something timed out'))).toBe(false); // missing PG-specific markers
  });

  test('null / undefined / non-error → false', () => {
    expect(isQueryCanceledError(null)).toBe(false);
    expect(isQueryCanceledError(undefined)).toBe(false);
    expect(isQueryCanceledError('57014')).toBe(false); // string, not an object
    expect(isQueryCanceledError(42)).toBe(false);
  });
});

describe('classifyBrainstormError — convert 57014 to StructuredAgentError', () => {
  test('57014 error becomes StructuredAgentError with brainstorm_timeout code', () => {
    const orig = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const classified = classifyBrainstormError(orig);
    expect(classified).toBeInstanceOf(StructuredAgentError);
    const env = (classified as StructuredAgentError).envelope;
    expect(env.code).toBe('brainstorm_timeout');
    expect(env.class).toBe('BrainstormError');
    expect(env.message).toContain('canceled');
    expect(env.hint).toContain('statement_timeout');
    expect(env.hint).toContain('PgBouncer');
    expect(env.hint).toContain('lock_timeout');
    expect(env.hint).toContain('user-cancel');
  });

  test('hint covers all 3 PG cancel sub-causes per codex F#19', () => {
    const orig = Object.assign(new Error('any 57014'), { code: '57014' });
    const env = (classifyBrainstormError(orig) as StructuredAgentError).envelope;
    // All three sub-causes named so the message is honest regardless of which fired
    expect(env.hint).toMatch(/statement_timeout/);
    expect(env.hint).toMatch(/lock_timeout/);
    expect(env.hint).toMatch(/user-cancel/);
    // Plus actionable workaround
    expect(env.hint).toMatch(/--limit/);
  });

  test('non-57014 errors pass through unchanged (codex F#20 — no silent swallow)', () => {
    const oauthErr = new Error('OAuth token expired');
    expect(classifyBrainstormError(oauthErr)).toBe(oauthErr); // SAME REFERENCE

    const fkErr = Object.assign(new Error('FK violation'), { code: '23503' });
    expect(classifyBrainstormError(fkErr)).toBe(fkErr);

    const netErr = new Error('ECONNREFUSED');
    expect(classifyBrainstormError(netErr)).toBe(netErr);
  });

  test('null / undefined pass through unchanged', () => {
    expect(classifyBrainstormError(null)).toBeNull();
    expect(classifyBrainstormError(undefined)).toBeUndefined();
  });

  test('classified error message is descriptive on its own (Error.message channel)', () => {
    const orig = Object.assign(new Error('57014'), { code: '57014' });
    const classified = classifyBrainstormError(orig);
    expect((classified as Error).message).toContain('BrainstormError');
    expect((classified as Error).message).toContain('canceled');
    expect((classified as Error).message).toContain('Causes');
  });
});

describe('orchestrator entry-point wrap (CV11 single-point classification)', () => {
  // Smoke test that the entry wrap is in place. The orchestrator code
  // imports classifyBrainstormError; the public runBrainstorm catches
  // any thrown error and routes it through the classifier.
  //
  // This is a source-shape regression guard: if a future refactor
  // moves the wrap to per-call try/catches (the codex-F#20 anti-pattern),
  // this test fails because the imports drift.
  test('orchestrator.ts imports classifyBrainstormError + StructuredAgentError', async () => {
    const src = await Bun.file('src/core/brainstorm/orchestrator.ts').text();
    expect(src).toContain("import { StructuredAgentError } from '../errors.ts'");
    expect(src).toContain("import { classifyBrainstormError } from './error-classify.ts'");
    expect(src).toContain('classifyBrainstormError(err)');
    // The wrap must be at the PUBLIC entry point, NOT a per-call wrap
    expect(src).toMatch(/export async function runBrainstorm\s*\([\s\S]*?try\s*{[\s\S]*?await runBrainstormImpl/);
  });

  test('commands/brainstorm.ts has the CLI formatter for StructuredAgentError', async () => {
    const src = await Bun.file('src/commands/brainstorm.ts').text();
    expect(src).toContain("import { StructuredAgentError } from '../core/errors.ts'");
    expect(src).toContain('err instanceof StructuredAgentError');
    expect(src).toContain("Error [");
    expect(src).toContain('Hint:');
  });
});
