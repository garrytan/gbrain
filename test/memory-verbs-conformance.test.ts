/**
 * MEMORY_VERBS v1 conformance — the frozen-contract pin (Cathedral 1).
 *
 * In-process through dispatchToolCall (the exact layer both MCP transports
 * share), against in-memory PGLite. Covers:
 *   - recall legacy SUPERSET regression (G1B: legacy fields byte-equal,
 *     additions allowed — protocol_version everywhere, no carve-out)
 *   - server-side budget packing math (incl. budget < first item)
 *   - query-arm keyword degradation (never an error without embeddings)
 *   - remember contract: provenance_required, ttl forms (P30D trap), enum
 *     kinds, world default + the remote remember→recall round-trip [F2],
 *     private facts hidden from remote readers
 *   - entity: card shape vs RESPONSE_SCHEMAS, three resolution arms,
 *     miss→suggestions, ZERO-LLM guard (chat transport rigged to throw)
 *   - synthesize: [EXPENSIVE prefix, annotations, clean `unavailable` with
 *     suggestion when no LLM is configured [c10]
 *   - forget: idempotency (expired:false), not_found with suggestion
 *   - error-path envelopes [B6]: every error fixture's envelope carries
 *     protocol_version: 1 + a non-empty suggestion (entity missing name,
 *     context_pack malformed since, synthesize keyless unavailable — the
 *     runner's expectErrorCode branch checks code + suggestion only, so the
 *     protocol_version pin lives here), and a keyless --synthesize runner
 *     pass exercises the synthesize error arm end-to-end
 *   - writeSingleFact supersession rule [X1] + degraded dedup (embed seam)
 *   - negative conformance self-test [F3]: the runner FAILS a lying server
 *   - fixture mirror drift guard (cases.json === embedded module)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { RESPONSE_SCHEMAS, ERROR_SCHEMA, VERB_NAMES } from '../src/core/verbs.ts';
import {
  runConformance,
  validateAgainstSchema,
  type ConformanceClient,
} from '../src/core/verbs/conformance.ts';
import { CONFORMANCE_CASES } from '../src/core/verbs/conformance-fixtures.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  // Sidecar writes go to a temp file via the test seam — no global env mutation.
  home = mkdtempSync(join(tmpdir(), 'gbrain-verbs-test-'));
  __setUsageLogPathForTests(join(home, 'usage.jsonl'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setUsageLogPathForTests(null);
  // The deterministic-embedder tests configureGateway() with a FAKE OpenAI
  // key on the MODULE-GLOBAL gateway. Without a reset, every later file in
  // this shard process inherits "embeddings configured" and (with the test
  // transport also cleared) fires a REAL API call with the fake key — the
  // shard-8 turn-context 401 flake. Reset config AND both transports so the
  // file leaves the process exactly as it found it.
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
});

function localCtx(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  } as unknown as OperationContext;
}

/** Remote-shaped call through the shared dispatcher (what both transports do). */
async function callRemote(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, {
    remote: true,
    takesHoldersAllowList: ['world'],
    sourceId: 'default',
  });
  return { isError: res.isError === true, body: JSON.parse(res.content[0].text) };
}

async function seedPage(
  slug: string,
  title: string,
  type: string,
  body = 'Synthetic test content.',
) {
  const put = operationsByName['put_page'];
  await put.handler(localCtx(), {
    slug,
    content: `---\ntitle: ${title}\ntype: ${type}\n---\n\n# ${title}\n\n${body}\n`,
  });
}

async function seedEntityPage(slug: string, title: string, body = 'A synthetic test entity.') {
  await seedPage(slug, title, 'person', body);
}

