/**
 * Turn-context assembly tests (agent-bootstrap plan: S3#1 visibility fence,
 * ENG-1 8KB budget, ENG-11 hot-memory cache reuse, CX-P1.2 subordinate
 * envelope, CX2-11 typed session identity + two-session cache isolation).
 *
 * Hermetic in-memory PGLite; engine-agnostic assembly (no engine-specific SQL
 * in the module under test).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  resetGateway,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  assembleTurnContext,
  TURN_CONTEXT_ENVELOPE,
  TURN_CONTEXT_DEFAULT_MAX_BYTES,
} from '../src/core/context/turn-context.ts';
import {
  getBrainHotMemoryMeta,
  bumpHotMemoryCache,
  __resetHotMemoryCacheForTests,
} from '../src/core/facts/meta-hook.ts';
import { buildOperationContext } from '../src/mcp/dispatch.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WindowTurn } from '../src/core/context/entity-salience.ts';
import {
  loadCorpusPages,
  loadCorpusBeliefs,
  loadCorpusBeliefData,
  loadCorpusQueries,
} from './helpers/bootstrap-corpus.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  // This file's corpus writes fire embed attempts iff the module-global
  // gateway looks configured AND keyed. A shard-mate can leave it configured
  // with a fake test key — the preload's beforeEach only restores when the
  // gateway is UNCONFIGURED, so that state persists and put_page 401s against
  // real OpenAI (the shard-8 flake). Reset back to the preload baseline
  // (real process.env → keyless degrade on CI) regardless of shard-mates.
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  __resetHotMemoryCacheForTests();
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  await engine.executeRaw('DELETE FROM pages').catch(() => {});
});

async function seedPage(slug: string, title: string, body: string) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', 'person', $2, $3, '')`,
    [slug, title, body],
  );
}

async function seedFact(fact: string, visibility: 'private' | 'world', opts: { session?: string; entity?: string } = {}) {
  await engine.insertFact(
    {
      fact,
      kind: 'fact',
      entity_slug: opts.entity ?? 'people/alice-example',
      source: 'test',
      visibility,
      source_session: opts.session ?? null,
    },
    { source_id: 'default' },
  );
}

describe('assembleTurnContext', () => {
  test('envelope first, pointers + world facts in; private facts NEVER [CX-P1.2, S3#1]', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example is a founder at acme-example.');
    await seedFact('WORLD-FACT alice prefers async updates', 'world');
    await seedFact('PRIVATE-FACT sensitive valuation note', 'private');

    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'catching up with Alice Example tomorrow' }],
    });

    expect(r.text.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
    expect(r.pointers.length).toBe(1);
    expect(r.pointers[0].slug).toBe('people/alice-example');
    expect(r.text).toContain('people/alice-example');
    expect(r.text).toContain('WORLD-FACT');
    expect(r.text).not.toContain('PRIVATE-FACT');
    expect(r.text).not.toContain('sensitive valuation note');
    expect(r.factsCount).toBe(1);
    expect(r.degradedReason).toBeUndefined();
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(TURN_CONTEXT_DEFAULT_MAX_BYTES);
  });

  test('volunteer section dedupes against reflex pointers (slug appears once)', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example founder profile.');
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [
        { role: 'user', text: 'Alice Example pinged me' },
        { role: 'assistant', text: 'noted — Alice Example wants a follow-up' },
      ],
    });
    const hits = r.text.split('`people/alice-example`').length - 1;
    expect(hits).toBe(1);
  });

  test('result.volunteered carries the POST-trim survivors (feedback-loop input, never the pre-budget pool)', async () => {
    // Two distinct entities: one resolves as a reflex pointer (subject of the
    // newest turn), the other only via the volunteer arm.
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example founder profile.');
    await seedPage('companies/widget-co', 'Widget Co', 'Widget Co company page.');
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [
        { role: 'user', text: 'Widget Co update?' },
        { role: 'user', text: 'and what about Widget Co and Alice Example today?' },
      ],
    });
    // Whatever the split between arms, the union of pointers + volunteered is
    // exactly what the rendered text carries — the delivery-point logger's
    // contract (logging a trimmed-out page would corrupt precision stats).
    const surfaced = [...r.pointers.map((p) => p.slug), ...(r.volunteered ?? []).map((v) => v.slug)];
    for (const slug of surfaced) {
      expect(r.text).toContain(slug);
    }
    expect(surfaced.length).toBeGreaterThan(0);
    // No overlap between the arms (volunteer dedupes against pointers).
    expect(new Set(surfaced).size).toBe(surfaced.length);
    // volunteered is always present on a fresh assembly (empty when none).
    expect(Array.isArray(r.volunteered)).toBe(true);
  });

  test('budget-trimmed volunteered pages are excluded from result.volunteered (never the pre-budget pool)', async () => {
    // Five distinct entities: pointers arm takes its cap, the volunteer arm
    // takes the rest; a tight maxBytes then forces the volunteered while-loop
    // to drop at least one. The invariant under test: result.volunteered is
    // EXACTLY the set present in the rendered text — a copy-before-trim
    // refactor would silently log trimmed-out pages to the precision stats.
    // Lowercase lead-in: a capitalized verb would merge into the first
    // candidate's capitalized run and drop it from extraction.
    const names = ['Aaa Corp', 'Bbb Corp', 'Ccc Corp', 'Ddd Corp', 'Eee Corp', 'Fff Corp', 'Ggg Corp'];
    for (const n of names) {
      const slug = `companies/${n.split(' ')[0].toLowerCase()}`;
      await seedPage(slug, n, `${n} — ${'synopsis filler '.repeat(20)}.`);
    }
    const window = [{ role: 'user' as const, text: `we saw ${names.join(', ')} today` }];
    const full = await assembleTurnContext(engine, { sourceId: 'default', window });
    const fullVolunteered = full.volunteered ?? [];
    expect(fullVolunteered.length).toBeGreaterThan(1); // needs ≥2 to trim meaningfully

    // Budget sized to keep the block but force dropping ≥1 volunteered page.
    const tight = Math.max(600, Buffer.byteLength(full.text, 'utf8') - 150);
    const r = await assembleTurnContext(engine, { sourceId: 'default', window, maxBytes: tight });
    expect(r.degradedReason).toBe('budget_trimmed');
    const trimmed = r.volunteered ?? [];
    expect(trimmed.length).toBeLessThan(fullVolunteered.length); // ≥1 dropped
    for (const v of trimmed) expect(r.text).toContain(v.slug); // survivors ARE in the text
    const droppedSlugs = fullVolunteered.map((v) => v.slug).filter((s) => !trimmed.some((v) => v.slug === s));
    expect(droppedSlugs.length).toBeGreaterThan(0);
    for (const s of droppedSlugs) expect(r.text).not.toContain(s); // dropped are NOT in the text
  });

  test('budget trims facts BEFORE pointers, lowest confidence first [ENG-1]', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example founder profile.');
    for (let i = 0; i < 8; i++) {
      await seedFact(`WORLD-FACT-${i} ${'detail '.repeat(20)}`, 'world');
    }
    const maxBytes = 500;
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'sync with Alice Example' }],
      maxBytes,
    });
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(r.degradedReason).toBe('budget_trimmed');
    // The pointer survives — facts absorb the trim first.
    expect(r.pointers.length).toBe(1);
    expect(r.text).toContain('people/alice-example');
    expect(r.factsCount).toBeLessThan(8);
  });

  test('absurdly small budget → empty text rather than a broken envelope', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example founder profile.');
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'ping Alice Example' }],
      maxBytes: 10,
    });
    expect(r.text).toBe('');
    expect(r.degradedReason).toBe('budget_trimmed');
  });

  test('empty window still serves the hot-memory digest (session-start case)', async () => {
    await seedFact('WORLD-FACT standup moved to 9am', 'world');
    const r = await assembleTurnContext(engine, { sourceId: 'default', window: [] });
    expect(r.pointers.length).toBe(0);
    expect(r.factsCount).toBe(1);
    expect(r.text).toContain('WORLD-FACT standup moved to 9am');
    expect(r.text.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
  });

  test('nothing to inject → empty text, zero counts, no degradation', async () => {
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'no entities here, just vibes' }],
    });
    expect(r.text).toBe('');
    expect(r.pointers.length).toBe(0);
    expect(r.factsCount).toBe(0);
    expect(r.degradedReason).toBeUndefined();
  });
});

describe('session cache isolation [CX2-11]', () => {
  function metaCtx(sessionId?: string): OperationContext {
    return {
      engine,
      config: {} as GBrainConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      sessionId,
      takesHoldersAllowList: ['world'],
    };
  }

  test('two sessions on one source cache DIFFERENT fact sets per session key', async () => {
    await seedFact('SESSION-A-FACT prefers morning meetings', 'world', { session: 'sess-a' });
    await seedFact('SESSION-B-FACT prefers evening meetings', 'world', { session: 'sess-b' });

    const a = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    const b = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-b'));
    const aFacts = (a!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    const bFacts = (b!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(aFacts).toContain('SESSION-A-FACT prefers morning meetings');
    expect(aFacts).not.toContain('SESSION-B-FACT prefers evening meetings');
    expect(bFacts).toContain('SESSION-B-FACT prefers evening meetings');
    expect(bFacts).not.toContain('SESSION-A-FACT prefers morning meetings');
    expect((a!.brain_hot_memory as { session_id: string }).session_id).toBe('sess-a');
    expect((b!.brain_hot_memory as { session_id: string }).session_id).toBe('sess-b');
  });

  test('cache entries are per-session: bumping one session leaves the other cached', async () => {
    await seedFact('SESSION-A-FACT original', 'world', { session: 'sess-a' });
    await seedFact('SESSION-B-FACT original', 'world', { session: 'sess-b' });

    // Prime both cache entries.
    await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    await getBrainHotMemoryMeta('get_stats', metaCtx('sess-b'));

    // New session-A fact is invisible until session A's entry is bumped.
    await seedFact('SESSION-A-FACT fresher', 'world', { session: 'sess-a' });
    const cachedA = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    const cachedAFacts = (cachedA!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(cachedAFacts).not.toContain('SESSION-A-FACT fresher'); // still cached

    bumpHotMemoryCache('default', 'sess-a');
    const freshA = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    const freshAFacts = (freshA!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(freshAFacts).toContain('SESSION-A-FACT fresher');

    // Session B's cached entry was untouched by the session-A bump.
    const stillB = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-b'));
    const stillBFacts = (stillB!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(stillBFacts).toEqual(['SESSION-B-FACT original']);
  });
});

describe('dispatch typed session identity [CX2-11]', () => {
  const fakeEngine = {} as unknown as BrainEngine;

  test('_meta.session_id inside tool arguments lands on ctx.sessionId', () => {
    const ctx = buildOperationContext(fakeEngine, { _meta: { session_id: 'topic-42' } }, { remote: true, sourceId: 'default' });
    expect(ctx.sessionId).toBe('topic-42');
  });

  test('session id is clamped to 256 chars', () => {
    const long = 'x'.repeat(300);
    const ctx = buildOperationContext(fakeEngine, { _meta: { session_id: long } }, { remote: true, sourceId: 'default' });
    expect(ctx.sessionId!.length).toBe(256);
    const viaOpts = buildOperationContext(fakeEngine, {}, { remote: true, sourceId: 'default', sessionId: long });
    expect(viaOpts.sessionId!.length).toBe(256);
  });

  test('transport-resolved opts.sessionId wins over arguments-level _meta', () => {
    const ctx = buildOperationContext(
      fakeEngine,
      { _meta: { session_id: 'from-args' } },
      { remote: true, sourceId: 'default', sessionId: 'from-transport' },
    );
    expect(ctx.sessionId).toBe('from-transport');
  });

  test('non-string / absent _meta.session_id → undefined (never a crash)', () => {
    expect(buildOperationContext(fakeEngine, {}, { sourceId: 'default' }).sessionId).toBeUndefined();
    expect(buildOperationContext(fakeEngine, { _meta: { session_id: 42 } }, { sourceId: 'default' }).sessionId).toBeUndefined();
    expect(buildOperationContext(fakeEngine, { _meta: 'nope' }, { sourceId: 'default' }).sessionId).toBeUndefined();
    expect(buildOperationContext(fakeEngine, { _meta: { session_id: '' } }, { sourceId: 'default' }).sessionId).toBeUndefined();
  });
});

describe('corpus recall on a multi-entity brain [S3#1 fence, real recall]', () => {
  // Deterministic proper-case surface for a slug tail so the zero-LLM,
  // proper-case-biased entity resolver fires on a page-kind query.
  //   'concepts/graph-traversal' → 'Graph Traversal'
  const nameFromSlug = (slug: string): string =>
    slug
      .split('/')
      .pop()!
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

  test('every gold query: world answer surfaces, private beliefs are fenced, named pages resolve to pointers', async () => {
    // beforeEach cleared pages/facts/aliases. Seed the WHOLE synthetic world
    // through the real handlers: put_page fires auto-link + search vector,
    // insertFact honors each belief's declared visibility.
    const slugs = await loadCorpusPages(engine, { sourceId: 'default' });
    expect(slugs.length).toBeGreaterThanOrEqual(12);
    const inserted = await loadCorpusBeliefs(engine, { sourceId: 'default' });
    expect(inserted).toBe(loadCorpusBeliefData().length);
    // Beliefs were inserted after any prior meta read this test — start the
    // hot-memory cache clean so the world/private tiers are (re)computed.
    __resetHotMemoryCacheForTests();

    const privateTexts = loadCorpusBeliefData()
      .filter((b) => b.visibility === 'private')
      .map((b) => b.text);
    expect(privateTexts.length).toBeGreaterThanOrEqual(3);

    const queries = loadCorpusQueries();
    expect(queries.length).toBeGreaterThan(0);

    // Collect every violation with its gold-case id so a regression names the
    // exact query + assertion that broke, instead of a bare boolean.
    const violations: string[] = [];
    for (const q of queries) {
      // Page-kind: name the entity so the reflex resolver runs against the real
      // 12-page graph. belief / fence: the raw query — only the world/private
      // hot-memory fence decides what surfaces.
      const window: WindowTurn[] =
        q.kind === 'page' && q.expect_slug
          ? [{ role: 'user', text: `the latest on ${nameFromSlug(q.expect_slug)}` }]
          : [{ role: 'user', text: q.query }];
      const r = await assembleTurnContext(engine, { sourceId: 'default', window });

      // Fence (S3#1): NO private belief text ever crosses into the block,
      // regardless of what the user asked.
      for (const pt of privateTexts) {
        if (r.text.includes(pt)) violations.push(`${q.id}: leaked private belief "${pt.slice(0, 40)}…"`);
      }
      if (q.must_not_substring && r.text.includes(q.must_not_substring)) {
        violations.push(`${q.id}: fenced substring surfaced "${q.must_not_substring}"`);
      }
      if (q.kind === 'belief' && q.expect_substring && !r.text.includes(q.expect_substring)) {
        violations.push(`${q.id}: world belief not recalled "${q.expect_substring}"`);
      }
      if (q.kind === 'page' && q.expect_slug) {
        if (!r.pointers.some((p) => p.slug === q.expect_slug)) {
          violations.push(`${q.id}: entity did not resolve to a pointer (${q.expect_slug})`);
        }
        if (!r.text.includes(q.expect_slug)) {
          violations.push(`${q.id}: expected slug missing from the block (${q.expect_slug})`);
        }
      }
    }
    expect(violations).toEqual([]);
  }, 120_000);

  test('reflex pointer synopsis carries real page-body content, not a generic stub', async () => {
    await loadCorpusPages(engine, { sourceId: 'default' });
    // Named entity → pointer, and the pointer's synopsis is drawn from THAT
    // page's body (the world-fenced first prose line), so distinctive body
    // content reaches the assembled block.
    const cases: Array<[name: string, slug: string, needle: string]> = [
      ['Summit Robotics', 'companies/summit-robotics', 'warehouse'],
      ['Graph Traversal', 'concepts/graph-traversal', 'path-planning'],
      ['Hybrid Retrieval', 'concepts/hybrid-retrieval', 'dense embeddings'],
    ];
    for (const [name, slug, needle] of cases) {
      const r = await assembleTurnContext(engine, {
        sourceId: 'default',
        window: [{ role: 'user', text: `context on ${name}` }],
      });
      expect(r.pointers.map((p) => p.slug)).toContain(slug);
      expect(r.text).toContain(needle);
    }
  }, 120_000);
});
