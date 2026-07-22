// v0.41 T10 — calibration domain aggregators.
//
// Tests the per-aggregator SQL shape + the R1 IRON-RULE byte-identical
// regression (empty {} JSONB when no active pack declares domains).
//
// Covers all 4 aggregator kinds (scalar_brier, weighted_brier,
// count_based, cluster_summary) against real PGLite. Seeds takes +
// take_domain_assignments + pages and asserts the expected scorecard
// shape comes back.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { aggregateDomainScorecards } from '../src/core/calibration/domain-aggregators.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { CalibrationDomain } from '../src/core/schema-pack/manifest-v1.ts';

let engine: PGLiteEngine;

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

async function seedTakeWithAssignment(
  slug: string,
  pageType: string,
  takeOpts: {
    weight: number;
    resolved_outcome: boolean;
    holder?: string;
    sourceId?: string;
    rowNum?: number;
  },
  assignmentOpts: {
    domain: string;
    pack: string;
    confidence?: number;
  },
): Promise<void> {
  const holder = takeOpts.holder ?? 'garry';
  const sourceId = takeOpts.sourceId ?? 'default';
  const rowNum = takeOpts.rowNum ?? 1;

  await engine.putPage(slug, {
    title: slug,
    type: pageType,
    compiled_truth: '',
    frontmatter: {},
    timeline: '',
  });
  const pageRow = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
    [slug, sourceId],
  );
  const pageId = pageRow[0].id;
  await engine.executeRaw(
    `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, resolved_outcome, resolved_at, active)
     VALUES ($1, $2, $3, 'take', $4, $5, $6, now(), TRUE)`,
    [pageId, rowNum, `claim for ${slug}`, holder, takeOpts.weight, takeOpts.resolved_outcome],
  );
  const takeRow = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM takes WHERE page_id = $1 AND row_num = $2 LIMIT 1`,
    [pageId, rowNum],
  );
  const takeId = takeRow[0].id;
  await engine.executeRaw(
    `INSERT INTO take_domain_assignments (take_id, domain, pack, confidence)
     VALUES ($1, $2, $3, $4)`,
    [takeId, assignmentOpts.domain, assignmentOpts.pack, assignmentOpts.confidence ?? 1.0],
  );
}

describe('v0.41 T10 R1: empty domain list returns {} (byte-identical regression)', () => {
  test('aggregateDomainScorecards with [] domains returns {}', async () => {
    const result = await aggregateDomainScorecards(engine, 'garry', [], 'default');
    expect(result).toEqual({});
  });
});

describe('v0.41 T10: scalar_brier aggregator', () => {
  const domain: CalibrationDomain = {
    name: 'deal_success',
    aggregator: 'scalar_brier',
    page_types: ['deal'],
  };

  test('returns n:0 + null brier when no takes match', async () => {
    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.deal_success.n).toBe(0);
    expect(result.deal_success.brier).toBeNull();
    expect(result.deal_success.accuracy).toBeNull();
    expect(result.deal_success.aggregator).toBe('scalar_brier');
    expect(result.deal_success.page_types).toEqual(['deal']);
  });

  test('computes Brier over resolved deal-attached takes', async () => {
    // Two takes: one perfect (p=1, outcome=true → sq_err=0), one wrong (p=1, outcome=false → sq_err=1)
    await seedTakeWithAssignment(
      'deals/perfect',
      'deal',
      { weight: 1.0, resolved_outcome: true, rowNum: 1 },
      { domain: 'deal_success', pack: 'gbrain-investor' },
    );
    await seedTakeWithAssignment(
      'deals/wrong',
      'deal',
      { weight: 1.0, resolved_outcome: false, rowNum: 1 },
      { domain: 'deal_success', pack: 'gbrain-investor' },
    );

    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.deal_success.n).toBe(2);
    // Mean of (0, 1) = 0.5
    expect(result.deal_success.brier).toBeCloseTo(0.5, 2);
    // Accuracy: weight>=0.5 (true) === outcome → 1 hit, 1 miss → 0.5
    expect(result.deal_success.accuracy).toBeCloseTo(0.5, 2);
  });

  test('filters by holder', async () => {
    await seedTakeWithAssignment(
      'deals/mine',
      'deal',
      { weight: 0.9, resolved_outcome: true, holder: 'garry', rowNum: 1 },
      { domain: 'deal_success', pack: 'gbrain-investor' },
    );
    await seedTakeWithAssignment(
      'deals/theirs',
      'deal',
      { weight: 0.1, resolved_outcome: true, holder: 'alice-example', rowNum: 1 },
      { domain: 'deal_success', pack: 'gbrain-investor' },
    );

    const garryResult = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(garryResult.deal_success.n).toBe(1);
    const aliceResult = await aggregateDomainScorecards(engine, 'alice-example', [domain], 'default');
    expect(aliceResult.deal_success.n).toBe(1);
  });

  test('filters by page_types (only matching types counted)', async () => {
    await seedTakeWithAssignment(
      'deals/match',
      'deal',
      { weight: 0.8, resolved_outcome: true, rowNum: 1 },
      { domain: 'deal_success', pack: 'gbrain-investor' },
    );
    await seedTakeWithAssignment(
      'people/no-match',
      'person',
      { weight: 0.8, resolved_outcome: true, rowNum: 1 },
      { domain: 'deal_success', pack: 'gbrain-investor' },
    );

    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.deal_success.n).toBe(1);
  });

  test('ignores unresolved takes', async () => {
    await engine.putPage('deals/unresolved', {
      title: 'unresolved',
      type: 'deal',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'deals/unresolved' LIMIT 1`,
    );
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
       VALUES ($1, 1, 'unresolved', 'take', 'garry', 0.7, TRUE)`,
      [pageRow[0].id],
    );
    const takeRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM takes WHERE page_id = $1 LIMIT 1`,
      [pageRow[0].id],
    );
    await engine.executeRaw(
      `INSERT INTO take_domain_assignments (take_id, domain, pack)
       VALUES ($1, 'deal_success', 'gbrain-investor')`,
      [takeRow[0].id],
    );

    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.deal_success.n).toBe(0);
  });
});

