/**
 * v0.31 Phase 6 — facts_health output shape pinning.
 *
 * Pins the JSON shape for downstream consumers. Any field rename without
 * an explicit migration is a breaking change.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact(
    { fact: 'a', kind: 'fact', entity_slug: 'shape-test', source: 'test' },
    { source_id: 'default' },
  );
  await engine.insertFact(
    { fact: 'b', kind: 'preference', entity_slug: 'shape-test', source: 'test' },
    { source_id: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('FactsHealth shape', () => {
  test('every documented field is present + correctly typed', async () => {
    const h = await engine.getFactsHealth('default');
    // Required fields:
    expect(typeof h.source_id).toBe('string');
    expect(typeof h.total_active).toBe('number');
    expect(typeof h.total_today).toBe('number');
    expect(typeof h.total_week).toBe('number');
    expect(typeof h.total_expired).toBe('number');
    expect(typeof h.total_consolidated).toBe('number');
    expect(Array.isArray(h.top_entities)).toBe(true);
    // Optional fields (may be undefined; if present, types):
    if (h.drop_counter !== undefined) expect(typeof h.drop_counter).toBe('number');
    if (h.classifier_fail_counter !== undefined) expect(typeof h.classifier_fail_counter).toBe('number');
    if (h.p50_latency_ms !== undefined) expect(typeof h.p50_latency_ms).toBe('number');
    if (h.p99_latency_ms !== undefined) expect(typeof h.p99_latency_ms).toBe('number');
  });

  test('top_entities entries are { entity_slug, count }', async () => {
    const h = await engine.getFactsHealth('default');
    for (const e of h.top_entities) {
      expect(typeof e.entity_slug).toBe('string');
      expect(typeof e.count).toBe('number');
      expect(e.count).toBeGreaterThan(0);
    }
  });

  test('shape-test entity surfaces in top_entities for default source', async () => {
    const h = await engine.getFactsHealth('default');
    const found = h.top_entities.find(e => e.entity_slug === 'shape-test');
    expect(found).toBeDefined();
    expect(found!.count).toBeGreaterThanOrEqual(2);
  });

  test('totals are non-negative', async () => {
    const h = await engine.getFactsHealth('default');
    expect(h.total_active).toBeGreaterThanOrEqual(0);
    expect(h.total_today).toBeGreaterThanOrEqual(0);
    expect(h.total_week).toBeGreaterThanOrEqual(0);
    expect(h.total_expired).toBeGreaterThanOrEqual(0);
    expect(h.total_consolidated).toBeGreaterThanOrEqual(0);
  });
});
