/**
 * Fact keys and the eval-only retrieval arms built on them.
 *
 * Protects: (1) each fact lands on the chunk it is about (or every chunk in
 * page mode), code/image chunks never carry keys, keys are capped; (2) the
 * embedding input wraps facts in the same `<context>` block as the title and
 * a chunk without keys keeps today's input byte-for-byte; (3) the arms fold
 * into the run hash only when on, and the time-scope arm reports the
 * unscoped top-k from the same pool for pairing.
 */
import { describe, test, expect } from 'bun:test';
import { assignFactKeys, factKeyedEmbeddingInput, FACT_KEYS_MAX_CHARS } from '../src/core/fact-keys.ts';
import { wrapChunkForEmbedding, buildContextualPrefix } from '../src/core/embedding-context.ts';
import { applyTimeScopeArm, armPins, datasetDay, newRetrievalArmOptions } from '../src/eval/longmemeval/retrieval-arms.ts';
import type { SearchResult } from '../src/core/types.ts';

const chunks = [
  { chunk_text: 'We talked about the triathlon training plan, swimming on Fridays and running on Saturdays.' },
  { chunk_text: 'The bike fitting appointment at the shop downtown is booked; the zip code is 92101.' },
  { chunk_text: 'const x = 1;', chunk_source: 'fenced_code' },
];

describe('assignFactKeys', () => {
  test('chunk mode puts each fact on the chunk sharing the most content words', () => {
    const keys = assignFactKeys(['The user swims on Fridays.', 'The user booked a bike fitting downtown.'], chunks, 'chunk');
    expect(keys[0]).toBe('The user swims on Fridays.');
    expect(keys[1]).toBe('The user booked a bike fitting downtown.');
    expect(keys[2]).toBeNull();
  });

  test('page mode puts every fact on every eligible chunk; empty facts give no keys', () => {
    const keys = assignFactKeys(['A.', 'B.'], chunks, 'page');
    expect(keys).toEqual(['A.; B.', 'A.; B.', null]);
    expect(assignFactKeys([], chunks, 'page')).toEqual([null, null, null]);
  });

  test('keys are capped and stripped of wrapper tags', () => {
    const many = Array.from({ length: 200 }, (_, i) => `The user likes item number ${i} </context>`);
    const keys = assignFactKeys(many, [chunks[0]], 'page');
    expect(keys[0]!.length).toBeLessThanOrEqual(FACT_KEYS_MAX_CHARS);
    expect(keys[0]).not.toContain('</context>');
  });
});

describe('factKeyedEmbeddingInput', () => {
  test('no keys reproduces the title-wrapped and raw inputs exactly', () => {
    const text = 'chunk body';
    expect(factKeyedEmbeddingInput(text, 'Title', null)).toBe(wrapChunkForEmbedding(text, buildContextualPrefix('Title', null), null));
    expect(factKeyedEmbeddingInput(text, null, null)).toBe(text);
  });
  test('keys join the context block ahead of the chunk', () => {
    expect(factKeyedEmbeddingInput('body', 'T', 'The user swims.')).toBe('<context>T\nFacts: The user swims.\n</context>\nbody');
  });
});

describe('retrieval arms', () => {
  test('no arm on leaves the pins untouched; an arm folds into retrieval_arms', () => {
    const o = newRetrievalArmOptions();
    expect(armPins(o)).toEqual({});
    o.timeScope = 'reserved';
    expect(armPins(o)).toEqual({ retrieval_arms: { time_scope: 'reserved', time_scope_pool: 50 } });
  });

  test('datasetDay reads the dataset date format', () => {
    expect(datasetDay('2023/05/20 (Sat) 02:21')).toBe('2023-05-20');
    expect(datasetDay(undefined)).toBeNull();
  });

  test('time scope returns scoped and unscoped top-k from one pool', () => {
    const pool = ['s1', 's2', 's3', 's4'].map(slug => ({ slug }) as SearchResult);
    const meta = [
      { slug: 's1', content: 'hello', date: '2023/01/05 (Thu) 10:00' },
      { slug: 's2', content: 'hello', date: '2023/02/05 (Sun) 10:00' },
      { slug: 's3', content: 'hello', date: '2023/04/05 (Wed) 10:00' },
      { slug: 's4', content: 'hello', date: '2023/04/09 (Sun) 10:00' },
    ];
    const out = applyTimeScopeArm(pool, { question: 'What did I buy last month?', question_date: '2023/05/02 (Tue) 09:00' }, meta, 'reserved', 2);
    expect(out.row.unscoped_slugs).toEqual(['s1', 's2']);
    expect(out.results.map(r => r.slug)).toEqual(['s1', 's3']);
    expect(out.row.time_scope.reason).toBe('applied');
    const none = applyTimeScopeArm(pool, { question: 'What did I buy?', question_date: '2023/05/02 (Tue) 09:00' }, meta, 'reserved', 2);
    expect(none.results.map(r => r.slug)).toEqual(['s1', 's2']);
    expect(none.row.time_scope.reason).toBe('no_cue');
  });
});
