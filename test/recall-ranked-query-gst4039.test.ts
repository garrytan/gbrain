/**
 * GST-4039: ranked recall (#10225) follow-ups. A query whose only words are short or a date
 * ("AI", "2026") is searched and scored on those words instead of returning no facts; a fact
 * holding every query word is pooled however many partial matches outrank it; and the second
 * read of the ranked ids rechecks the whole read policy, so a fact narrowed between the two
 * reads is never returned. Keyless (keyword arm only), PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { QUESTION_POOL_DEPTH } from '../src/core/facts/question-recall.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { BULK_DAY_RULE, findBulkFactDays } from '../src/core/facts/bulk-days.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
/** Each fact's first word; a remote reader gets a fact quoted (#8042), so read inside its fence. */
const markers = (facts: R[]) => facts.map(f => (f.quoted === 'transcript' ? String(f.fact).split('\n')[2]! : String(f.fact)).split(' ')[0]);

let engine: PGLiteEngine;
const ids: Record<string, number> = {};
const ctxOf = (e: BrainEngine, remote: boolean): OperationContext => ({
  engine: e, config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote, transport: 'stdio', sourceId: 'default', emitNotice: () => {},
} as OperationContext);
const recall = async (p: R, e: BrainEngine = engine, remote = false) => (await operationsByName.recall.handler(ctxOf(e, remote), p)) as R;

async function fact(name: string, text: string, daysAgo: number): Promise<void> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, created_at, source, source_markdown_slug)
     VALUES ('default', NULL, $1, 'fact', 'world', now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval, 'test', 'notes/open-note') RETURNING id`,
    [text, String(daysAgo)]);
  ids[name] = Number(row.id);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setEmbedTransportForTests(null);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  await engine.putPage('notes/open-note', { type: 'note', title: 'open note', compiled_truth: 'An open note.' });
  await fact('ai', 'AIPLAN The AI roadmap ships in the spring', 40);
  await fact('year', 'YEARLY The 2026 budget closed in March', 41);
  await fact('offsite', 'OFFSITE The quarterly offsite moved to Denver', 1);
  await fact('allWords', 'ALLWORDS The orbital lantern ships with the probe', 60);
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, created_at, source, source_markdown_slug)
     SELECT 'default', NULL, 'PARTIAL' || g || ' orbital orbital orbital orbital survey of the orbital debris belt', 'fact', 'world', now() - interval '2 days', now() - interval '2 days', 'test', 'notes/open-note'
     FROM generate_series(1, $1::int) g`, [QUESTION_POOL_DEPTH + 1]);
  await fact('narrowed', 'NARROWED The zephyr harbor ferry runs weekly', 5);
}, 180_000);
afterAll(async () => { resetGateway(); await engine?.disconnect(); });
beforeEach(() => __resetPrivateVisibilityCacheForTests());

describe('a query of only short words or a date', () => {
  for (const [query, want] of [['AI', 'AIPLAN'], ['2026', 'YEARLY'], ['AI 2026', 'AIPLAN']] as const) {
    test(`"${query}" ranks the facts holding it instead of returning none`, async () => {
      const r = await recall({ query });
      expect(r.facts_order).toBe('relevance');
      expect(markers(r.facts)).toContain(want);
      expect(markers(r.facts)).not.toContain('OFFSITE');
      expect(r.facts_degraded?.reason).not.toBe('no_query_terms');
    });
  }

  test('a question works the same way, and a longer query still ignores its dates and short words', async () => {
    expect(markers((await recall({ question: 'AI' })).facts)).toContain('AIPLAN');
    expect(markers((await recall({ query: 'Denver offsite 2026' })).facts)).toEqual(['OFFSITE']);
  });
});

describe('the keyword pool', () => {
  test(`a fact holding every query word is pooled ahead of ${QUESTION_POOL_DEPTH + 1} higher-ranked partial matches`, async () => {
    const r = await recall({ query: 'orbital lantern' });
    expect(markers(r.facts)[0]).toBe('ALLWORDS');
  });
});

describe('the second read of the ranked ids', () => {
  test('a fact narrowed to private between the pool read and the row read is not returned to a remote caller', async () => {
    let narrowed = 0;
    // The second read is the typed member listPooledFactRows (the trunk moved master's raw `SELECT f.* ... id = ANY(...)` into it).
    const racing = new Proxy(engine, {
      get(target, prop) {
        const value = (target as never)[prop] as unknown;
        if (prop !== 'listPooledFactRows') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return async (...args: Parameters<BrainEngine['listPooledFactRows']>) => {
          if (narrowed === 0) {
            narrowed++;
            await target.executeRaw(`UPDATE facts SET visibility = 'private' WHERE id = $1`, [ids.narrowed]);
          }
          return target.listPooledFactRows(...args);
        };
      },
    }) as BrainEngine;
    try {
      expect(markers((await recall({ query: 'zephyr harbor' }, engine, true)).facts)).toEqual(['NARROWED']);
      const r = await recall({ query: 'zephyr harbor' }, racing, true);
      expect(narrowed).toBe(1);
      expect(markers(r.facts)).not.toContain('NARROWED');
    } finally {
      await engine.executeRaw(`UPDATE facts SET visibility = 'world' WHERE id = $1`, [ids.narrowed]);
    }
  });
});

describe('doctor fact_bulk_dates', () => {
  test('facts with no event date are not reported as one bulk day with no date', async () => {
    const n = BULK_DAY_RULE.min_facts * 2;
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, created_at, source)
       SELECT 'default', 'people/undated-' || (g % $2::int), 'UNDATED' || g || ' saved without an event date', 'fact', 'world', NULL, now() - interval '3 days', 'bulk-test'
       FROM generate_series(1, $1::int) g`, [n, BULK_DAY_RULE.min_entities + 2]);
    expect((await findBulkFactDays(engine, ['default'])).map(d => d.day)).toEqual([]);
  });
});

