/**
 * MEMORY_VERBS v1 — entity() latency gate (Cathedral 1, frozen contract:
 * p99 < 100ms on a large corpus, zero LLM).
 *
 * Corpus: 20K pages / 100K links / 30K aliases / 40K facts seeded via
 * generate_series (pattern: entity-resolve-perf.slow.test.ts). 20 warmup +
 * 200 measured buildEntityCard calls over a mixed name set exercising all
 * three resolution arms (alias hit / exact title / slug-suffix) + misses.
 *
 * Two gates:
 *   1. HARD ABSOLUTE — p99 < 100ms × GBRAIN_PERF_BUDGET_MULTIPLIER (default 1;
 *      loosen in CI only with evidence of runner noise). The protocol DOC
 *      promises this number; the bound is op-layer latency (transport
 *      excluded, as documented).
 *   2. RATIO GUARD (machine-independent) — entity p99 ≤ 100× max(getPage p50,
 *      1ms) on the same corpus. Calibration: the card is ~7 indexed reads +
 *      a keyword search on the miss path. It measures ~21× a getPage p50 of
 *      ~2.5ms, but on a fast runner getPage p50 floors to 1ms and normal
 *      entity p99 (~50ms) reads as ~50×. An O(N) scan regression lands at
 *      200ms+ (≥200×), far past the ceiling even on a slow runner. The ceiling
 *      is 100× (not 50×) so the guard is never STRICTER than the 100ms absolute
 *      budget when getPage floors to 1ms — the earlier 50× tripped on fast
 *      runners (a p99 tail ÷ a sub-ms median) while p99 stayed well under budget.
 *
 * The 200K-page validation is a documented MANUAL recipe in
 * docs/protocol/MEMORY_VERBS_v1.md — not CI-gated (seed time would dominate).
 *
 * v0.45.7 ambient recall (issue #1): the same corpus (seeded ONCE here — do
 * not re-seed in a sibling file) also gates the two boundary verbs the
 * protocol doc promises are "zero-LLM, sub-second": context_pack (8 standing
 * entities → assembleContextPack, the seam the `context_pack` op handler
 * calls) and delta (a ~150-page changed slice behind a cursor →
 * assembleDeltaContext). Each gate is p99 < 1000ms × the same multiplier.
 * No ratio guard on these: a pack is ~8 entity cards end-to-end and the card
 * itself is already ratio-guarded above — an O(N) regression in the shared
 * arms trips the card gate first.
 *
 * .slow.test.ts suffix keeps it out of the fast loop (`bun run test:slow`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import {
  assembleContextPack,
  assembleDeltaContext,
  PACK_DEFAULT_MAX_ENTITIES,
  DELTA_PAGE_FETCH_LIMIT,
} from '../src/core/context/turn-context.ts';

let engine: PGLiteEngine;

const PAGES = 20_000;
const LINKS = 100_000;
const ALIASES = 30_000;
const FACTS = 40_000;
const WARMUP = 20;
const MEASURED = 200;
const TARGET_ENTITIES = 50; // pages the measured calls rotate over

const P99_BUDGET_MS = 100 * (Number(process.env.GBRAIN_PERF_BUDGET_MULTIPLIER) || 1);
// v0.45.7 boundary verbs — MEMORY_VERBS_v1.md promises "zero-LLM, sub-second"
// for context_pack and delta; same multiplier convention as the entity gate.
const BOUNDARY_P99_BUDGET_MS = 1000 * (Number(process.env.GBRAIN_PERF_BUDGET_MULTIPLIER) || 1);
const BOUNDARY_WARMUP = 10;
const BOUNDARY_MEASURED = 100; // p99 index 98 — second-largest, not the raw max
const DELTA_CHANGED_PAGES = 150; // realistic heartbeat slice (spec: ~50-200 changed)
const DELTA_CHANGED_FACTS = 100;
// entity p99 ≤ 100× max(getPage p50, 1ms) — see the calibration note above.
// (100×, not 50×: at the 1ms getPage floor, 50× would cap p99 at 50ms — stricter
// than the 100ms absolute budget — and tripped on fast runners where a p99 tail
// is divided by a sub-ms getPage median. 100× stays far below the ≥200× O(N)
// regression signal.)
const RATIO_CEILING = 100;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (engine as any).db;

  // Target entities (real putPage so frontmatter/title behave like prod pages).
  for (let i = 0; i < TARGET_ENTITIES; i++) {
    const slug = `people/target-person-${i}`;
    await engine.putPage(slug, {
      type: 'person',
      title: `Target Person ${i}`,
      compiled_truth: `# Target Person ${i}\n\nRuns area ${i} at a-company. Synthetic perf-corpus entity.`,
      frontmatter: { type: 'person', title: `Target Person ${i}`, slug, summary: `Synthetic target ${i} for the entity-card latency gate.` },
    }, { sourceId: 'default' });
  }

  // Filler pages in one generate_series insert.
  await db.query(
    `INSERT INTO pages (slug, type, title, compiled_truth, frontmatter, source_id, created_at, updated_at)
     SELECT 'filler/page-' || gs::text, 'note', 'Filler ' || gs::text, '# Filler', '{}', 'default', NOW(), NOW()
     FROM generate_series(1, ${PAGES}) gs`,
  );

  // Links: filler→filler hub noise plus a fan-in/out around every target
  // (the card reads getLinks/getBacklinks — targets must have real edges).
  await db.query(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
     SELECT p1.id, p2.id, 'mentions', 'mentions'
     FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE slug LIKE 'filler/%') p1
     JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE slug LIKE 'filler/%') p2
       ON p2.rn = ((p1.rn * 7919) % ${PAGES}) + 1 AND p1.id <> p2.id
     CROSS JOIN generate_series(1, ${Math.ceil(LINKS / PAGES)}) g
     ON CONFLICT DO NOTHING`,
  );
  await db.query(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
     SELECT t.id, f.id, 'works_at', 'markdown'
     FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE slug LIKE 'people/target-%') t
     JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE slug LIKE 'filler/%' LIMIT 2000) f
       ON (f.rn % ${TARGET_ENTITIES}) + 1 = t.rn
     ON CONFLICT DO NOTHING`,
  );

  // Aliases: bulk noise + 2 aliases per target.
  await db.query(
    `INSERT INTO page_aliases (source_id, alias_norm, slug)
     SELECT 'default', 'alias noise ' || gs::text, 'filler/page-' || ((gs % ${PAGES}) + 1)::text
     FROM generate_series(1, ${ALIASES}) gs
     ON CONFLICT DO NOTHING`,
  );
  for (let i = 0; i < TARGET_ENTITIES; i++) {
    await db.query(
      `INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES
       ('default', $1, $2), ('default', $3, $2)
       ON CONFLICT DO NOTHING`,
      [`tp${i}`, `people/target-person-${i}`, `target alias ${i}`],
    );
  }

  // Facts: bulk noise across fillers + 20 active facts per target entity.
  await db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, created_at)
     SELECT 'default', 'filler/page-' || ((gs % ${PAGES}) + 1)::text,
            'noise fact ' || gs::text, 'fact', 'world', 'medium', NOW(), 'perf-seed', 1.0, NOW()
     FROM generate_series(1, ${FACTS - TARGET_ENTITIES * 20}) gs`,
  );
  await db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, created_at)
     SELECT 'default', 'people/target-person-' || t::text,
            'target fact ' || g::text || ' about person ' || t::text,
            CASE WHEN g % 5 = 0 THEN 'commitment' ELSE 'fact' END,
            'world', 'medium', NOW(), 'perf-seed', 1.0, NOW()
     FROM generate_series(0, ${TARGET_ENTITIES - 1}) t, generate_series(1, 20) g`,
  );
}, 300_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('entity card p99 latency gate', () => {
  it(`p99 < ${P99_BUDGET_MS}ms on ${PAGES} pages AND ≤ ${RATIO_CEILING}× getPage p50`, async () => {
    // Mixed name set: alias hits, exact titles, namespaced slugs, suffixes, misses.
    const names: string[] = [];
    for (let i = 0; i < TARGET_ENTITIES; i++) {
      names.push(`tp${i}`);                          // alias arm
      names.push(`Target Person ${i}`);              // exact-title arm
      names.push(`people/target-person-${i}`);       // exact-slug arm
      names.push(`target-person-${i}`);              // slug-suffix arm
      names.push(`zzz-absent-${i}`);                 // miss (suggestions path)
    }

    for (let i = 0; i < WARMUP; i++) {
      await buildEntityCard(engine, 'default', names[i % names.length], { remote: true });
    }

    const samples: number[] = [];
    for (let i = 0; i < MEASURED; i++) {
      const name = names[(i * 13) % names.length];
      const t0 = performance.now();
      await buildEntityCard(engine, 'default', name, { remote: true });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);

    // Ratio baseline: getPage p50 on the same corpus.
    const pageSamples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      await engine.getPage(`people/target-person-${i % TARGET_ENTITIES}`, { sourceId: 'default' });
      pageSamples.push(performance.now() - t0);
    }
    pageSamples.sort((a, b) => a - b);
    const pageP50 = Math.max(percentile(pageSamples, 50), 1.0); // 1ms floor vs sub-ms division noise

    // eslint-disable-next-line no-console
    console.log(
      `[entity-card-perf] corpus=${PAGES}p+${LINKS}l+${ALIASES}a+${FACTS}f ` +
      `entity p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms | getPage p50=${pageP50.toFixed(2)}ms ` +
      `| ratio=${(p99 / pageP50).toFixed(1)}x (ceiling ${RATIO_CEILING}x) | budget=${P99_BUDGET_MS}ms`,
    );

    expect(p99).toBeLessThan(P99_BUDGET_MS);
    expect(p99 / pageP50).toBeLessThanOrEqual(RATIO_CEILING);
  }, 300_000);
});

describe('context_pack p99 latency gate (v0.45.7 ambient recall)', () => {
  it(`pack p99 < ${BOUNDARY_P99_BUDGET_MS}ms with ${PACK_DEFAULT_MAX_ENTITIES} standing entities on ${PAGES} pages`, async () => {
    // 8 standing entities per call, rotated across the 50 targets and the
    // three resolution arms (alias / exact title / exact slug) so no single
    // card shape dominates the tail.
    const entitiesAt = (iter: number): string[] => {
      const out: string[] = [];
      for (let j = 0; j < PACK_DEFAULT_MAX_ENTITIES; j++) {
        const t = (iter * PACK_DEFAULT_MAX_ENTITIES + j) % TARGET_ENTITIES;
        out.push(
          j % 3 === 0 ? `tp${t}` : j % 3 === 1 ? `Target Person ${t}` : `people/target-person-${t}`,
        );
      }
      return out;
    };

    // Fresh session id per call: a pack fires at session START, so the
    // hot-memory cache (30s TTL, keyed by session) is cold in production —
    // reusing one id here would measure cache hits, not the promised path.
    for (let i = 0; i < BOUNDARY_WARMUP; i++) {
      await assembleContextPack(engine, {
        sourceId: 'default',
        entities: entitiesAt(i),
        sessionId: `pack-warm-${i}`,
      });
    }

    const samples: number[] = [];
    let lastCardCount = 0;
    for (let i = 0; i < BOUNDARY_MEASURED; i++) {
      const t0 = performance.now();
      const res = await assembleContextPack(engine, {
        sourceId: 'default',
        entities: entitiesAt(i),
        sessionId: `pack-${i}`,
      });
      samples.push(performance.now() - t0);
      lastCardCount = res.cards?.length ?? 0;
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);

    // eslint-disable-next-line no-console
    console.log(
      `[context-pack-perf] corpus=${PAGES}p+${LINKS}l+${ALIASES}a+${FACTS}f ` +
      `entities=${PACK_DEFAULT_MAX_ENTITIES} pack p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms ` +
      `| budget=${BOUNDARY_P99_BUDGET_MS}ms`,
    );

    // The gate must measure real work: every rotated name resolves, so all 8
    // cards build on every call — an empty pack passing the budget is a bug.
    expect(lastCardCount).toBe(PACK_DEFAULT_MAX_ENTITIES);
    expect(p99).toBeLessThan(BOUNDARY_P99_BUDGET_MS);
  }, 300_000);
});

describe('delta p99 latency gate (v0.45.7 ambient recall)', () => {
  it(`delta p99 < ${BOUNDARY_P99_BUDGET_MS}ms over a ${DELTA_CHANGED_PAGES}-page changed slice`, async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (engine as any).db;
    // Realistic heartbeat slice: push 150 filler pages (+100 noise facts) one
    // hour ahead and set the cursor 30 minutes ahead — the changed slice sits
    // past the cursor, the other ~19,850 pages + ~39,900 facts stay behind it.
    await db.query(
      `UPDATE pages SET updated_at = NOW() + interval '1 hour'
       WHERE id IN (SELECT id FROM pages WHERE slug LIKE 'filler/%' ORDER BY slug LIMIT ${DELTA_CHANGED_PAGES})`,
    );
    await db.query(
      `UPDATE facts SET created_at = NOW() + interval '1 hour'
       WHERE id IN (SELECT id FROM facts WHERE entity_slug LIKE 'filler/%' ORDER BY id LIMIT ${DELTA_CHANGED_FACTS})`,
    );
    const since = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    for (let i = 0; i < BOUNDARY_WARMUP; i++) {
      await assembleDeltaContext(engine, { sourceId: 'default', since });
    }

    const samples: number[] = [];
    let lastPages = 0;
    let lastOverflow = false;
    let lastFacts = 0;
    for (let i = 0; i < BOUNDARY_MEASURED; i++) {
      const t0 = performance.now();
      const res = await assembleDeltaContext(engine, { sourceId: 'default', since });
      samples.push(performance.now() - t0);
      lastPages = res.deltaPages?.length ?? 0;
      lastOverflow = res.deltaOverflow === true;
      lastFacts = res.facts?.length ?? 0;
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);

    // eslint-disable-next-line no-console
    console.log(
      `[delta-perf] corpus=${PAGES}p+${LINKS}l+${ALIASES}a+${FACTS}f ` +
      `changed=${DELTA_CHANGED_PAGES}p+${DELTA_CHANGED_FACTS}f delta p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms ` +
      `| budget=${BOUNDARY_P99_BUDGET_MS}ms`,
    );

    // Real-work guards: the 150-page slice overflows the 50-page fetch limit
    // (limit+1 probe → deltaOverflow) and the facts arm delivers the changed
    // facts — a delta that scanned nothing would pass any latency budget.
    expect(lastPages).toBe(DELTA_PAGE_FETCH_LIMIT);
    expect(lastOverflow).toBe(true);
    expect(lastFacts).toBeGreaterThan(0);
    expect(p99).toBeLessThan(BOUNDARY_P99_BUDGET_MS);
  }, 300_000);
});