describe('recall — G1B superset + budget packing', () => {
  it('legacy-param recall keeps every legacy field shape and adds only the v1 fields', async () => {
    const r1 = await callRemote('remember', {
      fact: 'superset regression fact',
      provenance: 'conformance test',
      entity: 'people/superset-test',
    });
    expect(r1.isError).toBe(false);

    const { isError, body } = await callRemote('recall', { entity: 'people/superset-test' });
    expect(isError).toBe(false);
    // Legacy envelope fields, unchanged shapes.
    expect(typeof body.total).toBe('number');
    expect(Array.isArray(body.facts)).toBe(true);
    const f = body.facts[0];
    const LEGACY_FACT_KEYS = [
      'id', 'fact', 'kind', 'entity_slug', 'visibility', 'notability', 'valid_from',
      'valid_until', 'expired_at', 'superseded_by', 'consolidated_at',
      'consolidated_into', 'source', 'source_session', 'confidence', 'created_at',
    ];
    for (const k of LEGACY_FACT_KEYS) expect(k in f).toBe(true);
    expect(typeof f.id).toBe('number'); // legacy numeric id is FROZEN
    // v1 additions (G1B superset — on EVERY response, no carve-out).
    expect(body.protocol_version).toBe(1);
    expect(f.fact_id).toBe(String(f.id));
    expect(f.provenance).toBe(f.source);
    // No query/budget params → no search/budget fields.
    expect('results' in body).toBe(false);
    expect('budget_tokens' in body).toBe(false);
  });

  it('budget packing reports consistent meta and drops everything under a 1-token budget', async () => {
    for (let i = 0; i < 3; i++) {
      await callRemote('remember', {
        fact: `budget fact number ${i} with some padding text to cost tokens`,
        provenance: 'conformance test',
        entity: 'people/budget-test',
      });
    }
    const big = await callRemote('recall', { entity: 'people/budget-test', budget_tokens: 10000 });
    expect(big.body.budget_tokens).toBe(10000);
    expect(big.body.budget_used).toBeGreaterThan(0);
    expect(big.body.budget_used).toBeLessThanOrEqual(10000);
    expect(big.body.dropped_count).toBe(0);
    expect(big.body.total).toBe(3);

    const tiny = await callRemote('recall', { entity: 'people/budget-test', budget_tokens: 1 });
    expect(tiny.body.total).toBe(0);
    expect(tiny.body.dropped_count).toBeGreaterThanOrEqual(3);
  });

  it('query arm degrades to keyword-only without an embedding provider — never an error', async () => {
    await seedEntityPage('people/query-arm-test', 'Query Arm Marker Qzx');
    const { isError, body } = await callRemote('recall', { query: 'Query Arm Marker Qzx' });
    expect(isError).toBe(false);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.search_degraded).toBe('keyword_only_no_embedding_provider');
    const violations = validateAgainstSchema(body, RESPONSE_SCHEMAS.recall);
    expect(violations).toEqual([]);
  });
});

describe('remember — contract behavior', () => {
  it("kind enum is frozen at the 5 protocol kinds — 'idea' is extractor/DB-only", () => {
    // docs/protocol/MEMORY_VERBS_v1.md:39-41 — the remember verb's kind enum
    // is a frozen protocol surface. The extractor/DB taxonomy gained 'idea'
    // (engine.ts FactKind, migration v145); the protocol enum MUST NOT.
    const kindEnum = operationsByName['remember'].params?.kind?.enum ?? [];
    expect(kindEnum).toEqual(['event', 'preference', 'commitment', 'belief', 'fact']);
    expect(kindEnum).not.toContain('idea');
  });

  it("recall's RESPONSE kind enum admits 'idea' — the reader must not be told a lie", () => {
    // The INPUT freeze above is the protocol contract (a caller cannot WRITE
    // an idea through the verb). The response side describes what the system
    // actually RETURNS: the extractor and the facts table carry 'idea', so a
    // stored idea fact flows back through recall. A response schema omitting
    // it would declare a contract the system itself violates. Widening a
    // response enum is strictly permissive for consumers.
    const { RESPONSE_SCHEMAS } = require('../src/core/verbs.ts') as {
      RESPONSE_SCHEMAS: Record<string, Record<string, unknown>>;
    };
    const facts = ((RESPONSE_SCHEMAS.recall as Record<string, Record<string, Record<string, unknown>>>)
      .properties?.facts) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    const kindEnum = facts?.items?.properties?.kind?.enum as string[] | undefined;
    expect(kindEnum).toEqual(['event', 'preference', 'commitment', 'belief', 'fact', 'idea']);
    // ...while the remember INPUT enum stays frozen at five (asserted above).
  });

  it('rejects empty provenance with provenance_required + a populated suggestion', async () => {
    const { isError, body } = await callRemote('remember', { fact: 'x', provenance: '   ' });
    expect(isError).toBe(true);
    expect(body.error).toBe('provenance_required');
    expect(typeof body.suggestion).toBe('string');
    expect(body.suggestion.length).toBeGreaterThan(0);
    expect(body.protocol_version).toBe(1);
  });

  it('rejects ISO-8601 duration ttl (P30D) with a self-correcting suggestion', async () => {
    const { isError, body } = await callRemote('remember', {
      fact: 'ttl trap', provenance: 'test', ttl: 'P30D',
    });
    expect(isError).toBe(true);
    expect(body.error).toBe('invalid_params');
    expect(body.suggestion).toContain('30d');
  });

  it('treats a null-like entity STRING ("null") as absent — never entity_slug=\'null\' (#4755)', async () => {
    // LLM callers emit the literal token "null" for subjectless statements;
    // it means what omitting the param means.
    const { isError, body } = await callRemote('remember', {
      fact: 'a gap statement with no subject', provenance: 'test', entity: 'null',
    });
    expect(isError).toBe(false);
    expect(body.status).toBe('inserted');
    expect(body.entity_slug).toBe(null);
  });

  it('accepts duration ttl and returns a future ISO valid_until; echoes null entity_slug', async () => {
    const { isError, body } = await callRemote('remember', {
      fact: 'expiring fact with ttl', provenance: 'test', ttl: '30d',
    });
    expect(isError).toBe(false);
    expect(typeof body.id).toBe('string');
    expect(body.status).toBe('inserted');
    expect(body.entity_slug).toBe(null); // omitted optional inputs echo as null
    expect(Date.parse(body.valid_until)).toBeGreaterThan(Date.now());
    const violations = validateAgainstSchema(body, RESPONSE_SCHEMAS.remember);
    expect(violations).toEqual([]);
  });

  it('remote remember→recall round-trip holds (world default [F2]); private facts stay hidden', async () => {
    await callRemote('remember', {
      fact: 'world-visible round-trip fact', provenance: 'test', entity: 'people/roundtrip-test',
    });
    await callRemote('remember', {
      fact: 'PRIVATE-SENTINEL fact', provenance: 'test', entity: 'people/roundtrip-test',
      visibility: 'private',
    });
    const { body } = await callRemote('recall', { entity: 'people/roundtrip-test' });
    const texts = body.facts.map((f: { fact: string }) => f.fact).join('|');
    expect(texts).toContain('world-visible round-trip fact');
    expect(texts).not.toContain('PRIVATE-SENTINEL');
  });
});

