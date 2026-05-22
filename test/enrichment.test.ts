/**
 * BudgetLedger + CompletenessScorer tests.
 *
 * BudgetLedger runs against PGLite in-memory (needs real FOR UPDATE semantics
 * and the v11 schema migration). CompletenessScorer is pure — no engine.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

import { BudgetLedger, BudgetError } from '../src/core/enrichment/budget.ts';
import {
  scorePage,
  getRubric,
  personRubric,
  companyRubric,
  projectRubric,
  dealRubric,
  conceptRubric,
  sourceRubric,
  mediaRubric,
  defaultRubric,
} from '../src/core/enrichment/completeness.ts';
import type { Page } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Engine fixture (BudgetLedger only)
// ---------------------------------------------------------------------------

let engine: BrainEngine;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'enrichment-test-'));
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbDir });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

async function resetBudget(): Promise<void> {
  await engine.executeRaw('TRUNCATE budget_ledger, budget_reservations');
}

// ---------------------------------------------------------------------------
// BudgetLedger
// ---------------------------------------------------------------------------

describe('BudgetLedger', () => {
  beforeEach(async () => { await resetBudget(); });

  test('reserve under cap succeeds', async () => {
    const ledger = new BudgetLedger(engine);
    const r = await ledger.reserve({ resolverId: 'perplexity', estimateUsd: 0.5, capUsd: 1.0 });
    expect(r.kind).toBe('held');
    if (r.kind === 'held') {
      expect(r.resolverId).toBe('perplexity');
      expect(r.estimateUsd).toBe(0.5);
    }
  });

  test('reserve over cap returns exhausted', async () => {
    const ledger = new BudgetLedger(engine);
    const r1 = await ledger.reserve({ resolverId: 'perplexity', estimateUsd: 0.8, capUsd: 1.0 });
    expect(r1.kind).toBe('held');
    const r2 = await ledger.reserve({ resolverId: 'perplexity', estimateUsd: 0.5, capUsd: 1.0 });
    expect(r2.kind).toBe('exhausted');
    if (r2.kind === 'exhausted') {
      expect(r2.reason).toContain('cap');
    }
  });

  test('commit finalizes reservation and moves money from reserved to committed', async () => {
    const ledger = new BudgetLedger(engine);
    const r = await ledger.reserve({ resolverId: 'x', estimateUsd: 0.5, capUsd: 1.0 });
    expect(r.kind).toBe('held');
    if (r.kind !== 'held') return;

    await ledger.commit(r.reservationId, 0.42);
    const state = await ledger.state('default', 'x');
    expect(state?.reservedUsd).toBe(0);
    expect(state?.committedUsd).toBeCloseTo(0.42);
  });

  test('rollback clears reserved', async () => {
    const ledger = new BudgetLedger(engine);
    const r = await ledger.reserve({ resolverId: 'x', estimateUsd: 0.5, capUsd: 1.0 });
    if (r.kind !== 'held') throw new Error('setup');
    await ledger.rollback(r.reservationId);
    const state = await ledger.state('default', 'x');
    expect(state?.reservedUsd).toBe(0);
    expect(state?.committedUsd).toBe(0);
  });

  test('commit-then-rollback is a no-op', async () => {
    const ledger = new BudgetLedger(engine);
    const r = await ledger.reserve({ resolverId: 'x', estimateUsd: 0.5, capUsd: 1.0 });
    if (r.kind !== 'held') throw new Error('setup');
    await ledger.commit(r.reservationId, 0.3);
    // Second rollback should be a no-op, not throw
    await ledger.rollback(r.reservationId);
    const state = await ledger.state('default', 'x');
    expect(state?.committedUsd).toBeCloseTo(0.3);
  });

  test('commit-after-commit throws already_finalized', async () => {
    const ledger = new BudgetLedger(engine);
    const r = await ledger.reserve({ resolverId: 'x', estimateUsd: 0.5, capUsd: 1.0 });
    if (r.kind !== 'held') throw new Error('setup');
    await ledger.commit(r.reservationId, 0.3);
    try {
      await ledger.commit(r.reservationId, 0.3);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetError);
      expect((e as BudgetError).code).toBe('already_finalized');
    }
  });

  test('commit-unknown-reservation throws reservation_not_found', async () => {
    const ledger = new BudgetLedger(engine);
    try {
      await ledger.commit('made-up-id', 1.0);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as BudgetError).code).toBe('reservation_not_found');
    }
  });

  test('reserve with invalid estimate throws', async () => {
    const ledger = new BudgetLedger(engine);
    try {
      await ledger.reserve({ resolverId: 'x', estimateUsd: -1 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as BudgetError).code).toBe('invalid_input');
    }
  });

  test('state returns null when no row exists yet', async () => {
    const ledger = new BudgetLedger(engine);
    const state = await ledger.state('default', 'never-called');
    expect(state).toBeNull();
  });

  test('scope isolation: different scopes have independent caps', async () => {
    const ledger = new BudgetLedger(engine);
    const a = await ledger.reserve({ scope: 'alice', resolverId: 'x', estimateUsd: 1.0, capUsd: 1.0 });
    const b = await ledger.reserve({ scope: 'bob',   resolverId: 'x', estimateUsd: 1.0, capUsd: 1.0 });
    expect(a.kind).toBe('held');
    expect(b.kind).toBe('held');
  });

  test('parallel reserves never exceed cap', async () => {
    const ledger = new BudgetLedger(engine);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.reserve({ resolverId: 'race', estimateUsd: 0.3, capUsd: 1.0 }),
      ),
    );
    const heldCount = results.filter(r => r.kind === 'held').length;
    // Cap 1.0, estimate 0.3 → at most 3 can hold simultaneously (0.9 <= 1.0)
    expect(heldCount).toBeLessThanOrEqual(3);
    expect(heldCount).toBeGreaterThanOrEqual(1);

    const state = await ledger.state('default', 'race');
    expect(state!.reservedUsd).toBeLessThanOrEqual(1.0);
  });

  test('cleanupExpired reclaims TTL-expired held reservations', async () => {
    const ledger = new BudgetLedger(engine);
    const r = await ledger.reserve({ resolverId: 'x', estimateUsd: 0.5, capUsd: 1.0, ttlSeconds: 0 });
    expect(r.kind).toBe('held');
    await new Promise(ok => setTimeout(ok, 50));

    const { reclaimed } = await ledger.cleanupExpired();
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    const state = await ledger.state('default', 'x');
    expect(state!.reservedUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CompletenessScorer
// ---------------------------------------------------------------------------

describe('CompletenessScorer — rubric weights', () => {
  test('all seven core rubrics have weights summing to 1', () => {
    for (const r of [personRubric, companyRubric, projectRubric, dealRubric, conceptRubric, sourceRubric, mediaRubric, defaultRubric]) {
      const sum = r.dimensions.reduce((acc, d) => acc + d.weight, 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(1e-6);
    }
  });

  test('getRubric returns default for unknown type', () => {
    const r = getRubric('civic' as 'civic');
    expect(r.entityType).toBe('default');
  });

  test('getRubric returns person rubric for person', () => {
    expect(getRubric('person').entityType).toBe('person');
  });
});

describe('scorePage — person', () => {
  test('empty person page scores very low', () => {
    const page: Page = {
      id: 1, slug: 'people/empty', type: 'person', title: 'Empty',
      compiled_truth: '', timeline: '',
      frontmatter: {},
      created_at: new Date(), updated_at: new Date(),
    };
    const s = scorePage(page);
    expect(s.score).toBeLessThan(0.3);
  });

  test('fully enriched person page scores high', () => {
    const page: Page = {
      id: 1, slug: 'people/alice', type: 'person', title: 'Alice',
      compiled_truth: `Alice is the CEO of Acme [Source: X/alice, 2026-04-18](https://x.com/alice/status/1).
She [founded](https://acme.com/about) Acme in 2023.
See also: [Acme](companies/acme.md), [Bob](people/bob.md), [Charlie](people/charlie.md).`,
      timeline: '- **2026-04-18** | Met Alice [Source: meeting, 2026-04-18]\n- **2026-03-15** | Event',
      frontmatter: {
        role: 'CEO',
        company: 'Acme',
        last_verified: new Date().toISOString(),
      },
      created_at: new Date(), updated_at: new Date(),
    };
    const s = scorePage(page);
    expect(s.score).toBeGreaterThan(0.8);
  });

  test('score exposes all 7 person dimension scores', () => {
    const page: Page = {
      id: 1, slug: 'people/x', type: 'person', title: 'X',
      compiled_truth: 'Some content here.',
      timeline: '',
      frontmatter: {},
      created_at: new Date(), updated_at: new Date(),
    };
    const s = scorePage(page);
    expect(Object.keys(s.dimensionScores)).toHaveLength(7);
  });

  test('has_role_and_company fires on role frontmatter', () => {
    const page: Page = {
      id: 1, slug: 'people/r', type: 'person', title: 'R',
      compiled_truth: '', timeline: '',
      frontmatter: { role: 'Engineer' },
      created_at: new Date(), updated_at: new Date(),
    };
    const s = scorePage(page);
    expect(s.dimensionScores.has_role_and_company).toBe(1);
  });
});

describe('scorePage — company / concept / source / media defaults', () => {
  test('company rubric scored', () => {
    const page: Page = {
      id: 1, slug: 'companies/acme', type: 'company', title: 'Acme',
      compiled_truth: 'Acme builds things [Source: web, 2026-04-18](https://acme.com).',
      timeline: '',
      frontmatter: { founders: ['Alice'], funding: '$5M' },
      created_at: new Date(), updated_at: new Date(),
    };
    const s = scorePage(page);
    expect(s.rubric).toBe('company');
    expect(s.dimensionScores.has_founders).toBe(1);
    expect(s.dimensionScores.has_funding).toBe(1);
  });

  test('default rubric used for unknown page type', () => {
    const page: Page = {
      id: 1, slug: 'civic/x', type: 'civic' as 'civic', title: 'Civic',
      compiled_truth: 'body content',
      timeline: '', frontmatter: {},
      created_at: new Date(), updated_at: new Date(),
    };
    const s = scorePage(page);
    expect(s.rubric).toBe('default');
  });

  test('recency_score decays with age', () => {
    const old: Page = {
      id: 1, slug: 'people/old', type: 'person', title: 'x',
      compiled_truth: '', timeline: '', frontmatter: {},
      created_at: new Date(2020, 0, 1), updated_at: new Date(2020, 0, 1),
    };
    const fresh: Page = {
      id: 2, slug: 'people/fresh', type: 'person', title: 'y',
      compiled_truth: '', timeline: '', frontmatter: {},
      created_at: new Date(), updated_at: new Date(),
    };
    const oldScore = scorePage(old);
    const freshScore = scorePage(fresh);
    expect(freshScore.dimensionScores.recency_score).toBeGreaterThan(oldScore.dimensionScores.recency_score);
  });

  test('non_redundancy penalizes repeated-line pages', () => {
    const repeated = Array.from({ length: 20 }, () => 'Same line repeated.').join('\n');
    const page: Page = {
      id: 1, slug: 'people/repetitive', type: 'person', title: 'x',
      compiled_truth: repeated, timeline: '', frontmatter: {},
      created_at: new Date(), updated_at: new Date(),
    };
    const s = scorePage(page);
    expect(s.dimensionScores.non_redundancy).toBeLessThan(0.2);
  });
});
