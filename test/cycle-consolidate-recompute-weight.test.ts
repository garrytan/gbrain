/**
 * Regression — pages whose takes are created by `consolidate` get their
 * emotional_weight recomputed in the SAME cycle, without sync/synthesize
 * ever touching the page.
 *
 * Bug shape (pre-fix): `recompute_emotional_weight` ran BEFORE `consolidate`
 * and its incremental mode unioned only (syncPagesAffected,
 * synthesizeWrittenSlugs). A page that gained an active take via
 * consolidate's facts→takes promotion — e.g. facts inserted by
 * conversation_facts_backfill, page never synced — kept emotional_weight=0
 * forever (doctor salience_health WARN), until a manual full walk via
 * `gbrain dream --phase recompute_emotional_weight`.
 *
 * Pins:
 *   - consolidate reports details.pages_affected (slugs that gained takes).
 *   - recompute_emotional_weight runs AFTER consolidate and unions those
 *     slugs into incremental mode (mode: 'incremental', not a full walk).
 *   - The take-receiving page's emotional_weight becomes > 0 same-cycle.
 *   - An untouched page is NOT recomputed (sentinel weight survives),
 *     proving the run stayed incremental.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle, ALL_PHASES } from '../src/core/cycle.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  // Pin embedding dims to 1536 so the raw fact inserts below are hermetic
  // against cross-file gateway state (same guard as
  // test/consolidate-valid-until.test.ts).
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-consolidate-ew-'));
  mkdirSync(join(brainDir, 'wiki'), { recursive: true });
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  resetGateway();
});

function unitVec(): string {
  const a = new Float32Array(1536);
  a[0] = 1.0;
  return '[' + Array.from(a).join(',') + ']';
}

async function seedPage(slug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title) VALUES ($1, 'company', 'Test') ON CONFLICT DO NOTHING`,
    [slug],
  );
}

async function insertFact(entitySlug: string, text: string, validFrom: Date): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, confidence, embedding, embedded_at)
     VALUES ('default', $1, $2, 'fact', 'test', $3::timestamptz, $4, $5::vector, $3::timestamptz)`,
    [entitySlug, text, validFrom.toISOString(), 0.9, unitVec()],
  );
}

describe('consolidate → recompute_emotional_weight same-cycle wiring', () => {
  test('recompute_emotional_weight is ordered after consolidate', () => {
    expect(ALL_PHASES.indexOf('recompute_emotional_weight'))
      .toBeGreaterThan(ALL_PHASES.indexOf('consolidate'));
  });

  test('page that gains a take via consolidate gets weight recomputed incrementally same-cycle', async () => {
    // Page that will receive a take from consolidate. Never synced, never
    // synthesized, no high-emotion tags — weight starts at the column
    // default of 0.
    const slug = 'companies/acme-consolidate-ew';
    await seedPage(slug);

    // Control page: untouched by anything this cycle. Sentinel weight lets
    // us detect an accidental full walk (which would reset it to 0).
    const controlSlug = 'companies/control-untouched';
    await seedPage(controlSlug);
    await engine.executeRaw(
      `UPDATE pages SET emotional_weight = 0.99 WHERE slug = $1`,
      [controlSlug],
    );

    // 3 identical-embedding unconsolidated facts, oldest > 24h old, so
    // consolidate's bucket gates pass and the cluster promotes to a take.
    const base = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await insertFact(slug, 'Acme raised a seed round', base);
    await insertFact(slug, 'Acme raised a seed round', new Date(base.getTime() + 60_000));
    await insertFact(slug, 'Acme raised a seed round', new Date(base.getTime() + 120_000));

    const report = await runCycle(engine, {
      brainDir,
      phases: ['consolidate', 'recompute_emotional_weight'],
    });
    expect(report.status).not.toBe('failed');

    // consolidate wrote a take and reported the page slug.
    const consolidate = report.phases.find(p => p.phase === 'consolidate');
    expect(consolidate).toBeDefined();
    expect(consolidate!.status).toBe('ok');
    expect(Number(consolidate!.details.takes_written)).toBeGreaterThanOrEqual(1);
    expect(consolidate!.details.pages_affected).toContain(slug);

    // recompute ran AFTER consolidate, incrementally over its slugs.
    const phaseOrder = report.phases.map(p => p.phase);
    expect(phaseOrder.indexOf('recompute_emotional_weight'))
      .toBeGreaterThan(phaseOrder.indexOf('consolidate'));
    const recompute = report.phases.find(p => p.phase === 'recompute_emotional_weight');
    expect(recompute).toBeDefined();
    expect(recompute!.status).toBe('ok');
    expect(recompute!.details.mode).toBe('incremental');
    expect(Number(recompute!.details.pages_recomputed)).toBeGreaterThanOrEqual(1);

    // The take-receiving page's weight is now non-zero: one active take →
    // density 0.1 + avg-weight 0.9×0.1 = 0.19 (holder 'self' ≠ user holder,
    // no high-emotion tags).
    const rows = await engine.executeRaw<{ emotional_weight: number }>(
      `SELECT emotional_weight FROM pages WHERE slug = $1`,
      [slug],
    );
    expect(Number(rows[0].emotional_weight)).toBeGreaterThan(0);

    // Incremental scope held: the untouched control page kept its sentinel.
    const control = await engine.executeRaw<{ emotional_weight: number }>(
      `SELECT emotional_weight FROM pages WHERE slug = $1`,
      [controlSlug],
    );
    expect(Number(control[0].emotional_weight)).toBeCloseTo(0.99, 5);
  });
});