describe('entity — card, arms, zero LLM', () => {
  it('prefers an entity page when a newer conversation has the same exact title', async () => {
    await seedEntityPage('people/jordan-example', 'Jordan Example');
    await seedPage(
      'conversations/jordan-example-session',
      'Jordan Example',
      'conversation',
      'A newer conversation transcript with the same title.',
    );
    await engine.executeRaw(
      `UPDATE pages
          SET updated_at = CASE slug
            WHEN 'people/jordan-example' THEN '2026-01-01T00:00:00Z'::timestamptz
            ELSE '2026-02-01T00:00:00Z'::timestamptz
          END
        WHERE source_id = 'default'
          AND slug IN ('people/jordan-example', 'conversations/jordan-example-session')`,
    );

    const { isError, body } = await callRemote('entity', { name: 'Jordan Example' });
    expect(isError).toBe(false);
    expect(body.card.entity.slug).toBe('people/jordan-example');
    expect(body.suggestions).toContainEqual(expect.objectContaining({
      slug: 'conversations/jordan-example-session',
    }));
  });

  it('keeps an explicit namespaced slug above an entity-shaped exact-title collision', async () => {
    await seedPage('notes/exact-target', 'Operational Runbook', 'note');
    await seedEntityPage('people/slug-shaped-title', 'notes/exact-target');
    await engine.executeRaw(
      `UPDATE pages
          SET updated_at = CASE slug
            WHEN 'notes/exact-target' THEN '2026-01-01T00:00:00Z'::timestamptz
            ELSE '2026-02-01T00:00:00Z'::timestamptz
          END
        WHERE source_id = 'default'
          AND slug IN ('notes/exact-target', 'people/slug-shaped-title')`,
    );

    const { body } = await callRemote('entity', { name: 'notes/exact-target' });
    expect(body.card.entity.slug).toBe('notes/exact-target');
  });

  it('keeps an explicit alias above entity-type preference', async () => {
    await seedEntityPage('people/alias-title-collision', 'Jordan Alias');
    await seedPage('notes/alias-target', 'Archived Context', 'note');
    await engine.setPageAliases('notes/alias-target', 'default', ['jordan alias']);

    const { body } = await callRemote('entity', { name: 'Jordan Alias' });
    expect(body.card.entity.slug).toBe('notes/alias-target');
  });

  it('retains a non-entity exact-title page as the fallback when no entity page exists', async () => {
    await seedPage('notes/release-checklist', 'Release Checklist', 'note');

    const { body } = await callRemote('entity', { name: 'Release Checklist' });
    expect(body.found).toBe(true);
    expect(body.card.entity.slug).toBe('notes/release-checklist');
  });

  it('resolves an exact namespaced slug to a schema-valid card with the chat gateway rigged to throw', async () => {
    __setChatTransportForTests(() => {
      throw new Error('entity must NEVER call the chat LLM');
    });
    await seedEntityPage('people/card-test', 'Card Test Person', 'Runs engineering at a-company.');
    const { isError, body } = await callRemote('entity', { name: 'people/card-test' });
    expect(isError).toBe(false);
    expect(body.found).toBe(true);
    expect(typeof body.latency_ms).toBe('number');
    expect(body.card.entity.slug).toBe('people/card-test');
    expect(body.card.summary.length).toBeGreaterThan(0);
    const violations = validateAgainstSchema(body, RESPONSE_SCHEMAS.entity);
    expect(violations).toEqual([]);
  });

  it('resolves by exact title and by slug suffix (arms 2)', async () => {
    await seedEntityPage('people/arm-test-alice', 'Arm Test Alice');
    const byTitle = await callRemote('entity', { name: 'Arm Test Alice' });
    expect(byTitle.body.found).toBe(true);
    const bySuffix = await callRemote('entity', { name: 'arm-test-alice' });
    expect(bySuffix.body.found).toBe(true);
  });

  it('miss returns found:false + suggestions, never an error', async () => {
    await seedEntityPage('people/suggestion-source', 'Suggestion Source Person');
    const { isError, body } = await callRemote('entity', { name: 'zzz-definitely-absent-entity' });
    expect(isError).toBe(false);
    expect(body.found).toBe(false);
    expect(Array.isArray(body.suggestions)).toBe(true);
    const violations = validateAgainstSchema(body, RESPONSE_SCHEMAS.entity);
    expect(violations).toEqual([]);
  });

  it('[ship P1.2] entity card backlinks are source-isolated on BOTH sides (no foreign from_slug leak)', async () => {
    // Same slug exists in two sources; a foreign-source page links to the
    // default-source entity. The card must NOT surface the foreign edge/count.
    await seedEntityPage('people/iso-target', 'Iso Target');
    // Register the foreign tenant source (FK target) + a foreign page that
    // links INTO the default-source entity.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other-tenant', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, frontmatter, source_id, created_at, updated_at)
       VALUES ('people/foreign-linker', 'person', 'Foreign Linker', '# Foreign', '{}', 'other', NOW(), NOW())`,
      [],
    );
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       SELECT f.id, t.id, 'works_at', 'markdown'
         FROM pages f, pages t
        WHERE f.slug = 'people/foreign-linker' AND f.source_id = 'other'
          AND t.slug = 'people/iso-target' AND t.source_id = 'default'`,
      [],
    );
    const { body } = await callRemote('entity', { name: 'people/iso-target' });
    expect(body.found).toBe(true);
    // The foreign cross-source backlink must not appear in edges OR the count.
    const edgeSlugs = (body.card.edges as Array<{ slug: string }>).map(e => e.slug);
    expect(edgeSlugs).not.toContain('people/foreign-linker');
    expect(body.card.backlink_count).toBe(0);
  });

  it('[B6] missing required name is invalid_params with protocol_version 1 + a populated suggestion', async () => {
    const { isError, body } = await callRemote('entity', {});
    expect(isError).toBe(true);
    expect(body.error).toBe('invalid_params');
    expect(body.protocol_version).toBe(1);
    expect(typeof body.suggestion).toBe('string');
    expect(body.suggestion.trim().length).toBeGreaterThan(0);
    expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
  });

  it('remote card never carries private commitment facts (fence test)', async () => {
    await seedEntityPage('people/fence-test', 'Fence Test Person');
    await callRemote('remember', {
      fact: 'PRIVATE-SENTINEL commitment text', provenance: 'test',
      entity: 'people/fence-test', kind: 'commitment', visibility: 'private',
    });
    const { body } = await callRemote('entity', { name: 'people/fence-test' });
    expect(body.found).toBe(true);
    expect(JSON.stringify(body.card.open_threads)).not.toContain('PRIVATE-SENTINEL');
  });

  it('active_fact_count is exact beyond the fetch cap, source-scoped, and visibility-scoped', async () => {
    // Pre-fix, active_fact_count was facts.length under a 100-row fetch cap,
    // so entities with more facts silently reported 100.
    await seedEntityPage('people/count-truth-test', 'Count Truth Test Person');
    await engine.executeRaw(
      `INSERT INTO facts
         (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, created_at)
       SELECT 'default', 'people/count-truth-test', 'world fact ' || gs::text,
              'fact', 'world', 'medium', NOW(), 'conformance-seed', 1.0, NOW()
         FROM generate_series(1, 125) gs`,
      [],
    );
    await engine.insertFact(
      {
        fact: 'PRIVATE-COUNT-SENTINEL fact',
        kind: 'fact',
        entity_slug: 'people/count-truth-test',
        visibility: 'private',
        source: 'conformance-seed',
      },
      { source_id: 'default' },
    );
    // A same-slug fact in a foreign source must never inflate the count.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other-tenant', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.insertFact(
      {
        fact: 'FOREIGN-SOURCE-SENTINEL fact',
        kind: 'fact',
        entity_slug: 'people/count-truth-test',
        visibility: 'world',
        source: 'conformance-seed',
      },
      { source_id: 'other' },
    );

    // Remote: world-only — the 125 seeded world facts, exactly.
    const remote = await callRemote('entity', { name: 'people/count-truth-test' });
    expect(remote.body.card.active_fact_count).toBe(125);

    // Local: private rows count too (126); foreign source never does.
    const local = await operationsByName.entity.handler(localCtx(), { name: 'people/count-truth-test' });
    expect((local as { card: { active_fact_count: number } }).card.active_fact_count).toBe(126);
  });

  it('timeline dates honor the string|null card contract in-process (PGLite returns Date objects)', async () => {
    // The frozen RESPONSE_SCHEMAS type last_timeline_date and thread dates as
    // string|null, but PGLite returns a Date object for the DATE column. The
    // JSON wire hides this (Date.toJSON), so pin the IN-PROCESS card that
    // local consumers (loops, CLI rendering) read directly.
    await seedEntityPage('people/date-contract-test', 'Date Contract Test Person');
    await engine.addTimelineEntry(
      'people/date-contract-test',
      {
        date: new Date().toISOString().slice(0, 10),
        source: 'conformance-seed',
        summary: 'Recent event inside the open-thread window',
      },
      { sourceId: 'default' },
    );

    const res = await operationsByName.entity.handler(localCtx(), { name: 'people/date-contract-test' }) as {
      card: {
        last_touched: { last_timeline_date: unknown };
        open_threads: Array<{ kind: string; date: unknown }>;
      };
    };
    expect(typeof res.card.last_touched.last_timeline_date).toBe('string');
    const recent = res.card.open_threads.find(t => t.kind === 'recent_event');
    expect(recent).toBeDefined();
    for (const t of res.card.open_threads) {
      expect(t.date === null || typeof t.date === 'string').toBe(true);
    }
  });
});

