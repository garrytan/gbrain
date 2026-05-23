/**
 * v0.40.3.0 — mode-switch UX (D3)
 *
 * Pure unit tests for the 3 exports:
 *   - summarizeTransition: 5-cell matrix + invalid fallthrough
 *   - probeWorkerAvailable: active / stale / never_seen branches via DI
 *   - buildReindexIdempotencyKey: content-stable invariance (codex D12 #1)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  summarizeTransition,
  probeWorkerAvailable,
  buildReindexIdempotencyKey,
  WORKER_STALE_THRESHOLD_MS,
} from '../src/core/search/mode-switch-ux.ts';

describe('summarizeTransition (5-cell matrix + invalid fallthrough)', () => {
  test('any → tokenmax: tokenmax_opt_in with reindex required', () => {
    const s = summarizeTransition('balanced', 'tokenmax');
    expect(s.kind).toBe('tokenmax_opt_in');
    expect(s.reindex_required).toBe(true);
    expect(s.reindex_command).toBe('gbrain reindex --markdown');
    expect(s.cost_estimate_per_query_cents).toBeGreaterThan(0);
    expect(s.callout_lines.some((l) => l.includes('tokenmax'))).toBe(true);
  });

  test('first-time any → tokenmax (null → tokenmax)', () => {
    const s = summarizeTransition(null, 'tokenmax');
    expect(s.kind).toBe('tokenmax_opt_in');
    expect(s.reindex_required).toBe(true);
  });

  test('balanced → conservative: narrowing, no reindex', () => {
    const s = summarizeTransition('balanced', 'conservative');
    expect(s.kind).toBe('narrowing');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines.some((l) => l.includes('conservative'))).toBe(true);
  });

  test('tokenmax → balanced: narrowing (lower narrowness wins)', () => {
    const s = summarizeTransition('tokenmax', 'balanced');
    expect(s.kind).toBe('narrowing');
    expect(s.reindex_required).toBe(false);
  });

  test('conservative → balanced: broadening, no reindex', () => {
    const s = summarizeTransition('conservative', 'balanced');
    expect(s.kind).toBe('broadening');
    expect(s.reindex_required).toBe(false);
  });

  test('first-time set (null → balanced): broadening', () => {
    const s = summarizeTransition(null, 'balanced');
    expect(s.kind).toBe('broadening');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines.some((l) => l.includes('First-time'))).toBe(true);
  });

  test('same → same: no_change with empty callout', () => {
    const s = summarizeTransition('balanced', 'balanced');
    expect(s.kind).toBe('no_change');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines).toEqual([]);
  });

  test('any → invalid: invalid_new_mode with valid-options hint', () => {
    const s = summarizeTransition('balanced', 'not-a-real-mode');
    expect(s.kind).toBe('invalid_new_mode');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines.some((l) => l.includes('conservative'))).toBe(true);
    expect(s.callout_lines.some((l) => l.includes('tokenmax'))).toBe(true);
  });
});

describe('probeWorkerAvailable (DI for active/stale/never_seen)', () => {
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

  test('never_seen when minion_jobs has no recent activity', async () => {
    const result = await probeWorkerAvailable(engine);
    expect(result.status).toBe('never_seen');
    expect(result.paste_ready_start_command).toBe('gbrain jobs work');
    expect(result.last_heartbeat_iso).toBeUndefined();
  });

  test('active when minion_jobs activity is fresh (<2 min)', async () => {
    // Seed a recently-started job.
    await engine.executeRaw(
      `INSERT INTO minion_jobs (queue, name, data, status, started_at)
       VALUES ('default', 'test-job', '{}'::jsonb, 'active', now())`,
    );
    const result = await probeWorkerAvailable(engine);
    expect(result.status).toBe('active');
    expect(result.last_heartbeat_iso).toBeDefined();
  });

  test('stale when activity is older than 2 min but within 10-min window', async () => {
    // Seed a 5-minute-old started_at (within 10-min query window, > 2-min stale).
    await engine.executeRaw(
      `INSERT INTO minion_jobs (queue, name, data, status, started_at)
       VALUES ('default', 'test-stale-job', '{}'::jsonb, 'completed',
               now() - INTERVAL '5 minutes')`,
    );
    const result = await probeWorkerAvailable(engine);
    expect(result.status).toBe('stale');
    expect(result.last_heartbeat_iso).toBeDefined();
  });

  test('threshold constant is 2 minutes (120_000 ms)', () => {
    expect(WORKER_STALE_THRESHOLD_MS).toBe(120_000);
  });
});

describe('buildReindexIdempotencyKey (codex D12 Bug 1 content-stable invariance)', () => {
  test('same inputs produce identical key', () => {
    const k1 = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    const k2 = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    expect(k1).toBe(k2);
  });

  test('key shape matches the canonical pattern', () => {
    const k = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    expect(k).toBe('cr-backfill:default:2:tokenmax');
  });

  test('different source_id produces different key', () => {
    const k1 = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    const k2 = buildReindexIdempotencyKey('other-source', 2, 'tokenmax');
    expect(k1).not.toBe(k2);
  });

  test('different chunker_version produces different key (re-chunk = new key)', () => {
    const k1 = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    const k2 = buildReindexIdempotencyKey('default', 3, 'tokenmax');
    expect(k1).not.toBe(k2);
  });

  test('different mode produces different key', () => {
    const k1 = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    const k2 = buildReindexIdempotencyKey('default', 2, 'balanced');
    expect(k1).not.toBe(k2);
  });

  test('NOT timestamp-based: two consecutive runs with same state produce same key', async () => {
    const k1 = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    await new Promise((r) => setTimeout(r, 10));
    const k2 = buildReindexIdempotencyKey('default', 2, 'tokenmax');
    expect(k1).toBe(k2);
  });
});
