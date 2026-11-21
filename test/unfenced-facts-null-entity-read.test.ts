/**
 * #10005: planUnfencedFacts must not transfer unfenceable NULL-entity rows on every sweep.
 * Protects: the unfenced read returns no row with a NULL entity_slug while skipped_no_entity and scanned still count them.
 * Fails when: the facts SELECT has no entity_slug filter and returns every NULL-entity row.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

let engine: BrainEngine;
let close: () => Promise<void>;
beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine()); });
afterAll(async () => { await close(); });

test('NULL-entity unfenced facts are counted, not read', async () => {
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
      VALUES ('default', NULL, $1, 'fact', 'world', 'sweep:corpus', '2026-01-01')`, [`Unattributed claim ${i}`]);
  }
  const returned: Array<{ entity_slug: string | null }> = [];
  const original = engine.executeRaw.bind(engine);
  (engine as { executeRaw: unknown }).executeRaw = async (sql: string, params?: unknown[]) => {
    const out = await original(sql, params as never) as Array<{ entity_slug?: string | null }>;
    if (/FROM facts f/.test(sql)) returned.push(...out as Array<{ entity_slug: string | null }>);
    return out;
  };
  let plan;
  try { plan = await planUnfencedFacts(engine, { sourceId: 'default' }); }
  finally { (engine as { executeRaw: unknown }).executeRaw = original; }
  expect(returned.filter(r => r.entity_slug === null).length).toBe(0);
  expect(plan.outcome.skipped_no_entity).toBe(3);
  expect(plan.outcome.scanned).toBe(3);
});