describe('synthesize — marked expensive + unavailable conversion [c10]', () => {
  it('description starts with [EXPENSIVE and the tool def carries annotations', () => {
    const op = operationsByName['synthesize'];
    expect(op.description.startsWith('[EXPENSIVE')).toBe(true);
    const def = buildToolDefs([op])[0];
    expect(def.annotations?.readOnlyHint).toBe(true);
    expect(def.annotations?.title).toContain('costly');
  });

  it('delegates to runThink and returns the frozen envelope with a priced cost block (chat seam — no real LLM)', async () => {
    // Fully hermetic regardless of the dev/CI machine's ambient credentials:
    // runThink builds its client via a real-key check (hasAnthropicKey reads
    // process.env), NOT the gateway chat seam — so we must BOTH provide a fake
    // key via withEnv (so the client builds) AND install the chat seam (so no
    // real API call fires). Without the env key, CI (credential-free) takes the
    // NO_ANTHROPIC_API_KEY path → the verb's `unavailable` conversion → isError.
    __setChatTransportForTests(async () => ({
      text: JSON.stringify({ answer: 'Synthesized test answer.', citations: [], gaps: ['none'] }),
      blocks: [],
      stopReason: 'end' as const,
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001',
      providerId: 'anthropic',
    }));
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, async () =>
      callRemote('synthesize', { question: 'what do we know?' }),
    );
    expect(isError).toBe(false);
    expect(body.answer).toBe('Synthesized test answer.');
    expect(body.protocol_version).toBe(1);
    expect(body.cost.input_tokens).toBe(1200);
    expect(body.cost.output_tokens).toBe(80);
    expect(Array.isArray(body.sources)).toBe(true);
    // v0.45.x additive compose-status fields ride EVERY success response
    // (schema-optional for pre-v0.45.x servers, always emitted by this one).
    expect(body.synthesis_status).toBe('ok');
    expect(typeof body.pages_gathered).toBe('number');
    expect(typeof body.takes_gathered).toBe('number');
    expect(Array.isArray(body.warnings)).toBe(true);
    const violations = validateAgainstSchema(body, RESPONSE_SCHEMAS.synthesize);
    expect(violations).toEqual([]);
  });

  it('[B6/c10] keyless synthesize is a clean unavailable error with protocol_version 1 + a populated suggestion', async () => {
    // Forced-keyless hermetically: clear the module-global gateway (a prior
    // configureGateway env snapshot would satisfy resolveAnthropicKey), drop
    // the env var, and point GBRAIN_HOME at an empty dir so a dev machine's
    // real ~/.gbrain/config.json key can't flip the assertion (see emptyHome).
    resetGateway();
    const { isError, body } = await withEnv(
      { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() },
      async () => callRemote('synthesize', { question: 'keyless error-path probe' }),
    );
    expect(isError).toBe(true);
    expect(body.error).toBe('unavailable');
    expect(body.protocol_version).toBe(1);
    expect(typeof body.suggestion).toBe('string');
    expect(body.suggestion.trim().length).toBeGreaterThan(0);
    expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
  });
});

