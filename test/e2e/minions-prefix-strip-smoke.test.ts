/**
 * v0.41 E2E — Bug 3 prefix-strip smoke.
 *
 * Verifies that a subagent job with `data.model = 'anthropic:claude-sonnet-4-6'`
 * sends the BARE model id to the Anthropic SDK (not the qualified string).
 * Uses a stubbed MessagesClient that records every params.model it sees.
 *
 * Pre-v0.41 this would have sent the qualified string to Anthropic and
 * gotten a 404 "model not found." Post-v0.41 the SDK receives
 * "claude-sonnet-4-6" cleanly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { makeSubagentHandler, type MessagesClient } from '../../src/core/minions/handlers/subagent.ts';
import type Anthropic from '@anthropic-ai/sdk';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
}, 30_000);

describe('v0.41 Bug 3 — E2E prefix strip at Anthropic call site', () => {
  test('qualified provider:model strips to bare model_id at SDK call', async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const client: MessagesClient = {
      async create(params) {
        calls.push(params);
        return {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          role: 'assistant',
        } as unknown as Anthropic.Message;
      },
    };
    const handler = makeSubagentHandler({
      engine, client, toolRegistry: [], maxConcurrent: 100,
      rateLeaseKey: 'k_e2e_prefix',
    });

    // Submit with qualified model — the field-report case.
    const job = await queue.add(
      'subagent',
      { prompt: 'hi', model: 'anthropic:claude-sonnet-4-6' },
      {},
      { allowProtectedSubmit: true },
    );
    // Drive the handler directly (worker not needed for one-shot test).
    const ctx = {
      id: job.id,
      data: { prompt: 'hi', model: 'anthropic:claude-sonnet-4-6' },
      signal: new AbortController().signal,
      shutdownSignal: new AbortController().signal,
      readInbox: async () => [],
      updateTokens: async () => {},
      updateProgress: async () => {},
    } as any;
    await handler(ctx);

    expect(calls.length).toBe(1);
    // The SDK MUST receive the bare model id (no `anthropic:` prefix).
    expect(calls[0]!.model).toBe('claude-sonnet-4-6');
    expect(calls[0]!.model).not.toContain(':');
  });
});
