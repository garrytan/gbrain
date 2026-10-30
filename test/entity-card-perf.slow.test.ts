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
 *   1. HARD ABSOLUTE — p99 < 100ms × GBRAIN_TEST_PERF_BUDGET_MULTIPLIER (default 1;
 *      loosen in CI only with evidence of runner noise). The protocol DOC
 *      promises this number; the bound is op-layer latency (transport
 *      excluded, as documented). Latency here is the call's CPU time on this
 *      thread (`timed` below): PGLite runs every query in-process on this
 *      thread with no I/O, so on an idle machine it equals wall time, and on a
 *      loaded CI runner it does not count the time other processes held the
 *      CPU. Wall time was measuring the shard's load (p99 100.52ms on a loaded
 *      8-VM shard against ~30ms idle). Wall p99 is still logged.
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
 * Entity recall: the `entity` verb's path (includeReferences: referenced_by
 * groups + coverage) has two gates on the same corpus. Ordinary entities keep
 * the p99 < 100ms budget. The hub page carries 10,000 inbound mention links, so
 * its card necessarily enumerates 10,000 referrers; it is gated by a ratio to
 * the irreducible enumeration (a distinct-referrer count over the same links)
 * measured in the same process, which cancels runner speed and still trips on
 * per-referrer work (a per-row subquery or hydrating every row reads as 10×+).
 * The ambient gates below stay on the reference-free path.
 *
 * .slow.test.ts suffix keeps it out of the fast loop (`bun run test:slow`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { heapSize } from 'bun:jsc';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { measureWithoutSteal } from './helpers/hypervisor-steal.ts';
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

const P99_BUDGET_MS = 100 * (Number(process.env.GBRAIN_TEST_PERF_BUDGET_MULTIPLIER) || 1);
// v0.45.7 boundary verbs — MEMORY_VERBS_v1.md promises "zero-LLM, sub-second"
// for context_pack and delta; same multiplier convention as the entity gate.
const BOUNDARY_P99_BUDGET_MS = 1000 * (Number(process.env.GBRAIN_TEST_PERF_BUDGET_MULTIPLIER) || 1);
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
const HUB_SLUG = 'companies/hub-company';
const HUB_LINKS = 10_000;
const HUB_SAMPLES = 30;
// Hub card median ≤ 8× the distinct-referrer count's median (measured about 4× on 2026-10-05: hub card p50 ~59ms,
// count p50 ~14ms on a 4-core cloud machine). Per-referrer regressions read as 10× or more.
const HUB_RATIO_CEILING = 8;
// Catastrophe backstop only; the ratio is the gate.
const HUB_ABSOLUTE_CEILING_MS = 1000 * (Number(process.env.GBRAIN_TEST_PERF_BUDGET_MULTIPLIER) || 1);

interface Sample { name: string; wall: number; cpu: number; heapDeltaMB: number; steal: Array<number | null> }

/**
 * One call's wall time, this thread's CPU time (user + system) across it, in ms, and the JS heap change (a large
 * change means a GC ran inside it). The gates read `cpu`: the code path's own work, including the queries PGLite
 * runs on this thread and GC on it, but not time this process spent waiting for a CPU while other test processes ran.
 * A call across which hypervisor steal advanced is timed again (test/helpers/hypervisor-steal.ts): on guest kernels
 * without paravirt time accounting, steal is billed to this thread's CPU time too.
 */
async function sample(name: string, fn: () => Promise<unknown>): Promise<Sample> {
  const { value, steal } = await measureWithoutSteal(async () => {
    const h0 = heapSize(), c0 = process.threadCpuUsage(), t0 = performance.now();
    await fn();
    const wall = performance.now() - t0, c = process.threadCpuUsage(c0);
    return { wall, cpu: (c.user + c.system) / 1000, heapDeltaMB: (heapSize() - h0) / 2 ** 20 };
  });
  return { name, ...value, steal };
}

/** The five slowest samples for the log: cpu well under wall is scheduler wait, a heap jump is a GC, steal ticks per attempt show re-timed calls, cpu≈wall with none of these is a slower CPU. */
function slowest(samples: Sample[]): string {
  return [...samples].sort((a, b) => b.cpu - a.cpu).slice(0, 5)
    .map(s => `${s.name} wall=${s.wall.toFixed(1)} cpu=${s.cpu.toFixed(1)} heapΔ=${s.heapDeltaMB.toFixed(1)}MB steal=${s.steal.join('/')}`).join(' | ');
}

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
  // #6646: g is in the join predicate (7919·g mod PAGES is distinct and non-zero for g = 1..5), so each filler page
  // gets LINKS/PAGES distinct targets; the cross join used to run after the join and every edge was produced 5 times.
  await db.query(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
     SELECT p1.id, p2.id, 'mentions', 'mentions'
     FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE slug LIKE 'filler/%') p1
     CROSS JOIN generate_series(1, ${Math.ceil(LINKS / PAGES)}) g
     JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE slug LIKE 'filler/%') p2
       ON p2.rn = ((p1.rn + 7919 * g) % ${PAGES}) + 1 AND p1.id <> p2.id
     ON CONFLICT DO NOTHING`,
  );
  const [{ n: fillerLinks }] = (await db.query(
    `SELECT count(*)::int AS n FROM links l JOIN pages a ON a.id = l.from_page_id JOIN pages b ON b.id = l.to_page_id
      WHERE a.slug LIKE 'filler/%' AND b.slug LIKE 'filler/%'`,
  )).rows as Array<{ n: number }>;
  expect(fillerLinks).toBe(LINKS);
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
  // Entity recall: a hub with 10,000 inbound mention links (the card's worst
  // case for referenced_by), its referrers spread over five types, and a
  // complete mention status row (the coverage read).
  await engine.putPage(HUB_SLUG, { type: 'company', title: 'Hub Company', compiled_truth: '# Hub Company\n\nSynthetic hub.', frontmatter: {} }, { sourceId: 'default' });
  await db.query(
    `UPDATE pages SET type = (ARRAY['ticket','email','meeting','note','contract'])[(id % 5) + 1]
      WHERE id IN (SELECT id FROM pages WHERE slug LIKE 'filler/%' ORDER BY id LIMIT ${HUB_LINKS})`,
  );
  await db.query(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
     SELECT f.id, h.id, 'mentions', 'mentions'
       FROM (SELECT id FROM pages WHERE slug LIKE 'filler/%' ORDER BY id LIMIT ${HUB_LINKS}) f,
            (SELECT id FROM pages WHERE slug = '${HUB_SLUG}') h
     ON CONFLICT DO NOTHING`,
  );
  await db.query(`INSERT INTO mention_index_status (source_id, state, pending, counted_at, last_pass_at) VALUES ('default', 'complete', 0, now(), now())`);
  await engine.executeRaw('ANALYZE pages, links, page_aliases, facts');
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

    Bun.gc(true);
    const runs: Sample[] = [];
    for (let i = 0; i < MEASURED; i++) {
      const name = names[(i * 13) % names.length];
      runs.push(await sample(name, () => buildEntityCard(engine, 'default', name, { remote: true })));
    }
    // eslint-disable-next-line no-console
    console.log(`[entity-card-perf] slowest: ${slowest(runs)}`);
    const samples = runs.map(r => r.cpu).sort((a, b) => a - b);
    const walls = runs.map(r => r.wall).sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);

    // Ratio baseline: getPage p50 on the same corpus, timed the same way.
    const pageSamples: number[] = [];
    for (let i = 0; i < 50; i++) {
      pageSamples.push((await sample('getPage', () => engine.getPage(`people/target-person-${i % TARGET_ENTITIES}`, { sourceId: 'default' }))).cpu);
    }
    pageSamples.sort((a, b) => a - b);
    const pageP50 = Math.max(percentile(pageSamples, 50), 1.0); // 1ms floor vs sub-ms division noise

    // eslint-disable-next-line no-console
    console.log(
      `[entity-card-perf] corpus=${PAGES}p+${LINKS}l+${ALIASES}a+${FACTS}f ` +
      `entity cpu p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms (wall p99=${percentile(walls, 99).toFixed(2)}ms) | getPage p50=${pageP50.toFixed(2)}ms ` +
      `| ratio=${(p99 / pageP50).toFixed(1)}x (ceiling ${RATIO_CEILING}x) | budget=${P99_BUDGET_MS}ms`,
    );

    expect(p99).toBeLessThan(P99_BUDGET_MS);
    expect(p99 / pageP50).toBeLessThanOrEqual(RATIO_CEILING);
  }, 300_000);
});

