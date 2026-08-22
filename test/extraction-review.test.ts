/**
 * Extraction quarantine lane (issue #160).
 *
 * `extractAndEnrich` regex-extracts entity names from arbitrary ingested text
 * and creates people/ + companies/ stub pages. These tests pin the lane
 * end-to-end:
 *   - fail-closed trust: only an explicit `trusted: true` (which the op layer
 *     only grants for ctx.remote === false AND --trusted-extraction) writes
 *     authoritative pages; undefined/false/remote → quarantine markers.
 *   - unverified stubs are excluded from authoritative retrieval boosts
 *     (compiled-truth fusion boost + the SQL namespace source-boost) and
 *     carry `unverified: true` in search-result metadata.
 *   - review queue: extraction_pending lists; extraction_review promotes
 *     (status → verified) / rejects (soft-delete) in batch, owner-only.
 *   - doctor nudge: unverified_extractions counts stale stubs.
 *
 * Hermetic via PGLite (both engines share the SQL through
 * unverifiedExtractionFragment + the same literal method SQL; postgres runs
 * via the DATABASE_URL-gated e2e lane).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import {
  quarantineMarkers,
  isUnverifiedExtraction,
  unverifiedExtractionFragment,
  EXTRACTION_STATUS_KEY,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
  PROVENANCE_AUTO_EXTRACTED,
} from '../src/core/extraction-review.ts';
import { enrichEntity, extractAndEnrich } from '../src/core/enrichment-service.ts';
import { rrfFusion, hybridSearch, stampUnverifiedExtractions } from '../src/core/search/hybrid.ts';
import { buildSourceFactorCase } from '../src/core/search/sql-ranking.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { checkUnverifiedExtractions } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  // Deterministic no-embedding-provider path: configure the gateway with NO
  // auth env so hybridSearch never attempts a real embedding call, even on a
  // dev machine with provider keys in process.env. Pins the vector dim too
  // (shard-order defense, same class as doctor-hidden-by-search-policy).
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM timeline_entries');
  await engine.executeRaw('DELETE FROM pages');
});

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...over,
  } as OperationContext;
}

/** ctx with `remote` deleted entirely — the type-bypass case the fail-closed
 *  invariant exists for ("anything not strictly false is untrusted"). */
function ctxNoRemote(): OperationContext {
  const c = ctx() as unknown as Record<string, unknown>;
  delete c.remote;
  return c as unknown as OperationContext;
}

const extract_entities = operationsByName['extract_entities']!;
const extraction_pending = operationsByName['extraction_pending']!;
const extraction_review = operationsByName['extraction_review']!;

// ---------------------------------------------------------------------------
// Marker module (pure)
// ---------------------------------------------------------------------------

describe('extraction-review markers', () => {
  test('quarantineMarkers → provenance + status pair', () => {
    expect(quarantineMarkers()).toEqual({ provenance: PROVENANCE_AUTO_EXTRACTED, status: STATUS_UNVERIFIED });
  });

  test('isUnverifiedExtraction requires BOTH markers', () => {
    expect(isUnverifiedExtraction(quarantineMarkers())).toBe(true);
    expect(isUnverifiedExtraction({ status: 'unverified' })).toBe(false);
    expect(isUnverifiedExtraction({ provenance: 'auto-extracted' })).toBe(false);
    expect(isUnverifiedExtraction({ provenance: 'auto-extracted', status: 'verified' })).toBe(false);
    expect(isUnverifiedExtraction({ status: 'unverified', provenance: 'user' })).toBe(false);
    expect(isUnverifiedExtraction(null)).toBe(false);
    expect(isUnverifiedExtraction(undefined)).toBe(false);
  });

  test('SQL fragment references both keys on the given alias', () => {
    const frag = unverifiedExtractionFragment('p');
    expect(frag).toContain("p.frontmatter");
    expect(frag).toContain(PROVENANCE_AUTO_EXTRACTED);
    expect(frag).toContain(STATUS_UNVERIFIED);
  });

  test('buildSourceFactorCase guards unverified stubs in both forms', () => {
    const qualified = buildSourceFactorCase('p.slug', { 'people/': 1.2 }, 'low');
    expect(qualified).toContain(unverifiedExtractionFragment('p'));
    expect(qualified.indexOf(unverifiedExtractionFragment('p'))).toBeLessThan(qualified.indexOf('people/'));
    // Vector re-rank form: bare slug column + pre-computed guard column
    // (projected in hnsw_candidates) — the guard WHEN must come first.
    const guarded = buildSourceFactorCase('slug', { 'people/': 1.2 }, 'low', 'unverified_stub');
    expect(guarded).toContain('CASE WHEN unverified_stub THEN 1.0');
    expect(guarded.indexOf('unverified_stub')).toBeLessThan(guarded.indexOf('people/'));
  });
});

