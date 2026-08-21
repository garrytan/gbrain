/**
 * #895 — ranking-inversion headline pin.
 *
 * The oldest P1 in the repo: `gbrain query "Who is Zhang San"` ranked the
 * entity page the user asked about LAST while topical distractors (a concepts
 * page, a company page) floated to the top. The reporter's 5-page fixture now
 * ranks correctly on the lexical-only path; this test pins that end-to-end so
 * a future ranking-stage change can't silently reintroduce the inversion.
 *
 * Hermetic: PGLite + no-embed import (gateway configured with NO auth env, so
 * hybridSearch runs the keyword/lexical arms only — the same shape as the
 * reporter's no-provider environment).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

let engine: PGLiteEngine;

/** The issue's 5-page corpus, generic-name edition (people/zhangsan is the target). */
const FIXTURE: Array<{ slug: string; md: string }> = [
  {
    slug: 'people/zhangsan',
    md: [
      '---',
      'type: person',
      'title: Zhang San',
      '---',
      '',
      "Zhang San, famously known as \"The Human Hard Drive\", never forgets a face.",
      'Zhang San founded Goldfish Memory Tech and speaks at memory symposiums.',
    ].join('\n'),
  },
  {
    slug: 'people/lisi',
    md: [
      '---',
      'type: person',
      'title: Li Si',
      '---',
      '',
      'Li Si, nicknamed "The Spender", is an old friend of Zhang San.',
    ].join('\n'),
  },
  {
    slug: 'companies/goldfish-memory-tech',
    md: [
      '---',
      'type: company',
      'title: Goldfish Memory Tech',
      '---',
      '',
      'Goldfish Memory Tech builds memory prosthetics. Founded by Zhang San in 2025.',
    ].join('\n'),
  },
  {
    slug: 'meetings/may-2026-meetup',
    md: [
      '---',
      'type: meeting',
      'title: May 2026 Meetup',
      '---',
      '',
      'The symposium was held in May 2026. Zhang San and Li Si both attended.',
    ].join('\n'),
  },
  {
    slug: 'concepts/memory-augmented-retrieval',
    md: [
      '---',
      'type: concept',
      'title: Memory-Augmented Retrieval',
      '---',
      '',
      'Memory Spa Method: a memory-augmented retrieval technique built on spaced repetition.',
    ].join('\n'),
  },
];

beforeAll(async () => {
  // No auth env → isAvailable('embedding') false → lexical-only search, and
  // the vector dim is pinned (shard-order defense).
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const page of FIXTURE) {
    await importFromContent(engine, page.slug, page.md, { noEmbed: true });
  }
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('#895 lexical-only ranking of the reporter fixture', () => {
  test("'Who is Zhang San' ranks people/zhangsan first", async () => {
    const results = await hybridSearch(engine, 'Who is Zhang San', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.slug).toBe('people/zhangsan');
  });

  test('the least relevant page (concepts distractor) never outranks the entity page', async () => {
    const results = await hybridSearch(engine, 'Who is Zhang San', { limit: 10 });
    const zhangsanIdx = results.findIndex(r => r.slug === 'people/zhangsan');
    const conceptIdx = results.findIndex(r => r.slug === 'concepts/memory-augmented-retrieval');
    expect(zhangsanIdx).toBeGreaterThanOrEqual(0);
    if (conceptIdx >= 0) {
      expect(zhangsanIdx).toBeLessThan(conceptIdx);
    }
  });
});
