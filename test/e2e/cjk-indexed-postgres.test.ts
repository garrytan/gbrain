import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('Postgres indexed CJK keyword search', () => {
  let engine: BrainEngine;

  beforeAll(async () => {
    engine = await setupDB();
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  }, 30_000);

  test('migration tokenizer emits unigrams and adjacent bigrams', async () => {
    const rows = await engine.executeRaw<{ tokens: string }>(
      'SELECT pmbrain_cjk_search_tokens($1) AS tokens',
      ['我家狗'],
    );

    expect(rows[0]?.tokens).toBe('我 我家 家 家狗 狗');
  });

  test('single-character and multi-character Chinese keywords use search_vector', async () => {
    await engine.putPage('inbox/pets', {
      type: 'note',
      title: '宠物记录',
      compiled_truth: '我家狗子叫靓靓，是金毛。二狗叫迪迪，是雪纳瑞。',
      timeline: '',
    });
    await engine.upsertChunks('inbox/pets', [{
      chunk_index: 0,
      chunk_text: '我家狗子叫靓靓，是金毛。二狗叫迪迪，是雪纳瑞。',
      chunk_source: 'compiled_truth',
    }]);

    const oneChar = await engine.searchKeyword('狗', { sourceId: 'default' });
    const name = await engine.searchKeyword('靓靓', { sourceId: 'default' });

    expect(oneChar[0]?.slug).toBe('inbox/pets');
    expect(name[0]?.slug).toBe('inbox/pets');
  });

  test('English keyword behavior remains available on the same vector', async () => {
    await engine.putPage('inbox/english', {
      type: 'note',
      title: 'Search compatibility',
      compiled_truth: 'NovaMind builds reliable enterprise agents.',
      timeline: '',
    });
    await engine.upsertChunks('inbox/english', [{
      chunk_index: 0,
      chunk_text: 'NovaMind builds reliable enterprise agents.',
      chunk_source: 'compiled_truth',
    }]);

    const results = await engine.searchKeyword('NovaMind', { sourceId: 'default' });
    expect(results[0]?.slug).toBe('inbox/english');
  });
});
