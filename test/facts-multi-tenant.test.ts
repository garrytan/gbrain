/**
 * v0.31 Phase 6 — per-source ACL coverage.
 *
 * Pins: every facts read filters WHERE source_id = $X. Two sources can
 * share the same entity_slug ("people/alice-example") and the recall surfaces
 * never bleed across.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Seed two non-default sources.
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('alpha', 'Alpha', '{}'::jsonb) ON CONFLICT DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('beta',  'Beta',  '{}'::jsonb) ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('cross-source isolation', () => {
  test('listFactsByEntity returns only the requested source', async () => {
    await engine.insertFact(
      { fact: 'alpha alice fact', kind: 'fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: 'alpha' },
    );
    await engine.insertFact(
      { fact: 'beta alice fact', kind: 'fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: 'beta' },
    );
    const alpha = await engine.listFactsByEntity('alpha', 'people/alice-example');
    const beta = await engine.listFactsByEntity('beta', 'people/alice-example');
    expect(alpha.every(r => r.source_id === 'alpha')).toBe(true);
    expect(beta.every(r => r.source_id === 'beta')).toBe(true);
    expect(alpha.find(r => r.fact === 'beta alice fact')).toBeUndefined();
    expect(beta.find(r => r.fact === 'alpha alice fact')).toBeUndefined();
  });

  test('listFactsSince scopes by source_id', async () => {
    const before = new Date(Date.now() - 1000);
    const inAlpha = await engine.listFactsSince('alpha', before);
    const inBeta = await engine.listFactsSince('beta', before);
    expect(inAlpha.every(r => r.source_id === 'alpha')).toBe(true);
    expect(inBeta.every(r => r.source_id === 'beta')).toBe(true);
  });

  test('listFactsBySession scopes by source_id', async () => {
    await engine.insertFact(
      { fact: 'alpha topic-X', kind: 'fact', source: 'test', source_session: 'topic-X' },
      { source_id: 'alpha' },
    );
    await engine.insertFact(
      { fact: 'beta topic-X', kind: 'fact', source: 'test', source_session: 'topic-X' },
      { source_id: 'beta' },
    );
    const alpha = await engine.listFactsBySession('alpha', 'topic-X');
    const beta = await engine.listFactsBySession('beta', 'topic-X');
    expect(alpha.length).toBe(1);
    expect(beta.length).toBe(1);
    expect(alpha[0].source_id).toBe('alpha');
    expect(beta[0].source_id).toBe('beta');
  });

  test('findCandidateDuplicates scopes by source_id', async () => {
    const candidates = await engine.findCandidateDuplicates('alpha', 'people/alice-example', 'x');
    expect(candidates.every(c => c.source_id === 'alpha')).toBe(true);
  });

  test('getFactsHealth scopes by source_id', async () => {
    const alphaHealth = await engine.getFactsHealth('alpha');
    const betaHealth = await engine.getFactsHealth('beta');
    expect(alphaHealth.source_id).toBe('alpha');
    expect(betaHealth.source_id).toBe('beta');
    // Both should have at least 1 active fact each (seeded above).
    expect(alphaHealth.total_active).toBeGreaterThanOrEqual(1);
    expect(betaHealth.total_active).toBeGreaterThanOrEqual(1);
  });

  test('CASCADE delete on sources cleans up facts', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('ephemeral', 'Eph', '{}'::jsonb)`);
    await engine.insertFact(
      { fact: 'will cascade', kind: 'fact', source: 'test' },
      { source_id: 'ephemeral' },
    );
    const before = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts WHERE source_id = 'ephemeral'`,
    );
    expect(Number(before[0].count)).toBeGreaterThan(0);
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'ephemeral'`);
    const after = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts WHERE source_id = 'ephemeral'`,
    );
    expect(Number(after[0].count)).toBe(0);
  });
});
