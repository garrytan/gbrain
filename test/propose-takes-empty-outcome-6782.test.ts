/**
 * #6782: propose_takes recognized a complete empty extraction only when the
 * whole remainder of the reply parsed as JSON, while the take parser stopped
 * at the value's own closing bracket. A reply of `[]` followed by an
 * explanation therefore threw "no parseable takes JSON (transient — retry)":
 * no tombstone was written and the page re-paid an extractor call every cycle.
 * One outcome function now locates and parses the reply for both decisions.
 *
 * Protects: a complete empty array with trailing prose (the reporter's three
 * retained samples) is memoized with a tombstone; output that is empty and then
 * carries takes, truncated output and prose-only output are still retried and
 * never tombstoned. Existing coverage tested the empty check only on clean or
 * leading-prose input, so the trailing-prose disagreement went unseen.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { defaultExtractor, extractorOutcome, runPhaseProposeTakes, EMPTY_EXTRACTION_TOMBSTONE_TEXT } from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const REPORTED_EMPTY = [
  '[]\n\nNo gradeable claims—this is purely factual (purpose, ownership, dates, source links).',
  '[]\n\nThis prose is purely factual (biographical/state facts), with no predictions, recommendations, or interpretive judgments to extract.',
  'This prose is purely factual/registry content (project statuses, file locations) with no predictions, judgments, or wagers.\n\n```json\n[]\n```',
];
const take = (claim: string) => JSON.stringify({ claim_text: claim, kind: 'take', holder: 'brain', weight: 0.6 });

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
});
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
  resetGateway();
});

function reply(text: string) {
  __setChatTransportForTests(async () => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }) as ChatResult);
}
const extract = () => defaultExtractor({ pagePath: 'wiki/registry-example', pageBody: 'Project statuses and file locations.', existingTakes: [] });

describe('#6782 defaultExtractor: a complete empty array with trailing prose is an empty extraction', () => {
  for (const [i, text] of REPORTED_EMPTY.entries()) {
    test(`reported sample ${i + 1} returns no takes instead of throwing`, async () => {
      reply(text);
      expect(await extract()).toEqual([]);
    });
  }

  test('an empty array followed by prose that carries a real takes array is retried, not memoized', async () => {
    reply(`[]\n\nOn reflection, these qualify:\n[${take('Demand will rise next year')}]`);
    await expect(extract()).rejects.toThrow('no parseable takes JSON (transient — retry)');
  });

  test('truncated and prose-only replies are still retried', async () => {
    for (const text of ['[', `[${take('A')},{"claim_text":"B"`, 'There are no gradeable claims here.', '']) {
      reply(text);
      await expect(extract()).rejects.toThrow('transient — retry');
    }
  });

  test('a non-empty array with trailing prose keeps its takes', async () => {
    reply(`[${take('Demand will rise next year')}]\n\nExplanation.`);
    expect((await extract()).map(t => t.claim_text)).toEqual(['Demand will rise next year']);
  });
});

describe('#6782 extractorOutcome', () => {
  test('the reported samples are valid_empty', () => {
    for (const text of REPORTED_EMPTY) expect(extractorOutcome(text)).toEqual({ kind: 'valid_empty' });
  });

  test('a later numeric citation or empty array does not make an empty reply non-empty', () => {
    expect(extractorOutcome('[]\nSee [1] and [2].')).toEqual({ kind: 'valid_empty' });
    expect(extractorOutcome('[]\n\n[]')).toEqual({ kind: 'valid_empty' });
  });

  test('empty followed by a takes array, a lone object or a later object is invalid', () => {
    expect(extractorOutcome(`[]\n[${take('A')}]`)).toEqual({ kind: 'invalid' });
    expect(extractorOutcome(`[] then ${take('A')}`)).toEqual({ kind: 'invalid' });
    expect(extractorOutcome('[]\n{"note":"more"}')).toEqual({ kind: 'invalid' });
  });

  test('object-first output still parses as non-empty and is never counted as empty', () => {
    const outcome = extractorOutcome(`Here is one:\n${take('Churn is seasonal')}\n]`);
    expect(outcome.kind).toBe('valid_nonempty');
    expect(outcome.kind === 'valid_nonempty' && outcome.takes.map(t => t.claim_text)).toEqual(['Churn is seasonal']);
    expect(extractorOutcome('{}')).toEqual({ kind: 'invalid' });
  });
});

describe('#6782 the phase memoizes a reported empty reply with a tombstone', () => {
  test('one extractor call, one tombstone, no failure', async () => {
    reply(REPORTED_EMPTY[0]!);
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const engine = {
      kind: 'pglite',
      async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
        captured.push({ sql, params: params ?? [] });
        if (sql.includes('FROM persistence_brain')) return [{ enabled: false } as unknown as T];
        if (sql.includes('SELECT slug, source_id, compiled_truth')) return [{ slug: 'wiki/registry-example', source_id: 'default', compiled_truth: 'Project statuses and file locations.' }] as T[];
        if (sql.includes('INSERT INTO take_proposals')) return [{ id: 1 } as unknown as T];
        return [];
      },
    } as unknown as BrainEngine;
    const ctx = { engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default' } as OperationContext;
    const result = await runPhaseProposeTakes(ctx, {});
    const details = result.details as Record<string, unknown>;
    expect(details.tombstones_written).toBe(1);
    expect(details.proposals_inserted).toBe(0);
    const tombstones = captured.filter(c => c.sql.includes('INSERT INTO take_proposals') && c.params.includes(EMPTY_EXTRACTION_TOMBSTONE_TEXT));
    expect(tombstones).toHaveLength(1);
  });
});