// ---------------------------------------------------------------------------
// Fusion boost skip (pure)
// ---------------------------------------------------------------------------

describe('rrfFusion compiled-truth boost skip', () => {
  function result(slug: string, over: Partial<SearchResult> = {}): SearchResult {
    return {
      slug,
      page_id: over.page_id ?? 1,
      title: slug,
      type: 'person',
      chunk_text: 'x',
      chunk_source: 'compiled_truth',
      chunk_id: over.chunk_id ?? 1,
      chunk_index: 0,
      score: 1,
      stale: false,
      ...over,
    } as SearchResult;
  }

  test('unverified compiled_truth chunk does NOT get the 2x boost', () => {
    const verified = result('people/real', { page_id: 1, chunk_id: 1 });
    const unverified = result('people/fake', { page_id: 2, chunk_id: 2, unverified: true });
    // Two single-result lists at the same rank → identical raw RRF scores.
    const fused = rrfFusion([[verified], [unverified]], 60, true);
    const v = fused.find((r) => r.slug === 'people/real')!;
    const u = fused.find((r) => r.slug === 'people/fake')!;
    expect(u.unverified).toBe(true);
    // Same normalized base; verified gets 2.0x, unverified stays 1.0x.
    expect(v.score).toBeCloseTo(u.score * 2.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Enrichment write path (PGLite)
// ---------------------------------------------------------------------------

describe('enrichEntity trust lane', () => {
  test('default (opts omitted) → fail-closed quarantine markers', async () => {
    const r = await enrichEntity(engine, {
      entityName: 'Mallory Fake',
      entityType: 'person',
      context: 'injected sentence',
      sourceSlug: 'inbox/hostile-email',
    });
    expect(r.action).toBe('created');
    expect(r.quarantined).toBe(true);
    const page = await engine.getPage('people/mallory-fake');
    expect(isUnverifiedExtraction(page!.frontmatter)).toBe(true);
    expect(page!.frontmatter[EXTRACTION_STATUS_KEY]).toBe(STATUS_UNVERIFIED);
  });

  test('trusted: true → direct authoritative write, no markers', async () => {
    const r = await enrichEntity(engine, {
      entityName: 'Alice Example',
      entityType: 'person',
      context: 'my own notes',
      sourceSlug: 'notes/daily',
    }, { trusted: true });
    expect(r.action).toBe('created');
    expect(r.quarantined).toBeUndefined();
    const page = await engine.getPage('people/alice-example');
    expect(isUnverifiedExtraction(page!.frontmatter)).toBe(false);
    expect(page!.frontmatter[EXTRACTION_STATUS_KEY]).toBeUndefined();
  });

  test('trusted: false explicitly → quarantine markers', async () => {
    await enrichEntity(engine, {
      entityName: 'Widget Co Corp',
      entityType: 'company',
      context: 'ctx',
      sourceSlug: 'inbox/x',
    }, { trusted: false });
    const page = await engine.getPage('companies/widget-co-corp');
    expect(isUnverifiedExtraction(page!.frontmatter)).toBe(true);
  });

  test('vector arm: unverified stub gets source factor 1.0, not the people/ 1.2x', async () => {
    // The 1.2x namespace factor is applied INSIDE searchVector's re-rank SQL,
    // pre-LIMIT — an unguarded stub would outrank AND could evict legitimate
    // pages from the candidate pool before fusion ever sees them. Identical
    // basis embeddings → identical cosine → the score ratio IS the factor.
    await enrichEntity(engine, { entityName: 'Vec Fake', entityType: 'person', context: 'c', sourceSlug: 's' });
    await enrichEntity(engine, { entityName: 'Vec Real', entityType: 'person', context: 'c', sourceSlug: 's' }, { trusted: true });
    const e = basisEmbedding(7);
    await engine.upsertChunks('people/vec-fake', [{ chunk_index: 0, chunk_text: 'vector text alpha', chunk_source: 'compiled_truth', embedding: e, token_count: 3 }]);
    await engine.upsertChunks('people/vec-real', [{ chunk_index: 0, chunk_text: 'vector text bravo', chunk_source: 'compiled_truth', embedding: e, token_count: 3 }]);
    const rows = await engine.searchVector(e, { limit: 10 });
    const fake = rows.find((r) => r.slug === 'people/vec-fake')!;
    const real = rows.find((r) => r.slug === 'people/vec-real')!;
    expect(fake).toBeDefined();
    expect(real).toBeDefined();
    expect(real.score / fake.score).toBeCloseTo(1.2, 5);
  });

  test('getUnverifiedExtractionPageIds flags only quarantined pages as unverified', async () => {
    await enrichEntity(engine, { entityName: 'Fake Guy', entityType: 'person', context: 'c', sourceSlug: 's' });
    await enrichEntity(engine, { entityName: 'Real Guy', entityType: 'person', context: 'c', sourceSlug: 's' }, { trusted: true });
    const fake = await engine.getPage('people/fake-guy');
    const real = await engine.getPage('people/real-guy');
    const marks = await engine.getUnverifiedExtractionPageIds([fake!.id, real!.id]);
    expect(marks.get(fake!.id)).toEqual({ unverified: true, status: 'unverified' });
    // Trusted write carries no status frontmatter at all → no entry.
    expect(marks.has(real!.id)).toBe(false);
    expect((await engine.getUnverifiedExtractionPageIds([])).size).toBe(0);
  });

  test('#4220: non-quarantine statuses (draft/superseded/restricted) surface without the unverified flag', async () => {
    const statuses = ['draft', 'superseded', 'restricted'] as const;
    const ids: number[] = [];
    for (const status of statuses) {
      await engine.putPage(`notes/status-${status}`, {
        type: 'note',
        title: `Status ${status}`,
        compiled_truth: `A ${status} page.`,
        timeline: '',
        frontmatter: { status },
      });
      const page = await engine.getPage(`notes/status-${status}`);
      ids.push(page!.id);
    }
    // A page whose status is 'unverified' but WITHOUT auto-extracted
    // provenance must surface the status while staying un-flagged: the
    // quarantine lane requires the marker pair.
    await engine.putPage('notes/status-user-unverified', {
      type: 'note',
      title: 'User unverified',
      compiled_truth: 'User-authored page reusing the status key.',
      timeline: '',
      frontmatter: { status: 'unverified' },
    });
    const userPage = await engine.getPage('notes/status-user-unverified');
    ids.push(userPage!.id);

    const marks = await engine.getUnverifiedExtractionPageIds(ids);
    expect(marks.get(ids[0]!)).toEqual({ unverified: false, status: 'draft' });
    expect(marks.get(ids[1]!)).toEqual({ unverified: false, status: 'superseded' });
    expect(marks.get(ids[2]!)).toEqual({ unverified: false, status: 'restricted' });
    expect(marks.get(userPage!.id)).toEqual({ unverified: false, status: 'unverified' });
  });

  test('#4220: stampUnverifiedExtractions stamps SearchResult.status always, unverified only for stubs', async () => {
    await enrichEntity(engine, { entityName: 'Stamp Fake', entityType: 'person', context: 'c', sourceSlug: 's' });
    await engine.putPage('notes/stamp-draft', {
      type: 'note',
      title: 'Stamp Draft',
      compiled_truth: 'draft body',
      timeline: '',
      frontmatter: { status: 'draft' },
    });
    await engine.putPage('notes/stamp-clean', {
      type: 'note',
      title: 'Stamp Clean',
      compiled_truth: 'clean body',
      timeline: '',
      frontmatter: {},
    });
    const stub = await engine.getPage('people/stamp-fake');
    const draft = await engine.getPage('notes/stamp-draft');
    const clean = await engine.getPage('notes/stamp-clean');

    const mk = (page: { id: number; slug: string }): SearchResult => ({
      slug: page.slug,
      page_id: page.id,
      title: page.slug,
      type: 'note',
      chunk_text: 'x',
      chunk_source: 'compiled_truth',
      chunk_id: 0,
      chunk_index: 0,
      score: 1,
      stale: false,
    });
    const results = [mk(stub!), mk(draft!), mk(clean!)];
    await stampUnverifiedExtractions(engine, results);

    expect(results[0]!.status).toBe('unverified');
    expect(results[0]!.unverified).toBe(true);
    expect(results[1]!.status).toBe('draft');
    expect(results[1]!.unverified).toBeUndefined();
    expect(results[2]!.status).toBeUndefined();
    expect(results[2]!.unverified).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #3994: created stubs must land in the retrieval surface. The old CREATE
// path wrote via bare engine.putPage, which never chunks — so every fresh
// entity stub had zero content_chunks rows and was invisible to the keyword
// and vector recall arms. The fix routes through serializeMarkdown +
// importFromContent (the #2163 concept-page precedent).
// ---------------------------------------------------------------------------

describe('enrichEntity created stubs are retrieval-visible (#3994)', () => {
  async function chunkCount(slug: string): Promise<number> {
    const rows = await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1',
      [slug],
    );
    return Number(rows[0]!.n);
  }

  test('fresh untrusted stub has >=1 chunk row, markers intact, keyword arm hits', async () => {
    const r = await enrichEntity(engine, {
      entityName: 'Charlie Example',
      entityType: 'person',
      context: 'Met at the zebrafish conference',
      sourceSlug: 'meetings/2026-04-03',
    });
    expect(r.action).toBe('created');
    expect(r.quarantined).toBe(true);

    // Quarantine markers survive the import pipeline round-trip.
    const page = await engine.getPage('people/charlie-example');
    expect(page).toBeDefined();
    expect(isUnverifiedExtraction(page!.frontmatter)).toBe(true);
    expect(page!.frontmatter[EXTRACTION_STATUS_KEY]).toBe(STATUS_UNVERIFIED);

    // The stub is chunked (pre-fix putPage path wrote zero chunk rows).
    expect(await chunkCount('people/charlie-example')).toBeGreaterThanOrEqual(1);

    // ...and therefore reachable by the keyword recall arm.
    const hits = await engine.searchKeyword('zebrafish conference', { limit: 10 });
    expect(hits.some((h) => h.slug === 'people/charlie-example')).toBe(true);
  });

  test('trusted stub is chunked too, without quarantine markers', async () => {
    await enrichEntity(engine, {
      entityName: 'Trusted Chunky',
      entityType: 'person',
      context: 'quarterly planning offsite',
      sourceSlug: 'notes/daily',
    }, { trusted: true });
    expect(await chunkCount('people/trusted-chunky')).toBeGreaterThanOrEqual(1);
    const page = await engine.getPage('people/trusted-chunky');
    expect(isUnverifiedExtraction(page!.frontmatter)).toBe(false);
  });

  test('pipeline failure: stderr-warns the downgrade, then the unchunked fallback still lands the page', async () => {
    // importFromContent runs inside engine.transaction; the fallback putPage
    // does not. Breaking transaction() forces the fallback arm only.
    const failingEngine = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'transaction') {
          return async () => { throw new Error('simulated pipeline boom'); };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as typeof engine;

    const errChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let r: Awaited<ReturnType<typeof enrichEntity>>;
    try {
      r = await enrichEntity(failingEngine, {
        entityName: 'Fallback Freddy',
        entityType: 'person',
        context: 'silent downgrade regression check',
        sourceSlug: 'notes/daily',
      }, { trusted: true });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(r.action).toBe('created');
    // The downgrade is LOUD (#3994 review): import error + unchunked warning.
    const warn = errChunks.join('');
    expect(warn).toContain('[enrich] import pipeline failed for stub people/fallback-freddy');
    expect(warn).toContain('simulated pipeline boom');
    expect(warn).toContain('not chunked/embedded');
    // The page still exists (fail-open), just without chunk rows.
    const page = await engine.getPage('people/fallback-freddy');
    expect(page).toBeDefined();
    expect(await chunkCount('people/fallback-freddy')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ops: trust-boundary matrix + review queue
// ---------------------------------------------------------------------------

describe('extract_entities op trust boundary', () => {
  const TEXT = 'I had lunch with Bobby Injected today. He said Evil Widgets Inc is pivoting.';

  test('remote: true → quarantined even WITH trusted_extraction flag', async () => {
    const out = (await extract_entities.handler(ctx({ remote: true }), {
      text: TEXT, source_slug: 'inbox/mail', trusted_extraction: true,
    })) as { trusted: boolean; quarantined: number; count: number };
    expect(out.trusted).toBe(false);
    expect(out.count).toBeGreaterThan(0);
    expect(out.quarantined).toBe(out.count);
    const page = await engine.getPage('people/bobby-injected');
    expect(isUnverifiedExtraction(page!.frontmatter)).toBe(true);
  });

  test('remote UNSET (type bypass) → fail-closed quarantine', async () => {
    const out = (await extract_entities.handler(ctxNoRemote(), {
      text: TEXT, source_slug: 'inbox/mail', trusted_extraction: true,
    })) as { trusted: boolean; quarantined: number };
    expect(out.trusted).toBe(false);
    expect(out.quarantined).toBeGreaterThan(0);
  });

  test('remote: false WITHOUT flag → still quarantined (explicit opt-in required)', async () => {
    const out = (await extract_entities.handler(ctx({ remote: false }), {
      text: TEXT, source_slug: 'inbox/mail',
    })) as { trusted: boolean; quarantined: number };
    expect(out.trusted).toBe(false);
    expect(out.quarantined).toBeGreaterThan(0);
  });

  test('resource guards: oversize text rejected; entity flood capped + surfaced', async () => {
    // Oversize input → loud invalid_params, nothing written.
    await expect(extract_entities.handler(ctx(), {
      text: 'A'.repeat(200_001), source_slug: 'inbox/big',
    })).rejects.toBeInstanceOf(OperationError);
    // 300 distinct name-shaped tokens → capped at 200, truncated surfaced.
    // 300 distinct two-word names (letters only — the extractor regex is
    // [A-Z][a-z]+ per word, digits would break the match).
    const flood = Array.from({ length: 300 }, (_, i) =>
      `Flood Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
    ).join('. ');
    const out = (await extract_entities.handler(ctx(), { text: flood, source_slug: 'inbox/flood' })) as {
      count: number; entities_found: number; truncated: boolean;
    };
    expect(out.entities_found).toBeGreaterThan(200);
    expect(out.count).toBe(200);
    expect(out.truncated).toBe(true);
  }, 120_000);

  test('remote: false WITH --trusted-extraction → direct authoritative write', async () => {
    const out = (await extract_entities.handler(ctx({ remote: false }), {
      text: TEXT, source_slug: 'notes/mine', trusted_extraction: true,
    })) as { trusted: boolean; quarantined: number; count: number };
    expect(out.trusted).toBe(true);
    expect(out.quarantined).toBe(0);
    const page = await engine.getPage('people/bobby-injected');
    expect(isUnverifiedExtraction(page!.frontmatter)).toBe(false);
  });
});

describe('extraction_pending + extraction_review', () => {
  async function seedStub(name: string): Promise<string> {
    const r = await enrichEntity(engine, { entityName: name, entityType: 'person', context: 'c', sourceSlug: 'inbox/x' });
    return r.slug;
  }

  test('pending lists unverified stubs; promoted/rejected drop out', async () => {
    const a = await seedStub('Fake Aa');
    const b = await seedStub('Fake Bb');
    await enrichEntity(engine, { entityName: 'Real Cc', entityType: 'person', context: 'c', sourceSlug: 's' }, { trusted: true });

    const before = (await extraction_pending.handler(ctx(), {})) as { count: number; pending: Array<{ slug: string }> };
    expect(before.pending.map((r) => r.slug).sort()).toEqual([a, b].sort());

    const out = (await extraction_review.handler(ctx({ remote: false }), {
      action: 'promote', slugs: [a],
    })) as { results: Array<{ slug: string; status: string }> };
    expect(out.results).toEqual([{ slug: a, status: 'promoted' }]);

    const promoted = await engine.getPage(a);
    expect(promoted!.frontmatter[EXTRACTION_STATUS_KEY]).toBe(STATUS_VERIFIED);
    // provenance survives as the audit trail.
    expect(promoted!.frontmatter.provenance).toBe(PROVENANCE_AUTO_EXTRACTED);
    expect(isUnverifiedExtraction(promoted!.frontmatter)).toBe(false);

    const rej = (await extraction_review.handler(ctx({ remote: false }), {
      action: 'reject', slugs: b, // CLI string form
    })) as { results: Array<{ slug: string; status: string }> };
    expect(rej.results).toEqual([{ slug: b, status: 'rejected' }]);
    expect(await engine.getPage(b)).toBeNull(); // soft-deleted → hidden

    const after = (await extraction_pending.handler(ctx(), {})) as { count: number };
    expect(after.count).toBe(0);
  });

  test('batch promote is batch-friendly and reports per-slug statuses', async () => {
    const a = await seedStub('Fake Dd');
    const b = await seedStub('Fake Ee');
    await enrichEntity(engine, { entityName: 'Real Ff', entityType: 'person', context: 'c', sourceSlug: 's' }, { trusted: true });
    const out = (await extraction_review.handler(ctx({ remote: false }), {
      action: 'promote', slugs: [a, b, 'people/real-ff', 'people/missing'],
    })) as { results: Array<{ slug: string; status: string }> };
    expect(out.results.map((r) => r.status)).toEqual(['promoted', 'promoted', 'not_unverified', 'not_found']);
  });

  test('extraction_review is owner-only: remote and unset-trust callers are refused', async () => {
    const a = await seedStub('Fake Gg');
    await expect(extraction_review.handler(ctx({ remote: true }), { action: 'promote', slugs: [a] }))
      .rejects.toBeInstanceOf(OperationError);
    await expect(extraction_review.handler(ctxNoRemote(), { action: 'promote', slugs: [a] }))
      .rejects.toBeInstanceOf(OperationError);
    // and it is not exposed over HTTP MCP at all
    expect(extraction_review.localOnly).toBe(true);
    // stub untouched
    expect(isUnverifiedExtraction((await engine.getPage(a))!.frontmatter)).toBe(true);
  });

  test('invalid action / empty slugs → invalid_params', async () => {
    await expect(extraction_review.handler(ctx({ remote: false }), { action: 'bless', slugs: ['x'] }))
      .rejects.toBeInstanceOf(OperationError);
    await expect(extraction_review.handler(ctx({ remote: false }), { action: 'promote', slugs: [] }))
      .rejects.toBeInstanceOf(OperationError);
  });
});

// ---------------------------------------------------------------------------
// Doctor nudge
// ---------------------------------------------------------------------------

describe('unverified_extractions doctor check', () => {
  test('fresh stubs → ok; stale stubs → warn with review commands', async () => {
    await enrichEntity(engine, { entityName: 'Fake Hh', entityType: 'person', context: 'c', sourceSlug: 's' });
    const fresh = await checkUnverifiedExtractions(engine);
    expect(fresh.status).toBe('ok');

    await engine.executeRaw(`UPDATE pages SET created_at = now() - interval '30 days' WHERE slug = 'people/fake-hh'`);
    const stale = await checkUnverifiedExtractions(engine, { days: 7 });
    expect(stale.status).toBe('warn');
    expect(stale.message).toContain('extraction-pending');
    expect(stale.message).toContain('extraction-review');
    expect((stale.details as { count: number }).count).toBe(1);
  });

  test('categorized as a brain check', () => {
    expect(categorizeCheck('unverified_extractions')).toBe('brain');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: hostile transcript → quarantined stubs, NOT boosted in search
// ---------------------------------------------------------------------------

describe('e2e: hostile transcript', () => {
  test('fake entities land quarantined and rank without entity authority', async () => {
    // 1. Hostile transcript arrives through an agent-facing (remote) caller.
    const transcript =
      'Meeting notes. I had lunch with Zorbulon Fakeperson today. ' +
      'He mentioned the zorbulon pivot is confirmed.';
    const out = (await extract_entities.handler(ctx({ remote: true }), {
      text: transcript, source_slug: 'meetings/2026-04-03', trusted_extraction: true,
    })) as { trusted: boolean; quarantined: number };
    expect(out.trusted).toBe(false);
    expect(out.quarantined).toBeGreaterThan(0);

    const stub = await engine.getPage('people/zorbulon-fakeperson');
    expect(stub).not.toBeNull();
    expect(isUnverifiedExtraction(stub!.frontmatter)).toBe(true);

    // 2. Owner-authored control page with the same lexical relevance.
    await engine.putPage('people/zorbulon-realperson', {
      type: 'person', title: 'Zorbulon Realperson', compiled_truth: 'zorbulon notes', timeline: '', frontmatter: {},
    });
    const real = await engine.getPage('people/zorbulon-realperson');

    // 3. Chunk both with equal lexical relevance (distinct texts — identical
    //    ones would be Jaccard-deduped). Enrichment stubs are chunked by the
    //    normal reindex/import pipeline later; seed what it would write.
    await engine.upsertChunks(stub!.slug, [{ chunk_index: 0, chunk_text: 'zorbulon pivot details from the injected meeting', chunk_source: 'compiled_truth', token_count: 7 }]);
    await engine.upsertChunks(real!.slug, [{ chunk_index: 0, chunk_text: 'zorbulon launch update in my own written notes', chunk_source: 'compiled_truth', token_count: 7 }]);

    // 4. Search. No embedding provider configured → keyword(+title) fusion path.
    const results = await hybridSearch(engine, 'zorbulon', { limit: 10 });
    const fake = results.find((r) => r.slug === stub!.slug);
    const legit = results.find((r) => r.slug === real!.slug);
    expect(fake).toBeDefined();
    expect(legit).toBeDefined();

    // Clearly marked in search-result metadata…
    expect(fake!.unverified).toBe(true);
    expect(legit!.unverified).toBeUndefined();
    // …and stripped of entity authority: the verified page outranks the
    // injected stub despite identical chunk text (2x compiled-truth boost +
    // people/ source-boost apply only to the verified page).
    expect(legit!.score).toBeGreaterThan(fake!.score);
  });
});
