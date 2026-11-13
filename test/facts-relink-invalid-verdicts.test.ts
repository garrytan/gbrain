import { afterEach, expect, test } from 'bun:test';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { judgeBatch, type ModelVerdict } from '../src/core/facts/relink-model.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

const facts = [
  { id: 17, fact: 'Slept seven hours.' },
  { id: 29, fact: 'Took a walk.' },
];

async function judge(subjects: unknown[]) {
  __setChatTransportForTests(async () => ({
    text: JSON.stringify({ subjects }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'openai:synthetic',
    providerId: 'openai',
  }));
  // These responses should never reach the entity resolver.
  return judgeBatch({} as BrainEngine, 'default', 'openai:synthetic', facts);
}

const unknown = (id: number): ModelVerdict => ({ id, slug: null, reason: 'model_unparseable' });
const noSubject = (id: number): ModelVerdict => ({ id, slug: null, reason: 'no_subject' });

test('only a numeric batch index can assign a verdict', async () => {
  for (const i of ['0', false, null, [], [0], 0.5, -1, 2]) {
    expect(await judge([{ i, subject: null }, { i: 1, subject: null }]))
      .toEqual([unknown(17), noSubject(29)]);
  }
});

test('malformed subject values remain unknown beside an explicit null', async () => {
  for (const subject of [undefined, '', '  ', 0, false, [], {}]) {
    expect(await judge([{ i: 0, subject }, { i: 1, subject: null }]))
      .toEqual([unknown(17), noSubject(29)]);
  }
});

test('a malformed array entry does not discard other indexed verdicts', async () => {
  expect(await judge([null, 'invalid', { i: 1, subject: null }]))
    .toEqual([unknown(17), noSubject(29)]);
});

test('duplicate numeric indices stay unknown regardless of order or repetition', async () => {
  for (const subjects of [
    [null, null],
    [null, ''],
    ['', null],
    [null, '', null],
  ]) {
    expect(await judge([
      ...subjects.map(subject => ({ i: 0, subject })),
      { i: 1, subject: null },
    ])).toEqual([unknown(17), noSubject(29)]);
  }
});

test('a coercible index cannot invalidate an otherwise valid row', async () => {
  expect(await judge([{ i: '0', subject: 'invalid' }, { i: 0, subject: null }]))
    .toEqual([noSubject(17), unknown(29)]);
});
