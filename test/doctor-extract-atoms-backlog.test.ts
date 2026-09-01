/**
 * issue #1678 — extract_atoms backlog count + doctor check.
 *
 * Pins:
 *  - countExtractAtomsBacklog counts eligible-but-unextracted pages (scoped +
 *    brain-wide) and excludes pages that already have an atom (NOT EXISTS).
 *  - computeExtractAtomsBacklogCheck WARNs with a `--drain` hint when the pack
 *    doesn't run the phase and the backlog is real; OK at 0.
 *
 * Real in-memory PGLite (canonical block, R3+R4). GBRAIN_HOME is pointed at an
 * empty tmpdir for the doctor-check cases so packDeclaresPhase resolves the
 * bundled base pack (which does NOT declare extract_atoms) deterministically,
 * independent of the developer's real ~/.gbrain config.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
import { computeExtractAtomsBacklogCheck } from '../src/commands/doctor.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

let engine: PGLiteEngine;
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'gbrain-xa-backlog-home-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const BODY = 'x'.repeat(600); // >= MIN_PAGE_CHARS_FOR_EXTRACTION (500)

async function seedArticle(slug: string, sourceId = 'default') {
  return engine.putPage(slug, { type: 'article', title: slug, compiled_truth: BODY }, { sourceId });
}

describe('countExtractAtomsBacklog (issue #1678)', () => {
  it('counts eligible pages with no atom (scoped + brain-wide)', async () => {
    await seedArticle('article-a');
    await seedArticle('article-b');
    await seedArticle('article-c');
    expect(await countExtractAtomsBacklog(engine)).toBe(3);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(3);
  });

  it('excludes a page that already has a matching atom (NOT EXISTS)', async () => {
    const p = await seedArticle('article-x');
    const h16 = (p.content_hash ?? '').slice(0, 16);
    expect(h16.length).toBe(16);
    await engine.putPage('atoms/a1', {
      type: 'atom',
      title: 'a1',
      compiled_truth: 'an extracted nugget',
      frontmatter: { source_hash: h16 },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  it('ignores short pages and dream-generated pages', async () => {
    await engine.putPage('article-short', { type: 'article', title: 's', compiled_truth: 'too short' });
    await engine.putPage('article-dream', {
      type: 'article', title: 'd', compiled_truth: BODY,
      frontmatter: { dream_generated: 'true' },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  it('ignores raw source-holder pages (permanent no-progress backlog otherwise)', async () => {
    await engine.putPage('wiki/raw-email-source', {
      type: 'source',
      title: 'Raw email source',
      compiled_truth: BODY,
      frontmatter: { raw: 'raw/email/example.md' },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
  });
});

describe('computeExtractAtomsBacklogCheck (issue #1678)', () => {
  it('OK with no backlog', async () => {
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect((check.details as { backlog: number }).backlog).toBe(0);
  });

  it('WARNs with a --drain hint when the pack does not run the phase and backlog > 10', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`article-${i}`);
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('--drain');
    expect((check.details as { pack_declares_phase: boolean }).pack_declares_phase).toBe(false);
    expect((check.details as { known_approximation: string }).known_approximation).toContain('page backlog only');
  });

  it('includes the source in the drain hint when backlog lives outside default', async () => {
    await addSource(engine, { id: 'gbrain-raw' });
    for (let i = 0; i < 11; i++) await seedArticle(`raw-article-${i}`, 'gbrain-raw');

    expect(await countExtractAtomsBacklog(engine)).toBe(11);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    expect(await countExtractAtomsBacklog(engine, 'gbrain-raw')).toBe(11);

    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain dream --phase extract_atoms --drain --source gbrain-raw --window 120');
    expect((check.details as { fix_hint: string }).fix_hint).toContain('--source gbrain-raw');
    expect((check.details as { backlog_by_source: Array<{ source_id: string; backlog: number }> }).backlog_by_source)
      .toEqual([{ source_id: 'gbrain-raw', backlog: 11 }]);
  });

  it('multi-source fix hint folds the declare suggestion INTO the trailing parenthetical (exactly one closing paren)', async () => {
    await addSource(engine, { id: 'src-alpha' });
    await addSource(engine, { id: 'src-beta' });
    for (let i = 0; i < 6; i++) await seedArticle(`alpha-article-${i}`, 'src-alpha');
    for (let i = 0; i < 6; i++) await seedArticle(`beta-article-${i}`, 'src-beta');

    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    const fix = (check.details as { fix_hint: string }).fix_hint;
    expect(fix).toContain('--source src-alpha --window 120 (repeat for backlog source(s): src-alpha, src-beta;');
    expect(fix).toContain('or declare extract_atoms in your active schema pack');
    // The fold replaces the closing paren instead of appending a second
    // parenthetical: "…; or declare …)" — one trailing ')', never "))" or ") (".
    expect(fix).toMatch(/[^)]\)$/);
    expect(fix).not.toContain(') (or declare');
    expect(check.message).toContain(fix);
  });
});

// ---------------------------------------------------------------------------
// #4576 — the DECLARED branch must verify something actually runs the cycle
// before returning the "active pack runs extract_atoms each cycle" ok.
// ---------------------------------------------------------------------------

const PACK_HOME = mkdtempSync(join(tmpdir(), 'gbrain-xa-backlog-pack-home-'));
const PACK_NAME = 'declares-xa';
const PACK_ENV = { GBRAIN_HOME: PACK_HOME, GBRAIN_SCHEMA_PACK: PACK_NAME };

function seedDeclaringPack(): void {
  const dir = join(PACK_HOME, 'schema-packs', PACK_NAME);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, [
    'api_version: gbrain-schema-pack-v1',
    `name: ${PACK_NAME}`,
    'version: 1.0.0',
    'description: ""',
    'gbrain_min_version: 0.38.0',
    'extends: null',
    'borrow_from: []',
    'page_types: []',
    'link_types: []',
    'frontmatter_links: []',
    'takes_kinds:',
    '  - fact',
    'enrichable_types: []',
    'filing_rules: []',
    'phases:',
    '  - extract_atoms',
    '',
  ].join('\n'), 'utf-8');
  __setPackLocatorForTests((name) => (name === PACK_NAME ? path : null));
}

/** Seed a local_path source, optionally stamped with last_full_cycle_at. */
async function seedCycledSource(id: string, lastFullCycleAt?: string): Promise<void> {
  const config = JSON.stringify(lastFullCycleAt ? { last_full_cycle_at: lastFullCycleAt } : {});
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, $4::text::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [id, id, `/tmp/${id}`, config],
  );
}

