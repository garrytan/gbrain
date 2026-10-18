/**
 * #3783: every query-side embedding outside hybrid search applies the brain's
 * `embedding_query_prefix`. Before the fix, think (CLI, MCP `think`, the
 * synthesize verb, CRAG escalation, auto-think), `takes search --semantic`,
 * `search diagnose` and eval's vector baseline embedded the bare question
 * while documents and hybrid search used the instruction, so those paths
 * compared an unprefixed query with a prefix-trained index.
 *
 * Each case runs the real path on an in-memory PGLite brain and records what
 * the (stubbed, $0) embedding transport receives: every query-side embed must
 * carry the prefix, the question's own embed included. No chat key is
 * configured, so think paths stop at their no-LLM result.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests, __clearQueryEmbedCacheForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const PREFIX = 'query: ';
let engine: PGLiteEngine;
let seen: string[] = [];
function configureEmbedding(): void {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
  __setEmbedTransportForTests((async (args: { values: string[] }) => {
    seen.push(...args.values);
    return { embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)) };
  }) as never);
}

/** Every query-side embed the path made carried the prefix, the question's included. */
function expectPrefixed(question: string): void {
  expect(seen).toContain(`${PREFIX}${question}`);
  expect(seen.filter(v => !v.startsWith(PREFIX))).toEqual([]);
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
}, 60_000);

afterEach(async () => {
  __setEmbedTransportForTests(null);
  __clearQueryEmbedCacheForTests();
  resetGateway();
  seen = [];
  for (const key of ['embedding_query_prefix', 'search.crag_think', 'dream.auto_think.enabled', 'dream.auto_think.questions']) {
    await engine.unsetConfig(key);
  }
});

describe('#3783: think entry points embed the question with the brain prefix', () => {
  test('synthesize verb', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    const { operationsByName } = await import('../src/core/operations.ts');
    await operationsByName['synthesize']!.handler({ engine, remote: false } as never, { question: 'what changed?' }).catch(() => {});
    expectPrefixed('what changed?');
  });

  test('MCP think op', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    const { operationsByName } = await import('../src/core/operations.ts');
    await operationsByName['think']!.handler({ engine, remote: false } as never, { question: 'what changed?' });
    expectPrefixed('what changed?');
  });

  test('CRAG think escalation on a weak query result', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    await engine.setConfig('search.crag_think', 'true');
    const { operationsByName } = await import('../src/core/operations.ts');
    await operationsByName['query']!.handler({ engine, remote: false } as never, { query: 'nothing in this brain matches zebra' });
    expectPrefixed('nothing in this brain matches zebra');
    expect(seen.filter(v => v === `${PREFIX}nothing in this brain matches zebra`).length).toBeGreaterThan(0);
  });

  test('CLI think', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    const { runThinkCli } = await import('../src/commands/think.ts');
    await quietly(() => runThinkCli(engine, ['what changed?', '--json']));
    expectPrefixed('what changed?');
  });

  test('dream auto-think', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    await engine.setConfig('dream.auto_think.enabled', 'true');
    await engine.setConfig('dream.auto_think.questions', JSON.stringify(['what changed?']));
    const { runPhaseAutoThink } = await import('../src/core/cycle/auto-think.ts');
    await runPhaseAutoThink(engine, { dryRun: false } as never);
    expectPrefixed('what changed?');
  });

  test('a brain without a prefix still embeds the bare question', async () => {
    configureEmbedding();
    const { operationsByName } = await import('../src/core/operations.ts');
    await operationsByName['think']!.handler({ engine, remote: false } as never, { question: 'what changed?' });
    expect(seen).toContain('what changed?');
    expect(seen.filter(v => v.startsWith(PREFIX))).toEqual([]);
  });
});

describe('#3783: direct query embeds apply the brain prefix', () => {
  test('takes search --semantic', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    const { runTakes } = await import('../src/commands/takes.ts');
    await withEnv({ OPENAI_API_KEY: 'sk-fake' }, () => quietly(() => runTakes(engine, ['search', 'widget roadmap', '--semantic', '--json'])));
    expect(seen).toEqual([`${PREFIX}widget roadmap`]);
  });

  test('search diagnose vector layer', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    const { runSearchDiagnose } = await import('../src/commands/search-diagnose.ts');
    await quietly(() => runSearchDiagnose(engine, ['diagnose', 'widget roadmap', '--target', 'notes/widget-roadmap', '--json']));
    expect(seen).toEqual([`${PREFIX}widget roadmap`]);
  });

  test('eval vector baseline', async () => {
    configureEmbedding();
    await engine.setConfig('embedding_query_prefix', PREFIX);
    const { runEval } = await import('../src/core/search/eval.ts');
    await runEval(engine, [{ query: 'widget roadmap', relevant: ['notes/widget-roadmap'] }], { strategy: 'vector' } as never, 5);
    expect(seen).toEqual([`${PREFIX}widget roadmap`]);
  });
});
