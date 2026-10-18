/**
 * #6898: entity resolution attributed facts to a retired alias page.
 *
 * The reporter's brain had a canonical person page whose aliases were the
 * extractor's spellings in slug form (`alice-example`), and a retired page
 * (`canonical: false`, `superseded_by`, `status: historical-retired-alias`)
 * whose title carried the same name tokens. The alias arm missed because
 * `people/alice-example` and `Alice Example` never normalized to
 * `alice-example`, and the fuzzy arm then took the retired page as the only
 * same-name candidate. These tests replay that trace: the resolver must reach
 * the canonical page through the alias, never pick a retired page from a
 * guessing arm, follow `superseded_by` on an exact hit (bounded, cycle-safe,
 * visible targets only) and refuse when the redirect cannot be followed.
 *
 * Real PGLite; the Postgres twin is
 * test/e2e/entity-resolve-retired-alias-6898-postgres.test.ts. Placeholder
 * names only.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { seedRetiredAliasBrain, retiredAliasCases } from './helpers/retired-alias-6898.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedRetiredAliasBrain(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

retiredAliasCases(() => engine);

describe('#6898 facts backstop lands extracted facts on the canonical page', () => {
  test('entity_slug people/alice-example and Alice Example both attribute to the canonical page', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({ facts: [
        { fact: 'Alice Example moved the launch review to Thursday', kind: 'event', entity: 'people/alice-example', confidence: 1, notability: 'medium' },
        { fact: 'Alice Example prefers written status updates', kind: 'preference', entity: 'Alice Example', confidence: 1, notability: 'medium' },
      ] }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));
    const page = { slug: 'mail/thread-6898-example', type: 'note' as const, compiled_truth: 'a mail thread that mentions Alice Example several times. '.repeat(3), frontmatter: {} };
    const r = await runFactsBackstop(page, { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' });
    expect(r.mode).toBe('inline');
    if (r.mode !== 'inline') return;
    expect(r.inserted).toBe(2);
    const rows = await engine.executeRaw<{ entity_slug: string | null }>(
      'SELECT entity_slug FROM facts WHERE id = ANY($1::int[]) ORDER BY id', [r.fact_ids]);
    expect(rows.map(row => row.entity_slug)).toEqual(['people/aliceexample', 'people/aliceexample']);
  });
});
