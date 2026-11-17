/**
 * GBRA-574 B2: the conversation extractor's per-fact slot (dimension, value) on the ontology columns.
 *
 * Protects: only a caller that asks for slots (the conversation extractor) gets the slot clause and schema field; every
 * other caller's system prompt stays byte-identical to the historical one (pinned by hash) and its schema has no slot;
 * the parser keeps a slot in the closed vocabulary (location, employer, role, after the dimension aliases) and drops an
 * unknown dimension, an empty or over-long value, and a slot on a fact with no entity, always keeping the fact.
 * Seams: gateway chat transport stub (no provider call).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { buildExtractorSystem, extractFactsFromTurnWithOutcome, type ExtractInput } from '../../src/core/facts/extract.ts';

function chatResult(text: string): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  } as ChatResult;
}

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
});
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
});

async function run(input: Partial<ExtractInput>, reply: unknown) {
  const seen: ChatOpts[] = [];
  __setChatTransportForTests(async (opts) => { seen.push(opts); return chatResult(JSON.stringify(reply)); });
  const outcome = await extractFactsFromTurnWithOutcome({ turnText: 'Alice Example (2026-03-10): I work at Acme Example now.', source: 'test:slots',
    variant: {}, embedding: null, ...input } as ExtractInput);
  return { seen, outcome };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** buildExtractorSystem on master before GBRA-574 B2, by (admitsLow, variant). */
const HISTORICAL: Array<[boolean, { dateGrounding?: boolean; attribution?: boolean }, string]> = [
  [true, {}, 'a4b468b86e867f3703a4c834583f5ac9a99f47ff4f0c50484fdd6b22706465c7'],
  [true, { dateGrounding: true }, 'd49e4a26fe594b8a4445172c736b1c7407af9fb55c20c7f7f9dce05e068bcd64'],
  [true, { attribution: true }, '525370d677f35fa2bd331c6ceff0be0fcd28b02e6478c9e869380699e139d8d2'],
  [true, { dateGrounding: true, attribution: true }, 'd500e15bf4e0b089cceb014018bbb157e281de76eb1e4c769024c4e9e4630edd'],
  [false, {}, '5df290c0002bfc73371897c339e1a34e33caf844e3fb6d24b35c05d47e862ddf'],
  [false, { dateGrounding: true }, '77d490254802af74d683c3876cc087534c6a578f4f5275db3bd6698909929fb3'],
  [false, { attribution: true }, '364637bf592f858bad211525a4dcb9c2fd15e3ea8cba2af90acb109e1cd7875a'],
  [false, { dateGrounding: true, attribution: true }, '3b15e8a337a2557ed4b81255cf27a386069490d6209567c753942d310064eb25'],
];

describe('slot prompt', () => {
  test('every prompt variant without slots is byte-identical to the historical one', () => {
    for (const [admitsLow, variant, hash] of HISTORICAL) expect(sha(buildExtractorSystem(admitsLow, variant))).toBe(hash);
  });

  test('a caller that does not ask for slots sends the historical prompt and a schema without a slot', async () => {
    const { seen } = await run({}, { facts: [] });
    expect(sha(seen[0]!.system as string)).toBe(HISTORICAL[0]![2]);
    expect(JSON.stringify(seen[0]!.responseSchema)).not.toContain('slot');
  });

  test('a caller that asks for slots gets the historical prompt plus the slot clause, and a nullable slot in the schema', async () => {
    const { seen } = await run({ slots: true } as Partial<ExtractInput>, { facts: [] });
    const system = seen[0]!.system as string;
    expect(system.startsWith(buildExtractorSystem(true, {}))).toBe(true);
    expect(system.length).toBeGreaterThan(buildExtractorSystem(true, {}).length);
    expect(system).toContain('"slot"');
    for (const d of ['location', 'employer', 'role']) expect(system).toContain(d);
    // About 150 tokens (4 characters a token): the clause stays short.
    expect(system.length - buildExtractorSystem(true, {}).length).toBeLessThan(1000);
    expect(JSON.stringify(seen[0]!.responseSchema)).toContain('"slot"');
  });
});