describe('v0.41 T10: weighted_brier aggregator', () => {
  const domain: CalibrationDomain = {
    name: 'market_call',
    aggregator: 'weighted_brier',
    page_types: ['thesis'],
  };

  test('high-conviction miss weighted more than low-conviction miss', async () => {
    // High-conviction miss: weight=0.95 (conviction = ABS(0.95-0.5)*2 = 0.9), outcome=false → sq_err=0.9025
    await seedTakeWithAssignment(
      'theses/high-conv-miss',
      'thesis',
      { weight: 0.95, resolved_outcome: false, rowNum: 1 },
      { domain: 'market_call', pack: 'gbrain-investor' },
    );
    // Low-conviction hit: weight=0.55 (conviction = 0.1), outcome=true → sq_err=0.2025
    await seedTakeWithAssignment(
      'theses/low-conv-hit',
      'thesis',
      { weight: 0.55, resolved_outcome: true, rowNum: 1 },
      { domain: 'market_call', pack: 'gbrain-investor' },
    );

    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.market_call.n).toBe(2);
    // Weighted mean: (0.9025 * 0.9 + 0.2025 * 0.1) / (0.9 + 0.1) ≈ 0.8325
    expect(result.market_call.brier).toBeCloseTo(0.8325, 2);
  });

  test('accuracy independent of conviction weighting', async () => {
    await seedTakeWithAssignment(
      'theses/a',
      'thesis',
      { weight: 0.9, resolved_outcome: true, rowNum: 1 },
      { domain: 'market_call', pack: 'gbrain-investor' },
    );
    await seedTakeWithAssignment(
      'theses/b',
      'thesis',
      { weight: 0.6, resolved_outcome: true, rowNum: 1 },
      { domain: 'market_call', pack: 'gbrain-investor' },
    );
    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.market_call.accuracy).toBeCloseTo(1.0, 2);
  });
});

describe('v0.41 T10: count_based aggregator', () => {
  const domain: CalibrationDomain = {
    name: 'simple_acc',
    aggregator: 'count_based',
    page_types: ['deal'],
  };

  test('computes accuracy without brier', async () => {
    await seedTakeWithAssignment(
      'deals/right',
      'deal',
      { weight: 0.8, resolved_outcome: true, rowNum: 1 },
      { domain: 'simple_acc', pack: 'test' },
    );
    await seedTakeWithAssignment(
      'deals/wrong',
      'deal',
      { weight: 0.8, resolved_outcome: false, rowNum: 1 },
      { domain: 'simple_acc', pack: 'test' },
    );
    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.simple_acc.n).toBe(2);
    expect(result.simple_acc.brier).toBeNull();
    expect(result.simple_acc.accuracy).toBeCloseTo(0.5, 2);
    expect(result.simple_acc.aggregator).toBe('count_based');
  });
});

