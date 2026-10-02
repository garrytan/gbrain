/**
 * Wave-3 connector follow-up #1 (small version): `reconcilePolicyDigest`
 * hashed the raw `sources.config`, which every successful source cycle
 * stamps with `last_source_cycle_at` / `last_full_cycle_at`. An autopilot
 * cycle between `gbrain sources reconcile` preview and apply therefore made
 * the preview stale ("Reconciliation preview is stale: policy_digest"). The
 * stamps are excluded now; real policy changes still move the digest.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { reconcilePolicyDigest } from '../src/core/persistence/reconcile-state.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('notes', 'Notes', '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

describe('reconcilePolicyDigest ignores cycle stamps', () => {
  test('a cycle stamp leaves the digest unchanged', async () => {
    const before = await reconcilePolicyDigest(engine, 'notes');
    await engine.updateSourceConfig('notes', { last_source_cycle_at: '2026-10-01T10:00:00.000Z', last_full_cycle_at: '2026-10-01T10:00:00.000Z' });
    expect(await reconcilePolicyDigest(engine, 'notes')).toBe(before);
    await engine.updateSourceConfig('notes', { last_source_cycle_at: '2026-10-01T11:00:00.000Z', last_full_cycle_at: '2026-10-01T11:00:00.000Z' });
    expect(await reconcilePolicyDigest(engine, 'notes')).toBe(before);
  });

  test('a policy change still changes the digest', async () => {
    const before = await reconcilePolicyDigest(engine, 'notes');
    await engine.updateSourceConfig('notes', { federated: false });
    expect(await reconcilePolicyDigest(engine, 'notes')).not.toBe(before);
    const afterConfig = await reconcilePolicyDigest(engine, 'notes');
    await engine.executeRaw(`UPDATE sources SET trust_frontmatter_overrides = NOT COALESCE(trust_frontmatter_overrides, false) WHERE id = 'notes'`);
    expect(await reconcilePolicyDigest(engine, 'notes')).not.toBe(afterConfig);
  });
});