describe('entity verb with referenced_by (entity recall)', () => {
  const opts = { remote: true, includeReferences: true };

  it(`ordinary entities: p99 < ${P99_BUDGET_MS}ms with referenced_by and coverage`, async () => {
    const names: string[] = [];
    for (let i = 0; i < TARGET_ENTITIES; i++) names.push(`Target Person ${i}`, `tp${i}`, `zzz-absent-${i}`);
    for (let i = 0; i < WARMUP; i++) await buildEntityCard(engine, 'default', names[i % names.length], opts);
    Bun.gc(true);
    const runs: Sample[] = [];
    for (let i = 0; i < MEASURED; i++) {
      const name = names[(i * 13) % names.length];
      runs.push(await sample(name, () => buildEntityCard(engine, 'default', name, opts)));
    }
    // eslint-disable-next-line no-console
    console.log(`[entity-recall-perf] slowest: ${slowest(runs)}`);
    const samples = runs.map(r => r.cpu).sort((a, b) => a - b);
    const walls = runs.map(r => r.wall).sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);
    // eslint-disable-next-line no-console
    console.log(`[entity-recall-perf] ordinary entity+references cpu p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms (wall p99=${percentile(walls, 99).toFixed(2)}ms) | budget=${P99_BUDGET_MS}ms`);
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  }, 300_000);

  it(`${HUB_LINKS}-link hub: card median ≤ ${HUB_RATIO_CEILING}× the distinct-referrer count`, async () => {
    const countSql = `SELECT count(DISTINCT l.from_page_id)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id
      WHERE l.to_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default') AND f.deleted_at IS NULL`;
    for (let i = 0; i < 5; i++) {
      await buildEntityCard(engine, 'default', 'Hub Company', opts);
      await engine.executeRaw(countSql, [HUB_SLUG]);
    }
    // Interleave the two measurements so a burst of runner load lands on both.
    const card: number[] = [];
    const base: number[] = [];
    let hubCard: Awaited<ReturnType<typeof buildEntityCard>>['card'];
    for (let i = 0; i < HUB_SAMPLES; i++) {
      let t0 = performance.now();
      hubCard = (await buildEntityCard(engine, 'default', 'Hub Company', opts)).card;
      card.push(performance.now() - t0);
      t0 = performance.now();
      await engine.executeRaw(countSql, [HUB_SLUG]);
      base.push(performance.now() - t0);
    }
    card.sort((a, b) => a - b);
    base.sort((a, b) => a - b);
    const cardP50 = percentile(card, 50);
    const baseP50 = Math.max(percentile(base, 50), 1);
    // eslint-disable-next-line no-console
    console.log(`[entity-recall-perf] hub=${HUB_LINKS} links card p50=${cardP50.toFixed(2)}ms p90=${percentile(card, 90).toFixed(2)}ms ` +
      `| distinct-referrer count p50=${baseP50.toFixed(2)}ms | ratio=${(cardP50 / baseP50).toFixed(1)}x (ceiling ${HUB_RATIO_CEILING}x)`);
    // Real work: the hub card carries every referrer in its count and at most 50 rows.
    expect(hubCard?.referenced_by_count).toBe(HUB_LINKS);
    expect(hubCard!.referenced_by!.reduce((n, g) => n + g.rows.length, 0)).toBeLessThanOrEqual(50);
    expect(cardP50 / baseP50).toBeLessThanOrEqual(HUB_RATIO_CEILING);
    expect(cardP50).toBeLessThan(HUB_ABSOLUTE_CEILING_MS);
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

// F1: `entity names` with the reference fields and records, 50 names with two identity siblings each (150 target
// pages). Gates: one batched referrer read per call (2 statements whatever the name count), and the reference phase
// adds at most REFERENCES_ADDED_CEILING to the same call with every reference field off (the names lookup itself, 50
// card resolutions, is the baseline; measured in pairs so runner load lands on both).
const REFERENCES_ADDED_CEILING = 0.5;
// Measured pairs. 40 CI runs (Oct 22-25) of the old wall-clock ratio of two medians of 10 read median 16.5%, a tail
// to 38.5%, and one 51.8% failure: wall time counts time off the CPU. Thread CPU time in pairs reads 14-16% here.
const NAMES_RECORDS_PAIRS = 20;
describe('entity names with records (50 names, 150 target pages)', () => {
  it(`50 names with siblings: references add at most ${REFERENCES_ADDED_CEILING * 100}% and a constant number of referrer statements`, async () => {
    const { lookupEntityNames } = await import('../src/core/verbs/entity-names.ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (engine as any).db;
    for (let i = 0; i < 50; i++) {
      for (const [prefix, label] of [['crm', 'CRM record'], ['accounts', 'Account sheet'], ['deals', 'Deal room']]) {
        await engine.putPage(`${prefix}/perf-account-${i}`, { type: 'company', title: `${label}: Perf Account ${i}`, compiled_truth: `Perf Account ${i}.`, frontmatter: {} }, { sourceId: 'default' });
      }
    }
    await db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       SELECT f.id, t.id, '', 'markdown'
         FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE type = 'contract' ORDER BY id LIMIT 1500) f
         JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM pages WHERE slug LIKE '%/perf-account-%') t ON (f.rn % 150) + 1 = t.rn
       ON CONFLICT DO NOTHING`);
    await engine.executeRaw('ANALYZE pages, links');
    const names = Array.from({ length: 50 }, (_, i) => `crm/perf-account-${i}`);
    let referrerStatements = 0;
    const raw = engine.executeRaw.bind(engine);
    engine.executeRaw = ((sql: string, params?: unknown[]) => {
      if (sql.includes('refs AS MATERIALIZED')) referrerStatements++;
      return raw(sql, params as never);
    }) as typeof engine.executeRaw;
    const on = async () => { await engine.setConfig('entity.record_types', 'contract'); await engine.unsetConfig('entity.names_references'); };
    const off = async () => { await engine.unsetConfig('entity.record_types'); await engine.setConfig('entity.names_references', 'false'); };
    try {
      for (let i = 0; i < 2; i++) { await on(); await lookupEntityNames(engine, 'default', names, { remote: true }); await off(); await lookupEntityNames(engine, 'default', names, { remote: true }); }
      // Each pair times both calls back to back on this thread's CPU (sample(): time spent off the CPU is not counted,
      // a window the hypervisor stole from is timed again). The pair order alternates, and the gate is the median of
      // the per-pair ratios.
      const ratios: number[] = [];
      const pairs: Array<{ refs: Sample; base: Sample }> = [];
      let last: Awaited<ReturnType<typeof lookupEntityNames>> | null = null;
      let statements = 0;
      const timed = async (refsOn: boolean): Promise<Sample> => {
        await (refsOn ? on() : off());
        return sample(refsOn ? 'references' : 'base', async () => {
          referrerStatements = 0;
          const result = await lookupEntityNames(engine, 'default', names, { remote: true });
          if (refsOn) last = result;
        });
      };
      for (let i = 0; i < NAMES_RECORDS_PAIRS; i++) {
        let refs: Sample, base: Sample;
        if (i % 2 === 0) { refs = await timed(true); statements += referrerStatements; base = await timed(false); }
        else { base = await timed(false); refs = await timed(true); statements += referrerStatements; }
        pairs.push({ refs, base });
        ratios.push(refs.cpu / base.cpu);
      }
      ratios.sort((a, b) => a - b);
      const added = percentile(ratios, 50) - 1;
      const median = (xs: number[]) => percentile([...xs].sort((a, b) => a - b), 50);
      // eslint-disable-next-line no-console
      console.log(`[entity-names-records-perf] 50 names / 150 targets with references cpu p50=${median(pairs.map(x => x.refs.cpu)).toFixed(2)}ms ` +
        `| all reference fields off cpu p50=${median(pairs.map(x => x.base.cpu)).toFixed(2)}ms | added=${(added * 100).toFixed(1)}% ` +
        `(median of ${NAMES_RECORDS_PAIRS} paired ratios, ${(ratios[0]! * 100 - 100).toFixed(1)}%..${(ratios.at(-1)! * 100 - 100).toFixed(1)}%; ceiling ${REFERENCES_ADDED_CEILING * 100}%)`);
      // eslint-disable-next-line no-console
      console.log(`[entity-names-records-perf] slowest: ${slowest(pairs.flatMap(x => [x.refs, x.base]))}`);
      const rows = last!.results.flatMap(r => (r.found ? [r, ...(r.siblings ?? [])] : []));
      expect(rows).toHaveLength(150);
      expect(rows.every(r => typeof r.referenced_by_count === 'number' && Array.isArray(r.records))).toBe(true);
      expect(rows.reduce((n, r) => n + (r.records ?? []).reduce((m, g) => m + g.rows.length, 0), 0)).toBe(24);
      expect(statements).toBe(NAMES_RECORDS_PAIRS * 2);
      expect(added).toBeLessThanOrEqual(REFERENCES_ADDED_CEILING);
    } finally {
      engine.executeRaw = raw;
      await engine.unsetConfig('entity.record_types');
      await engine.unsetConfig('entity.names_references');
    }
  }, 300_000);
});