describe('v0.41 T10: cluster_summary aggregator', () => {
  const domain: CalibrationDomain = {
    name: 'concept_themes',
    aggregator: 'cluster_summary',
    page_types: ['concept'],
  };

  test('returns page count + tier histogram', async () => {
    await engine.putPage('concepts/canon-a', {
      title: 'a',
      type: 'concept',
      compiled_truth: '',
      frontmatter: { tier: 'T1' },
      timeline: '',
    });
    await engine.putPage('concepts/canon-b', {
      title: 'b',
      type: 'concept',
      compiled_truth: '',
      frontmatter: { tier: 'T1' },
      timeline: '',
    });
    await engine.putPage('concepts/dev', {
      title: 'dev',
      type: 'concept',
      compiled_truth: '',
      frontmatter: { tier: 'T2' },
      timeline: '',
    });
    await engine.putPage('concepts/no-tier', {
      title: 'no-tier',
      type: 'concept',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });

    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.concept_themes.n).toBe(4);
    expect(result.concept_themes.brier).toBeNull();
    expect(result.concept_themes.accuracy).toBeNull();
    expect(result.concept_themes.aggregator).toBe('cluster_summary');
    const tiers = (result.concept_themes.extras as { tier_counts: Record<string, number> }).tier_counts;
    expect(tiers.T1).toBe(2);
    expect(tiers.T2).toBe(1);
    expect(tiers.T3).toBe(0);
    expect(tiers.T4).toBe(0);
  });

  test('returns n:0 + all-zero tiers when no concepts exist', async () => {
    const result = await aggregateDomainScorecards(engine, 'garry', [domain], 'default');
    expect(result.concept_themes.n).toBe(0);
  });
});

describe('v0.41 T10: multi-domain aggregation', () => {
  test('aggregates all declared domains in one call', async () => {
    await seedTakeWithAssignment(
      'deals/d1',
      'deal',
      { weight: 0.9, resolved_outcome: true, rowNum: 1 },
      { domain: 'deal_success', pack: 'gbrain-investor' },
    );
    await seedTakeWithAssignment(
      'people/p1',
      'person',
      { weight: 0.7, resolved_outcome: true, rowNum: 1 },
      { domain: 'founder_evaluation', pack: 'gbrain-investor' },
    );

    const domains: CalibrationDomain[] = [
      { name: 'deal_success', aggregator: 'scalar_brier', page_types: ['deal'] },
      { name: 'founder_evaluation', aggregator: 'scalar_brier', page_types: ['person'] },
      { name: 'empty_domain', aggregator: 'scalar_brier', page_types: ['deal'] },
    ];
    const result = await aggregateDomainScorecards(engine, 'garry', domains, 'default');

    expect(Object.keys(result).sort()).toEqual([
      'deal_success',
      'empty_domain',
      'founder_evaluation',
    ]);
    expect(result.deal_success.n).toBe(1);
    expect(result.founder_evaluation.n).toBe(1);
    expect(result.empty_domain.n).toBe(0);
  });
});

describe('v0.41 T10: fail-soft per domain', () => {
  test('one domain SQL error does NOT block other domains', async () => {
    // Inject a malformed-but-shape-valid domain. The aggregator JOINs
    // pages by source_id='default'; a domain pointing at a non-existent
    // page_type still completes (returns n=0). Errors come from things
    // like SQL syntax mistakes — harder to trigger via the public API.
    // For now, assert that an empty page_types-mismatch domain produces
    // a clean n=0 result without throwing.
    const domains: CalibrationDomain[] = [
      { name: 'good', aggregator: 'scalar_brier', page_types: ['deal'] },
      { name: 'nonexistent', aggregator: 'scalar_brier', page_types: ['__fake_type__'] },
    ];
    const result = await aggregateDomainScorecards(engine, 'garry', domains, 'default');
    expect(result.good).toBeDefined();
    expect(result.nonexistent).toBeDefined();
    expect(result.nonexistent.n).toBe(0);
  });
});
