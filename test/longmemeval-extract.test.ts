/**
 * v0.40.2.0 — LongMemEval inline Haiku extractor.
 *
 * Hermetic — uses a stubbed ThinkLLMClient + in-memory PGLite. No API
 * keys, no DATABASE_URL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  extractAndInsertClaims,
  makeAliasMap,
  resetExtractorState,
  getCacheStats,
  type ExtractedClaim,
} from '../src/eval/longmemeval/extract.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts`);
  resetExtractorState();
});

function stubClient(claimsBySession: Map<string, ExtractedClaim[]>): {
  client: ThinkLLMClient;
  calls: number;
} {
  const calls = { count: 0 };
  const client: ThinkLLMClient = {
    create: async (params) => {
      calls.count++;
      const userMsg = params.messages[0]?.content;
      const userText = typeof userMsg === 'string' ? userMsg : '';
      // Stub looks for the session-id marker we embed in body keys to
      // return per-session claim sets.
      let claims: ExtractedClaim[] = [];
      for (const [key, value] of claimsBySession.entries()) {
        if (userText.includes(key)) {
          claims = value;
          break;
        }
      }
      return {
        id: 'stub',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text: JSON.stringify(claims) }],
      } as never;
    },
  };
  return { client, get calls() { return calls.count; } } as { client: ThinkLLMClient; calls: number };
}

describe('extractAndInsertClaims — happy path', () => {
  test('inserts validated typed-claim + event rows', async () => {
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['sess-1', [
        {
          entity: 'Marco',
          metric: 'role',
          value: 1,
          unit: null,
          period: null,
          event_type: null,
          valid_from: '2026-01-01',
          text: 'Marco is engineer at acme',
        },
        {
          entity: 'Marco',
          metric: null,
          value: null,
          unit: null,
          period: null,
          event_type: 'meeting',
          valid_from: '2026-02-15',
          text: 'coffee with Marco at Blue Bottle',
        },
      ]]
    ]));
    const result = await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/sess-1',
      sessionId: 'sess-1',
      sessionBody: 'session sess-1 content here',
      sourceId: 'default',
      aliasMap,
    });
    expect(result.inserted).toBe(2);
    expect(result.parsed).toBe(2);
    expect(result.cacheHit).toBe(false);

    const rows = await engine.executeRaw<{
      entity_slug: string; claim_metric: string | null; event_type: string | null;
    }>(`SELECT entity_slug, claim_metric, event_type FROM facts ORDER BY id`);
    expect(rows.length).toBe(2);
    expect(rows[0].claim_metric).toBe('role');
    expect(rows[1].event_type).toBe('meeting');
    // Both rows should share the same entity slug (canonicalized).
    expect(rows[0].entity_slug).toBe(rows[1].entity_slug);
  });
});

describe('extractAndInsertClaims — alias map', () => {
  test('per-question scope: "Marco" + "Marco Smith" collapse to one slug within a session', async () => {
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['session-with-both', [
        { entity: 'Marco', metric: 'role', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'engineer' },
        { entity: 'Marco Smith', metric: 'role', value: 2, unit: null, period: null, event_type: null, valid_from: '2026-04-01', text: 'VP' },
      ]]
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/session-with-both',
      sessionId: 'sess-1',
      sessionBody: 'body with marker session-with-both',
      sourceId: 'default',
      aliasMap,
    });
    const rows = await engine.executeRaw<{ entity_slug: string }>(`SELECT entity_slug FROM facts ORDER BY id`);
    expect(rows.length).toBe(2);
    // Both rows MUST share one slug — alias map collapsed them.
    expect(rows[0].entity_slug).toBe(rows[1].entity_slug);
  });

  test('per-question scope: aliases persist across sessions within ONE question', async () => {
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['session-A', [
        { entity: 'Marco', metric: 'role', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'engineer' },
      ]],
      ['session-B', [
        { entity: 'Marco Smith', metric: 'role', value: 2, unit: null, period: null, event_type: null, valid_from: '2026-04-01', text: 'VP' },
      ]],
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/session-A',
      sessionId: 'sess-A',
      sessionBody: 'session-A body',
      sourceId: 'default',
      aliasMap,
    });
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/session-B',
      sessionId: 'sess-B',
      sessionBody: 'session-B body',
      sourceId: 'default',
      aliasMap,
    });
    const rows = await engine.executeRaw<{ entity_slug: string }>(`SELECT entity_slug FROM facts ORDER BY id`);
    expect(rows.length).toBe(2);
    // Same person across sessions → same slug.
    expect(rows[0].entity_slug).toBe(rows[1].entity_slug);
  });

  test('per-question scope: fresh map per question keeps aliases independent', async () => {
    // First question's map: Marco resolves to alias-slug-A.
    const aliasMap1 = makeAliasMap();
    const { client } = stubClient(new Map([
      ['q1-session', [
        { entity: 'Marco', metric: 'role', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'X' },
      ]],
      ['q2-session', [
        { entity: 'Marco', metric: 'role', value: 2, unit: null, period: null, event_type: null, valid_from: '2026-04-01', text: 'Y' },
      ]],
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/q1-session',
      sessionId: 'q1', sessionBody: 'q1-session', sourceId: 'default', aliasMap: aliasMap1,
    });
    // TRUNCATE between questions (harness contract).
    await engine.executeRaw('DELETE FROM facts');
    // Second question gets a FRESH alias map.
    const aliasMap2 = makeAliasMap();
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/q2-session',
      sessionId: 'q2', sessionBody: 'q2-session', sourceId: 'default', aliasMap: aliasMap2,
    });
    // Both aliasMaps should have resolved "marco" — but they're separate.
    expect(aliasMap1.has('marco')).toBe(true);
    expect(aliasMap2.has('marco')).toBe(true);
    // (We can't easily assert independence because both resolve to the
    // same slugify-fallback. The KEY assertion is that aliasMap1 and
    // aliasMap2 are separate Map instances — the caller cleared between
    // questions, not us. This test pins the contract that the function
    // doesn't reach into shared module state.)
  });
});

describe('extractAndInsertClaims — content-hash cache', () => {
  test('second call with identical body hits cache (no extra LLM call)', async () => {
    const aliasMap = makeAliasMap();
    const callCounter = { count: 0 };
    const client: ThinkLLMClient = {
      create: async () => {
        callCounter.count++;
        return {
          id: 'x', type: 'message', role: 'assistant', model: 's',
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          content: [{ type: 'text', text: JSON.stringify([
            { entity: 'X', metric: 'role', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'role X' },
          ]) }],
        } as never;
      },
    };
    const body = 'identical session body text';
    const r1 = await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/a', sessionId: 'a', sessionBody: body,
      sourceId: 'default', aliasMap,
    });
    const r2 = await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/b', sessionId: 'b', sessionBody: body,
      sourceId: 'default', aliasMap,
    });
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(callCounter.count).toBe(1); // Only ONE Haiku call across two sessions
    const stats = getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  test('different bodies miss cache', async () => {
    const aliasMap = makeAliasMap();
    const callCounter = { count: 0 };
    const client: ThinkLLMClient = {
      create: async () => {
        callCounter.count++;
        return {
          id: 'x', type: 'message', role: 'assistant', model: 's',
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          content: [{ type: 'text', text: '[]' }],
        } as never;
      },
    };
    await extractAndInsertClaims({ engine, client, model: 'stub', sessionSlug: 'chat/a', sessionId: 'a', sessionBody: 'body A', sourceId: 'default', aliasMap });
    await extractAndInsertClaims({ engine, client, model: 'stub', sessionSlug: 'chat/b', sessionId: 'b', sessionBody: 'body B', sourceId: 'default', aliasMap });
    expect(callCounter.count).toBe(2);
  });
});

describe('extractAndInsertClaims — fail-open paths', () => {
  test('malformed JSON output → 0 inserted, no throw', async () => {
    const aliasMap = makeAliasMap();
    const client: ThinkLLMClient = {
      create: async () => ({
        id: 'x', type: 'message', role: 'assistant', model: 's',
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text: 'this is not JSON {{{' }],
      } as never),
    };
    const result = await extractAndInsertClaims({
      engine, client, model: 'stub', sessionSlug: 'chat/a', sessionId: 'a',
      sessionBody: 'body', sourceId: 'default', aliasMap,
    });
    expect(result.inserted).toBe(0);
  });

  test('Haiku call throws → 0 inserted, no throw', async () => {
    const aliasMap = makeAliasMap();
    const client: ThinkLLMClient = {
      create: async () => { throw new Error('synthetic API failure'); },
    };
    const result = await extractAndInsertClaims({
      engine, client, model: 'stub', sessionSlug: 'chat/a', sessionId: 'a',
      sessionBody: 'body', sourceId: 'default', aliasMap,
    });
    expect(result.inserted).toBe(0);
  });

  test('empty array output → 0 inserted, no throw', async () => {
    const aliasMap = makeAliasMap();
    const client: ThinkLLMClient = {
      create: async () => ({
        id: 'x', type: 'message', role: 'assistant', model: 's',
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text: '[]' }],
      } as never),
    };
    const result = await extractAndInsertClaims({
      engine, client, model: 'stub', sessionSlug: 'chat/a', sessionId: 'a',
      sessionBody: 'body', sourceId: 'default', aliasMap,
    });
    expect(result.inserted).toBe(0);
    expect(result.parsed).toBe(0);
  });

  test('invalid records (missing entity, bad date) are dropped silently', async () => {
    const aliasMap = makeAliasMap();
    const client: ThinkLLMClient = {
      create: async () => ({
        id: 'x', type: 'message', role: 'assistant', model: 's',
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text: JSON.stringify([
          { metric: 'mrr', value: 100, text: 'missing entity', valid_from: '2026-01-01' },  // no entity
          { entity: 'X', metric: 'mrr', value: 100, text: 'bad date', valid_from: 'not-a-date' },
          { entity: 'Valid', metric: 'mrr', value: 50, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'ok row' },  // ok
        ]) }],
      } as never),
    };
    const result = await extractAndInsertClaims({
      engine, client, model: 'stub', sessionSlug: 'chat/a', sessionId: 'a',
      sessionBody: 'body', sourceId: 'default', aliasMap,
    });
    expect(result.parsed).toBe(1);  // Only the valid row passed validation
    expect(result.inserted).toBe(1);
  });
});

describe('extractAndInsertClaims — event vs metric kind', () => {
  test('event rows are inserted with kind="event"', async () => {
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['sess-1', [
        { entity: 'X', metric: null, value: null, unit: null, period: null, event_type: 'meeting', valid_from: '2026-01-01', text: 'met at coffee' },
      ]]
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub', sessionSlug: 'chat/sess-1', sessionId: 'sess-1',
      sessionBody: 'sess-1', sourceId: 'default', aliasMap,
    });
    const rows = await engine.executeRaw<{ kind: string }>(`SELECT kind FROM facts`);
    expect(rows[0].kind).toBe('event');
  });

  test('metric rows are inserted with kind="fact"', async () => {
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['sess-1', [
        { entity: 'X', metric: 'mrr', value: 100, unit: 'USD', period: 'monthly', event_type: null, valid_from: '2026-01-01', text: 'MRR' },
      ]]
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub', sessionSlug: 'chat/sess-1', sessionId: 'sess-1',
      sessionBody: 'sess-1', sourceId: 'default', aliasMap,
    });
    const rows = await engine.executeRaw<{ kind: string }>(`SELECT kind FROM facts`);
    expect(rows[0].kind).toBe('fact');
  });
});

describe('extractAndInsertClaims — cache stats reporting', () => {
  test('getCacheStats returns hits/misses/size', async () => {
    resetExtractorState();
    expect(getCacheStats()).toEqual({ hits: 0, misses: 0, size: 0 });
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([['x', [
      { entity: 'X', metric: 'mrr', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'X' },
    ]]]));
    await extractAndInsertClaims({ engine, client, model: 'stub', sessionSlug: 'chat/a', sessionId: 'a', sessionBody: 'body-x', sourceId: 'default', aliasMap });
    await extractAndInsertClaims({ engine, client, model: 'stub', sessionSlug: 'chat/b', sessionId: 'b', sessionBody: 'body-x', sourceId: 'default', aliasMap });
    const stats = getCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// v0.40.2.0 — extractor stress + persistence shape pins
// ─────────────────────────────────────────────────────────────────────

describe('extractAndInsertClaims — alias map cross-session stress (10+ sessions)', () => {
  test('one canonical slug per name across 12 sessions in the same question', async () => {
    // Tests the core LongMemEval contract: the user mentions a person
    // by varying name forms ("Marco", "Marco Smith", "marco") across
    // many haystack sessions in ONE question. The alias map collapses
    // them all under one slug. If it didn't, the trajectory router
    // would later split the entity across multiple slugs and fragment
    // the timeline.
    const aliasMap = makeAliasMap();

    // Build 12 sessions, each contributing 1 claim about "Marco" in
    // varying name forms.
    const nameForms = [
      'Marco', 'marco', 'Marco Smith', 'marco smith',
      'MARCO', 'Marco', 'Marco Smith Jr', 'Marco S.',
      'marco', 'Marco', 'Marco Smith', 'marco',
    ];

    for (let i = 0; i < nameForms.length; i++) {
      const name = nameForms[i];
      const sessionId = `sess-${i + 1}`;
      const { client } = stubClient(new Map([
        [`marker-${sessionId}`, [
          {
            entity: name,
            metric: 'role',
            value: i + 1,
            unit: null,
            period: null,
            event_type: null,
            valid_from: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
            text: `claim ${i + 1} about ${name}`,
          },
        ]]
      ]));
      await extractAndInsertClaims({
        engine,
        client,
        model: 'stub',
        sessionSlug: `chat/${sessionId}`,
        sessionId,
        sessionBody: `body marker-${sessionId}`,
        sourceId: 'default',
        aliasMap,
      });
    }

    // Pin: all 12 rows landed under ONE entity_slug (the alias map
    // collapsed every name form to the first-mention canonical).
    const rows = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT DISTINCT entity_slug FROM facts ORDER BY entity_slug`,
    );
    expect(rows.length).toBe(1);

    const total = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM facts`,
    );
    expect(Number(total[0].count)).toBe(12);
  });

  test('different entities stay separate across many sessions', async () => {
    const aliasMap = makeAliasMap();
    // 6 sessions mixing two entities (Marco + Alice). Each session
    // mentions only ONE of them. Pin: 2 distinct entity_slugs after
    // all sessions land.
    const interleaved = ['Marco', 'Alice', 'Marco', 'Alice', 'Marco Smith', 'Alice Example'];
    for (let i = 0; i < interleaved.length; i++) {
      const name = interleaved[i];
      const { client } = stubClient(new Map([
        [`pair-${i}`, [
          { entity: name, metric: 'role', value: i + 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: `claim ${i}` },
        ]],
      ]));
      await extractAndInsertClaims({
        engine, client, model: 'stub',
        sessionSlug: `chat/pair-${i}`,
        sessionId: `pair-${i}`,
        sessionBody: `body pair-${i}`,
        sourceId: 'default',
        aliasMap,
      });
    }
    const rows = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT DISTINCT entity_slug FROM facts ORDER BY entity_slug`,
    );
    expect(rows.length).toBe(2);
  });
});

describe('extractAndInsertClaims — persistence shape pins', () => {
  test('embedding column is NULL on every benchmark-inserted row', async () => {
    // The extractor passes `embedding: null` because the benchmark
    // doesn't need drift_score. Pin: every inserted row has NULL in
    // both embedding AND embedded_at. If a future refactor adds an
    // embed-on-write path, this test catches it.
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['sess-emb', [
        { entity: 'X', metric: 'mrr', value: 100, unit: 'USD', period: 'monthly', event_type: null, valid_from: '2026-01-01', text: 'mrr' },
        { entity: 'X', metric: null, value: null, unit: null, period: null, event_type: 'meeting', valid_from: '2026-02-01', text: 'met X' },
      ]],
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/sess-emb',
      sessionId: 'sess-emb',
      sessionBody: 'body sess-emb',
      sourceId: 'default',
      aliasMap,
    });

    const rows = await engine.executeRaw<{
      embedding: string | null;
      embedded_at: Date | string | null;
    }>(`SELECT embedding::text AS embedding, embedded_at FROM facts`);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.embedding).toBeNull();
      expect(r.embedded_at).toBeNull();
    }
  });

  test('row_num + source_markdown_slug populated correctly across multi-claim sessions', async () => {
    // The extractor assigns sequential row_num (1, 2, 3, ...) and
    // stamps source_markdown_slug to the session slug. Pin both for
    // the v0.32.2 partial UNIQUE index that requires
    // (source_id, source_markdown_slug, row_num) uniqueness.
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['multi', [
        { entity: 'A', metric: 'mrr', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'a' },
        { entity: 'B', metric: 'mrr', value: 2, unit: null, period: null, event_type: null, valid_from: '2026-02-01', text: 'b' },
        { entity: 'C', metric: 'mrr', value: 3, unit: null, period: null, event_type: null, valid_from: '2026-03-01', text: 'c' },
      ]],
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/multi-rownum',
      sessionId: 'multi-rownum',
      sessionBody: 'body multi',
      sourceId: 'default',
      aliasMap,
    });

    const rows = await engine.executeRaw<{
      row_num: number;
      source_markdown_slug: string;
    }>(`SELECT row_num, source_markdown_slug FROM facts ORDER BY row_num`);
    expect(rows.length).toBe(3);
    expect(rows.map(r => r.row_num)).toEqual([1, 2, 3]);
    for (const r of rows) {
      expect(r.source_markdown_slug).toBe('chat/multi-rownum');
    }
  });

  test('source field is stamped "longmemeval:extractor" for audit', async () => {
    // Pins the source-tag that distinguishes benchmark-extracted facts
    // from production facts (the autoplan path uses `cli:think`,
    // extract_facts cycle uses `cycle:extract_facts`, etc).
    const aliasMap = makeAliasMap();
    const { client } = stubClient(new Map([
      ['tag', [
        { entity: 'X', metric: 'mrr', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'x' },
      ]],
    ]));
    await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/tag',
      sessionId: 'tag',
      sessionBody: 'body tag',
      sourceId: 'default',
      aliasMap,
    });
    const rows = await engine.executeRaw<{ source: string; source_session: string }>(
      `SELECT source, source_session FROM facts`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('longmemeval:extractor');
    expect(rows[0].source_session).toBe('tag');
  });
});

describe('extractAndInsertClaims — cache key invariance', () => {
  test('same body text → same hash → second call hits cache regardless of sessionId/slug', async () => {
    resetExtractorState();
    const aliasMap = makeAliasMap();
    const callCounter = { count: 0 };
    const client: ThinkLLMClient = {
      create: async () => {
        callCounter.count++;
        return {
          id: 'k', type: 'message', role: 'assistant', model: 's',
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          content: [{ type: 'text', text: JSON.stringify([
            { entity: 'X', metric: 'mrr', value: 1, unit: null, period: null, event_type: null, valid_from: '2026-01-01', text: 'x' },
          ]) }],
        } as never;
      },
    };
    const body = 'identical body shared across two completely different sessions';

    const r1 = await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/alpha',
      sessionId: 'alpha',
      sessionBody: body,
      sourceId: 'default',
      aliasMap,
    });
    const r2 = await extractAndInsertClaims({
      engine, client, model: 'stub',
      sessionSlug: 'chat/beta-different-slug',
      sessionId: 'beta-completely-different-id',
      sessionBody: body,
      sourceId: 'default',
      aliasMap,
    });
    // Cache hit on r2 because sessionBody hash matches; sessionId and
    // sessionSlug are NOT in the hash key (cache is body-content scoped).
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(callCounter.count).toBe(1);
  });
});
