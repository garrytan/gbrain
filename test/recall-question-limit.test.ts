/**
 * GST-1304 (HARN-31): recall refuses a question over QUESTION_MAX_CHARS. A provider that fails open on any refusal
 * turned that into "no facts" silently, because nothing in the structured error told the over-long question apart
 * from other bad input. The refusal now carries reason question_too_long with the limit and the received length, and
 * the server never truncates (the call is refused, nothing is read).
 *
 * 1. Protects: an over-long recall question over MCP dispatch is refused invalid_params with reason
 *    question_too_long and detail `max_chars=<limit> received_chars=<n>`; a question at the limit is read.
 * 2. Fails when: the refusal loses its reason or numbers, or the server starts cutting the question.
 * 3. Existing coverage: test/recall-question.test.ts pins the message and the fix's shortened retry.
 * 4. Real seams: PGLite, MCP dispatch as a remote caller; no providers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { QUESTION_MAX_CHARS } from '../src/core/facts/question-recall.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

describe('recall question limit (pglite)', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  const recall = async (question: string) => {
    const auth = { token: 't', clientId: 'c', scopes: ['read'], sourceId: 'default' } as unknown as AuthInfo;
    const out = await dispatchToolCall(engine, 'recall', { question, caller: 'provider' }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { isError: out.isError === true, json, structured: out.structuredContent as Record<string, any> | undefined };
  };

  test('a question over the limit is refused with reason question_too_long, the limit and the received length', async () => {
    const question = 'what did we decide about the launch '.repeat(84).trim();
    expect(question.length).toBeGreaterThan(QUESTION_MAX_CHARS);
    const out = await recall(question);
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ code: 'invalid_params', reason: 'question_too_long', detail: `max_chars=${QUESTION_MAX_CHARS} received_chars=${question.length}` });
    expect(out.json.message).toContain(String(QUESTION_MAX_CHARS));
  });

  test('a question at the limit is read, not refused', async () => {
    const out = await recall('x'.repeat(QUESTION_MAX_CHARS));
    expect(out.isError).toBe(false);
  });
});
