/**
 * v0.29 E2E — recompute_emotional_weight cycle phase wiring against PGLite.
 *
 * Asserts:
 *   - Phase appears in ALL_PHASES and runs as part of a default cycle.
 *   - Full mode (no incremental anchors) walks every page in the brain.
 *   - Selectable via `--phase recompute_emotional_weight` (single phase run).
 *   - dry-run skips the UPDATE but still reports the would-write count.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runCycle, ALL_PHASES } from '../../src/core/cycle.ts';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Brain dir for filesystem phases (lint/backlinks/sync). They'll skip
  // gracefully when there's nothing to read.
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-test-'));
  mkdirSync(join(brainDir, 'wiki'), { recursive: true });

  // Seed two pages: one with a high-emotion tag, one without.
  await engine.putPage('personal/wedding/photos', {
    type: 'note',
    title: 'Wedding photos',
    compiled_truth: 'Some wedding photos.',
  });
  await engine.addTag('personal/wedding/photos', 'wedding');

  await engine.putPage('notes/random', {
    type: 'note',
    title: 'Random note',
    compiled_truth: 'Just a note.',
  });
  await engine.addTag('notes/random', 'product');
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
});

describe('v0.29 — recompute_emotional_weight phase is registered', () => {
  test('appears in ALL_PHASES between patterns and embed', () => {
    const idx = ALL_PHASES.indexOf('recompute_emotional_weight');
    const patternsIdx = ALL_PHASES.indexOf('patterns');
    const embedIdx = ALL_PHASES.indexOf('embed');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(patternsIdx);
    expect(idx).toBeLessThan(embedIdx);
  });
});

describe('v0.29 — recompute_emotional_weight phase runs end-to-end', () => {
  test('--phase recompute_emotional_weight populates the column for every page (full mode)', async () => {
    const report = await runCycle(engine, {
      brainDir,
      phases: ['recompute_emotional_weight'],
    });
    expect(report.status).not.toBe('failed');
    const phaseResult = report.phases.find(p => p.phase === 'recompute_emotional_weight');
    expect(phaseResult).toBeDefined();
    expect(phaseResult!.status).toBe('ok');
    expect(phaseResult!.details.mode).toBe('full');
    expect(Number(phaseResult!.details.pages_recomputed)).toBeGreaterThanOrEqual(2);

    // Verify both pages got their weights populated.
    const wedding = await engine.executeRaw<{ emotional_weight: number }>(
      `SELECT emotional_weight FROM pages WHERE slug = 'personal/wedding/photos'`
    );
    const random = await engine.executeRaw<{ emotional_weight: number }>(
      `SELECT emotional_weight FROM pages WHERE slug = 'notes/random'`
    );
    expect(Number(wedding[0].emotional_weight)).toBeCloseTo(0.5, 5);
    expect(Number(random[0].emotional_weight)).toBe(0);

    // Totals roll up the new field.
    expect(report.totals.pages_emotional_weight_recomputed).toBeGreaterThanOrEqual(2);
  });

  test('dry-run skips the UPDATE but reports a would-write count', async () => {
    // Reset weights to a sentinel so we can detect a write.
    await engine.executeRaw(`UPDATE pages SET emotional_weight = 0.99`);

    const report = await runCycle(engine, {
      brainDir,
      phases: ['recompute_emotional_weight'],
      dryRun: true,
    });
    const phaseResult = report.phases.find(p => p.phase === 'recompute_emotional_weight');
    expect(phaseResult).toBeDefined();
    expect(phaseResult!.status).toBe('ok');
    expect(phaseResult!.details.dry_run).toBe(true);
    expect(Number(phaseResult!.details.pages_recomputed)).toBeGreaterThanOrEqual(2);

    // Sentinel survives because dry-run never writes.
    const after = await engine.executeRaw<{ emotional_weight: number }>(
      `SELECT emotional_weight FROM pages WHERE slug = 'personal/wedding/photos'`
    );
    expect(Number(after[0].emotional_weight)).toBeCloseTo(0.99, 5);
  });
});
