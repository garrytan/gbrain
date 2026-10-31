import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('transient extraction TTL (#8076)', () => {
  test('classifies claims and persists the configured TTL only for transient facts', async () => {
    let system = '';
    __setChatTransportForTests(async (input): Promise<ChatResult> => {
      system = input.system ?? '';
      return {
        text: JSON.stringify({ facts: [
          { fact: 'Currently staying in Austin', kind: 'fact', entity: null, durability: 'transient' },
          { fact: 'Prefers tea', kind: 'preference', entity: null, durability: 'durable' },
        ] }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });

    await engine.setConfig('memory.auto_writeback_transient_ttl', '12h');
    const startedAt = Date.now();
    const outcome = await runFactsPipeline('I am currently staying in Austin and I prefer tea.', {
      engine,
      sourceId: 'default',
      sessionId: 'transient-ttl-test',
      source: 'mcp:extract_facts',
      mode: 'inline',
    }).then(result => ({ result, error: null as unknown }))
      .catch(error => ({ result: null, error }));
    const rows = await engine.executeRaw<{ fact: string; valid_until: Date | string | null }>(
      "SELECT fact, valid_until FROM facts WHERE source = 'mcp:extract_facts' ORDER BY fact",
    );
    const transient = rows.find(fact => fact.fact === 'Currently staying in Austin');
    const durable = rows.find(fact => fact.fact === 'Prefers tea');
    const validUntil = transient?.valid_until == null
      ? null
      : typeof transient.valid_until === 'string' ? new Date(transient.valid_until) : transient.valid_until;

    expect(outcome.error).toBeNull();
    expect(outcome.result?.inserted).toBe(2);
    expect(system).toContain('durability');
    expect(validUntil).toBeInstanceOf(Date);
    expect(validUntil?.getTime() ?? 0).toBeGreaterThan(startedAt + 11.99 * 60 * 60 * 1000);
    expect(validUntil?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now() + 12 * 60 * 60 * 1000);
    expect(durable?.valid_until ?? null).toBeNull();
  });

  test('conversation extraction stores transient validity with the same configured TTL', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({ facts: [
        { fact: 'Currently staying in Kyoto', kind: 'fact', entity: null, durability: 'transient' },
        { fact: 'Prefers green tea', kind: 'preference', entity: null, durability: 'durable' },
      ] }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));
    await engine.setConfig('memory.auto_writeback_transient_ttl', '12h');
    const startedAt = Date.now();
    await engine.putPage('meetings/transient-ttl', {
      type: 'meeting',
      title: 'Travel plans',
      frontmatter: { date: '2026-09-28' },
      compiled_truth: '**Participant 1:** I am currently staying in Kyoto.\n**Participant 2:** I prefer green tea.',
    });

    const outcome = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slugs: ['meetings/transient-ttl'],
      sleepMs: 0,
      overrideDisabled: true,
    });
    const rows = await engine.executeRaw<{ fact: string; valid_until: Date | string | null }>(
      "SELECT fact, valid_until FROM facts WHERE source = 'cli:extract-conversation-facts' AND expired_at IS NULL ORDER BY fact",
    );
    const transient = rows.find(fact => fact.fact === 'Currently staying in Kyoto');
    const durable = rows.find(fact => fact.fact === 'Prefers green tea');
    const validUntil = transient?.valid_until == null
      ? null
      : typeof transient.valid_until === 'string' ? new Date(transient.valid_until) : transient.valid_until;

    expect(outcome.pages_processed).toBe(1);
    expect(rows).toHaveLength(2);
    expect(validUntil).toBeInstanceOf(Date);
    expect(validUntil?.getTime() ?? 0).toBeGreaterThan(startedAt + 11.99 * 60 * 60 * 1000);
    expect(validUntil?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now() + 12 * 60 * 60 * 1000);
    expect(durable?.valid_until ?? null).toBeNull();
  });
});