describe('slot parsing', () => {
  const fact = (text: string, slot: unknown, entity: string | null = 'people/alice-example') =>
    ({ fact: text, kind: 'fact', entity, confidence: 1, notability: 'high', slot });

  test('keeps a valid slot (aliases normalized, value trimmed) and drops every invalid one, keeping each fact', async () => {
    const { outcome } = await run({ slots: true } as Partial<ExtractInput>, { facts: [
      fact('Alice Example works at Acme Example.', { dimension: 'Company', value: '  Acme Example ' }),
      fact('Alice Example lives in Springfield.', { dimension: 'location', value: 'Springfield' }),
      fact('Alice Example is the head of design.', { dimension: 'job title', value: 'head of design' }),
      fact('Alice Example plays chess.', { dimension: 'hobby', value: 'chess' }),
      fact('Alice Example moved somewhere.', { dimension: 'location', value: '   ' }),
      fact('Alice Example has a very long title.', { dimension: 'role', value: 'x'.repeat(81) }),
      fact('Someone works at Acme Example.', { dimension: 'employer', value: 'Acme Example' }, null),
      fact('Alice Example likes tea.', null),
    ] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const slots = outcome.facts.map(f => [f.fact, (f as { dimension?: string | null }).dimension ?? null, (f as { value?: string | null }).value ?? null]);
    expect(slots).toEqual([
      ['Alice Example works at Acme Example.', 'employer', 'Acme Example'],
      ['Alice Example lives in Springfield.', 'location', 'Springfield'],
      ['Alice Example is the head of design.', 'role', 'head of design'],
      ['Alice Example plays chess.', null, null],
      ['Alice Example moved somewhere.', null, null],
      ['Alice Example has a very long title.', null, null],
      ['Someone works at Acme Example.', null, null],
      ['Alice Example likes tea.', null, null],
    ]);
  });

  test('reads the compact array form and a fact with no slot key, and still reads the object form', async () => {
    const bare = (text: string) => ({ fact: text, kind: 'fact', entity: 'people/alice-example', confidence: 1, notability: 'high' });
    const { seen, outcome } = await run({ slots: true } as Partial<ExtractInput>, { facts: [
      fact('Alice Example works at Acme Example.', ['employer', 'Acme Example']),
      fact('Alice Example lives in Springfield.', { dimension: 'location', value: 'Springfield' }),
      bare('Alice Example likes tea.'),
      fact('Alice Example plays chess.', ['hobby', 'chess']),
      fact('Alice Example is a role.', ['role']),
      fact('Alice Example is numbered.', ['role', 7]),
    ] });
    expect(seen[0]!.system as string).toContain('"slot":["');
    expect(seen[0]!.system as string).not.toContain('"slot":null');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.map(f => [f.fact, (f as { dimension?: string | null }).dimension ?? null, (f as { value?: string | null }).value ?? null])).toEqual([
      ['Alice Example works at Acme Example.', 'employer', 'Acme Example'],
      ['Alice Example lives in Springfield.', 'location', 'Springfield'],
      ['Alice Example likes tea.', null, null],
      ['Alice Example plays chess.', null, null],
      ['Alice Example is a role.', null, null],
      ['Alice Example is numbered.', null, null],
    ]);
  });

  test('an 80-character value is kept', async () => {
    const { outcome } = await run({ slots: true } as Partial<ExtractInput>, { facts: [fact('Alice Example has a long title.', { dimension: 'role', value: 'y'.repeat(80) })] });
    expect(outcome.ok && (outcome.facts[0] as { value?: string }).value).toBe('y'.repeat(80));
  });

  test('a caller that did not ask for slots stores none, even when the model returns one', async () => {
    const { outcome } = await run({}, { facts: [fact('Alice Example works at Acme Example.', { dimension: 'employer', value: 'Acme Example' })] });
    expect(outcome.ok && (outcome.facts[0] as { dimension?: string | null }).dimension).toBeFalsy();
  });
});