describe('context_pack — error-path envelope [B6]', () => {
  it('malformed since is invalid_params with protocol_version 1 + an ISO 8601 fix in the suggestion', async () => {
    const { isError, body } = await callRemote('context_pack', {
      entities: 'people/nobody-here',
      since: 'not-a-timestamp',
    });
    expect(isError).toBe(true);
    expect(body.error).toBe('invalid_params');
    expect(body.protocol_version).toBe(1);
    expect(body.suggestion).toContain('ISO 8601');
    expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
  });
});

describe('forget — idempotency + not_found', () => {
  it('expires once, reports expired:false on re-forget, not_found on unknown id', async () => {
    const r = await callRemote('remember', {
      fact: 'fact to forget', provenance: 'test', entity: 'people/forget-test',
    });
    const id = r.body.id as string;

    const first = await callRemote('forget', { id, reason: 'test cleanup' });
    expect(first.isError).toBe(false);
    expect(first.body.expired).toBe(true);
    expect(first.body.reason).toBe('test cleanup');
    expect(validateAgainstSchema(first.body, RESPONSE_SCHEMAS.forget)).toEqual([]);

    const second = await callRemote('forget', { id });
    expect(second.isError).toBe(false);
    expect(second.body.expired).toBe(false);
    expect(second.body.reason).toBe(null); // omitted optional → null

    const missing = await callRemote('forget', { id: '999999999' });
    expect(missing.isError).toBe(true);
    expect(missing.body.error).toBe('not_found');
    expect(missing.body.suggestion.length).toBeGreaterThan(0);
  });

  it('[ship P1.1] a remote caller in source A cannot forget a fact in source B (returns not_found, not expired)', async () => {
    // Register the 'other' tenant source (FK target) then seed a fact in it.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other-tenant', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.insertFact(
      { fact: 'cross-source secret fact', kind: 'fact', entity_slug: null, visibility: 'world', source: 'seed' },
      { source_id: 'other' },
    );
    const otherRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM facts WHERE source_id = 'other' AND fact = 'cross-source secret fact' LIMIT 1`,
      [],
    );
    const foreignId = String(otherRows[0].id);

    // Remote caller scoped to 'default' tries to forget the 'other'-source id.
    const res = await dispatchToolCall(engine, 'forget', { id: foreignId }, {
      remote: true, takesHoldersAllowList: ['world'], sourceId: 'default',
    });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(body.error).toBe('not_found'); // no cross-source existence leak

    // And the foreign fact is STILL active (not expired by the cross-source call).
    const stillActive = await engine.executeRaw<{ expired_at: Date | null }>(
      `SELECT expired_at FROM facts WHERE id = $1`,
      [otherRows[0].id],
    );
    expect(stillActive[0].expired_at).toBe(null);
  });

  it('[ship P1.1] a remote caller cannot forget a private fact (world-only)', async () => {
    const r = await callRemote('remember', {
      fact: 'private fact remote cannot forget', provenance: 'test',
      entity: 'people/private-forget-test', visibility: 'private',
    });
    // remote remember defaults world; force a private one locally instead.
    const localRes = await dispatchToolCall(engine, 'remember', {
      fact: 'truly private fact', provenance: 'test',
      entity: 'people/private-forget-test', visibility: 'private',
    }, { remote: false, sourceId: 'default' });
    const localId = JSON.parse(localRes.content[0].text).id as string;

    const res = await dispatchToolCall(engine, 'forget', { id: localId }, {
      remote: true, takesHoldersAllowList: ['world'], sourceId: 'default',
    });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(body.error).toBe('not_found'); // remote can't reach a private fact
    void r;
  });
});

describe('writeSingleFact — supersession rule [X1] + degraded dedup', () => {
  function installDeterministicEmbedder() {
    // The schema's facts.embedding column is the init-time default dim (1536);
    // test vectors must match or pgvector's CheckExpectedDim rejects the row.
    const DIM = 1536;
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: DIM,
      env: { OPENAI_API_KEY: 'sk-test-deterministic' },
    });
    // The seam replaces the AI SDK's embedMany({ model, values }) call.
    __setEmbedTransportForTests((async (opts: { values: string[] }) => ({
      embeddings: opts.values.map(t => {
        // Same vector for the SUPERSEDE-PAIR family (cosine 1.0 — above the
        // dedup threshold); a distinct deterministic vector otherwise.
        const v = new Array(DIM).fill(0);
        if (t.includes('SUPERSEDE-PAIR')) v[0] = 1;
        else for (let i = 0; i < 16; i++) v[i] = ((t.charCodeAt(i % t.length) % 13) + 1) / 13;
        return v;
      }),
    })) as never);
  }

  it('near-duplicate with changed text and same kind SUPERSEDES; identical text is a duplicate', async () => {
    installDeterministicEmbedder();
    const a = await writeSingleFact(engine, 'default', {
      fact: 'SUPERSEDE-PAIR alice works at acme-example',
      provenance: 'test', entity: 'people/supersede-test', kind: 'fact',
    });
    expect(a.status).toBe('inserted');
    expect(a.degraded_dedup).toBe(false);

    const dup = await writeSingleFact(engine, 'default', {
      fact: 'SUPERSEDE-PAIR alice works at acme-example',
      provenance: 'test', entity: 'people/supersede-test', kind: 'fact',
    });
    expect(dup.status).toBe('duplicate');
    expect(dup.id).toBe(a.id);

    const updated = await writeSingleFact(engine, 'default', {
      fact: 'SUPERSEDE-PAIR alice LEFT acme-example, now at widget-co',
      provenance: 'test', entity: 'people/supersede-test', kind: 'fact',
    });
    expect(updated.status).toBe('superseded');
    expect(updated.id).not.toBe(a.id);

    const rows = await engine.executeRaw<{ id: number; superseded_by: number | null }>(
      `SELECT id, superseded_by FROM facts WHERE id = $1`, [a.id],
    );
    expect(rows[0].superseded_by).toBe(updated.id);
  });

  it('reports degraded_dedup when no embedding provider is configured', async () => {
    const r = await withNoEmbeddingProvider(() =>
      writeSingleFact(engine, 'default', {
        fact: 'a fact written with no embedding provider',
        provenance: 'test', entity: 'people/degraded-test',
      }),
    );
    expect(r.status).toBe('inserted');
    expect(r.degraded_dedup).toBe(true);
  });
});

describe('conformance runner — negative self-test [F3]', () => {
  function lyingClient(corrupt: (verb: string, body: Record<string, unknown>) => Record<string, unknown>): ConformanceClient {
    return {
      listTools: async () =>
        VERB_NAMES.map(name => ({
          name,
          description: name === 'synthesize' ? '[EXPENSIVE / SLOW] x' : `MEMORY VERB (v1): ${name}`,
        })),
      callTool: async (name, params) => {
        const res = await dispatchToolCall(engine, name, params, {
          remote: true, takesHoldersAllowList: ['world'], sourceId: 'default',
        });
        const body = JSON.parse(res.content[0].text);
        const mutated = res.isError ? body : corrupt(name, body);
        return { isError: res.isError, text: JSON.stringify(mutated) };
      },
    };
  }

  it('a certifier that cannot fail certifies nothing: missing fields, bad enums, wrong id types all flag', async () => {
    // Mutation 1: remember drops the required `status` field.
    const r1 = await withNoEmbeddingProvider(() =>
      runConformance(
        lyingClient((verb, body) => (verb === 'remember' ? (({ status: _s, ...rest }) => rest)(body as { status?: unknown } & Record<string, unknown>) : body)),
        { marker: 'neg1' },
      ),
    );
    expect(r1.ok).toBe(false);

    // Mutation 2: remember returns an out-of-enum status.
    const r2 = await withNoEmbeddingProvider(() =>
      runConformance(
        lyingClient((verb, body) => (verb === 'remember' ? { ...body, status: 'absorbed' } : body)),
        { marker: 'neg2' },
      ),
    );
    expect(r2.ok).toBe(false);

    // Mutation 3: recall re-types fact_id to a number (the opaque-string mandate [T4]).
    const r3 = await withNoEmbeddingProvider(() =>
      runConformance(
        lyingClient((verb, body) => {
          if (verb !== 'recall' || !Array.isArray((body as { facts?: unknown[] }).facts)) return body;
          return {
            ...body,
            facts: (body.facts as Array<Record<string, unknown>>).map(f => ({ ...f, fact_id: Number(f.fact_id) })),
          };
        }),
        { marker: 'neg3' },
      ),
    );
    expect(r3.ok).toBe(false);

    // Honest server passes (sanity: the failures above are the mutations' doing).
    const honest = await withNoEmbeddingProvider(() =>
      runConformance(lyingClient((_v, b) => b), { marker: 'pos1' }),
    );
    const failures = honest.results.filter(r => r.status === 'fail');
    expect(failures).toEqual([]);
  }, 20_000); // v0.45.7: two full runConformance passes now exercise 7 verbs;
  // the default 5s budget flakes under the parallel shard runner (red-team F6).

  it('[B6] keyless self-cert with --synthesize passes via the unavailable error arm (cases run, never skip)', async () => {
    // The synthesize fixtures are dual-mode (keyed servers answer, keyless
    // servers must return the clean `unavailable` envelope). This run is the
    // CI assertion of the ERROR arm: forced keyless (no gateway, no env key,
    // empty config home — the chat transport seam is cleared by beforeEach)
    // with the cost gate OPEN, both synthesize cases must EXECUTE and pass
    // through the runner's unavailable+suggestion+ERROR_SCHEMA checks.
    resetGateway();
    const honest: ConformanceClient = {
      listTools: async () =>
        VERB_NAMES.map(name => ({
          name,
          description: name === 'synthesize' ? '[EXPENSIVE / SLOW] x' : `MEMORY VERB (v1): ${name}`,
        })),
      callTool: async (name, params) => {
        const res = await dispatchToolCall(engine, name, params, {
          remote: true, takesHoldersAllowList: ['world'], sourceId: 'default',
        });
        return { isError: res.isError, text: res.content[0].text };
      },
    };
    const r = await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () =>
      runConformance(honest, { marker: `keyless-${Date.now().toString(36)}`, synthesize: true }),
    );
    expect(r.results.filter(x => x.status === 'fail')).toEqual([]);
    const synth = r.results.filter(x => x.verb === 'synthesize' && !x.name.startsWith('tools/list') && !x.name.startsWith('synthesize is marked'));
    expect(synth.length).toBeGreaterThanOrEqual(2);
    expect(synth.every(x => x.status === 'pass')).toBe(true);
  }, 20_000);
});

describe('fixture mirror + surface invariants', () => {
  it('test/fixtures/memory-verbs/cases.json matches the embedded fixture module (BrainBench seed drift guard)', () => {
    const onDisk = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/memory-verbs/cases.json'), 'utf-8'));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(CONFORMANCE_CASES)));
  });

  it('every VERB_NAMES entry (7 as of v0.45.7) carries verb: true and nothing else does', async () => {
    const { operations } = await import('../src/core/operations.ts');
    const verbs = operations.filter(o => o.verb === true).map(o => o.name).sort();
    expect(verbs).toEqual([...VERB_NAMES].sort());
    // An accidental verb addition/removal must be a LOUD, named failure —
    // the frozen set is 5 core + 2 additive (context_pack, delta).
    expect(VERB_NAMES.length).toBe(7);
  });

  it('a pre-v0.45.7 five-verb endpoint still certifies (additive verbs skip, never fail)', async () => {
    const CORE = ['recall', 'remember', 'entity', 'synthesize', 'forget'];
    const fiveVerbClient: ConformanceClient = {
      listTools: async () =>
        CORE.map((name) => ({
          name,
          description: name === 'synthesize' ? '[EXPENSIVE / SLOW] cost-gated' : `MEMORY VERB (v1): ${name}`,
        })),
      callTool: async (name, params) => {
        const res = await dispatchToolCall(engine, name, params, {
          remote: true,
          takesHoldersAllowList: ['world'],
          sourceId: 'default',
        });
        return { isError: res.isError, text: res.content[0].text };
      },
    };
    const r = await withNoEmbeddingProvider(() =>
      runConformance(fiveVerbClient, { marker: `five-${Date.now()}` }),
    );
    // The additive verbs must appear ONLY as skips — never executed, never failed.
    const additive = r.results.filter((x) => x.verb === 'context_pack' || x.verb === 'delta');
    expect(additive.length).toBeGreaterThan(0);
    expect(additive.every((x) => x.status === 'skip')).toBe(true);
    // And no list-level advertising failure for them either.
    const advertFails = r.results.filter(
      (x) => x.name.startsWith('tools/list advertises') && x.status === 'fail',
    );
    expect(advertFails).toEqual([]);
  });
});

function withNoEmbeddingProvider<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv(
    {
      GBRAIN_HOME: emptyHome(),
      OPENAI_API_KEY: undefined,
      VOYAGE_API_KEY: undefined,
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    },
    async () => {
      resetGateway();
      __setEmbedTransportForTests(null);
      try {
        return await fn();
      } finally {
        resetGateway();
        __setEmbedTransportForTests(null);
      }
    },
  );
}
