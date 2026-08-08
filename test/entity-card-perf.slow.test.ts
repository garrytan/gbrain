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
 *   2. RATIO GUARD (machine-independent) — entity p99 ≤ 50× max(getPage p50,
 *      1ms) on the same corpus. Calibration: the card is ~7 indexed reads +
 *      a keyword search on the miss path, measured ~21× a 1ms-floored
 *      getPage at 20K pages — an O(N) scan regression lands at 200ms+
 *      (≥200×), far past the ceiling even on a slow runner, while the
 *      2.4× headroom absorbs planner noise.
 *
 * The 200K-page validation is a documented MANUAL recipe in
 * docs/protocol/MEMORY_VERBS_v1.md — not CI-gated (seed time would dominate).
 *
 * .slow.test.ts suffix keeps it out of the fast loop (`bun run test:slow`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';

let engine: PGLiteEngine;

const PAGES = 20_000;
const LINKS = 100_000;
const ALIASES = 30_000;
const FACTS = 40_000;
const WARMUP = 20;
const MEASURED = 200;
const TARGET_ENTITIES = 50; // pages the measured calls rotate over

const P99_BUDGET_MS = 100 * (Number(process.env.GBRAIN_PERF_BUDGET_MULTIPLIER) || 1);
// entity p99 ≤ 50× max(getPage p50, 1ms) — see the calibration note above.
const RATIO_CEILING = 50;

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