describe('computeExtractAtomsBacklogCheck — declared branch verifies a runner (#4576)', () => {
  beforeEach(() => {
    _resetPackCacheForTests();
    seedDeclaringPack();
  });

  afterAll(() => {
    _resetPackLocatorForTests();
    _resetPackCacheForTests();
  });

  it('WARNs when the pack declares the phase but NO cycle has ever completed', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`declared-never-${i}`);
    await seedCycledSource('vault'); // local source, no last_full_cycle_at
    const check = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('no full cycle has ever completed');
    expect(check.message).toContain('gbrain autopilot --install');
    expect(check.message).toContain('gbrain dream --phase extract_atoms --drain');
    const details = check.details as { pack_declares_phase: boolean; cycle_evidence: string };
    expect(details.pack_declares_phase).toBe(true);
    expect(details.cycle_evidence).toBe('never');
  });

  it('WARNs when the last full cycle is stale (older than the warn window)', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`declared-stale-${i}`);
    await seedCycledSource('vault', new Date(Date.now() - 48 * 3600_000).toISOString());
    const check = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('no full cycle has completed in 48h');
    expect(check.message).toContain('gbrain autopilot --install');
    expect((check.details as { cycle_evidence: string }).cycle_evidence).toBe('stale');
  });

  it('stays OK when a cycle completed recently (fresh evidence)', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`declared-fresh-${i}`);
    await seedCycledSource('vault', new Date(Date.now() - 3600_000).toISOString());
    const check = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('active pack runs extract_atoms each cycle');
    expect((check.details as { pack_declares_phase: boolean }).pack_declares_phase).toBe(true);
  });

  it('stays OK below the warn threshold even with no cycle evidence', async () => {
    for (let i = 0; i < 3; i++) await seedArticle(`declared-small-${i}`);
    await seedCycledSource('vault');
    const check = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('active pack runs extract_atoms each cycle');
  });

  it("stays OK on a brain shape that CANNOT carry cycle stamps (legacy unscoped-dream: no local_path sources, no implicit default)", async () => {
    // Review fix for the #4576 gate: with zero local_path sources and no
    // implicit default, neither the per-source cycle nor the #4700 implicit
    // lane can ever write last_full_cycle_at — 'never' is a property of the
    // brain SHAPE, not evidence that nothing runs. Keep the old
    // ok-with-reassurance instead of a false warn.
    for (let i = 0; i < 11; i++) await seedArticle(`declared-shapeless-${i}`);
    // Deliberately NO seedCycledSource / sources.default: everything lives in
    // 'default' with no local_path registration.
    const check = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('active pack runs extract_atoms each cycle');
    expect((check.details as { cycle_evidence?: string }).cycle_evidence).toBe('unavailable');
  });

  it("implicit-default lane: a source WITHOUT local_path routed via sources.default makes the shape stampable → 'never' WARNs", async () => {
    // brainShapeCanCarryCycleStamps's SECOND lane. The sibling test seeds a
    // local_path source, so the FIRST lane already answers true there; here
    // there are zero local_path sources and only the #4700 implicit-default
    // lane (sources.default → a non-'default' source) can make 'never'
    // meaningful. Without the config the same shape reads ok/'unavailable'.
    for (let i = 0; i < 11; i++) await seedArticle(`declared-implicit-only-${i}`);
    await addSource(engine, { id: 'vault' }); // pure DB source: no local_path
    expect(await engine.listAllSources({ localPathOnly: true })).toHaveLength(0);

    const before = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(before.status).toBe('ok');
    expect((before.details as { cycle_evidence?: string }).cycle_evidence).toBe('unavailable');

    await engine.setConfig('sources.default', 'vault');
    const check = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('no full cycle has ever completed');
    expect((check.details as { cycle_evidence: string }).cycle_evidence).toBe('never');
  });

  it('still WARNs on that shape once an implicit default exists (sources.default routes the canonical cycle)', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`declared-implicit-${i}`);
    await seedCycledSource('vault'); // stampable local_path source, no stamp
    await engine.setConfig('sources.default', 'vault');
    const check = await withEnv(PACK_ENV, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('no full cycle has ever completed');
  });
});
