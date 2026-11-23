/**
 * GST-3490 (#10005): the maintenance sweep's unfenced-facts read transfers only rows it can fence.
 *
 * Protects: `planUnfencedFacts` (run by every `gbrain serve` maintenance sweep
 * through extract_facts) returns no fact row whose entity is NULL, whose entity
 * has no live page, or whose source the plan skips as a whole, while its outcome
 * counters (`scanned`, `skipped_no_entity`, `skipped_no_page`,
 * `skipped_no_local_path`) stay what they were when every row was read.
 * Fails when: the read selects every unfenced active row of the source and
 * skips the unfenceable ones in a loop, so each sweep of each serve process
 * transfers rows that can never be fenced and come back on the next sweep.
 * Why new: the unfenced-rows tests check what gets fenced, never what was read.
 * Seams: real PGLite (and Postgres through the e2e registration); `executeRaw`
 * is wrapped only to count the fact rows each query returns.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

let engine: BrainEngine;

async function fact(sourceId: string, entity: string | null, text: string) {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from) VALUES ($1, $2, $3, 'fact', 'world', 'sweep:corpus', '2026-01-01')`,
    [sourceId, entity, text],
  );
}

/** Rows with no live page, plus the page whose fence the backend keeps for its file host or holds as unbound. */
function noPageOrHeld(outcome: { skipped_no_page: number; unbound_refused: Array<{ rows: number }> }): number {
  return outcome.skipped_no_page + outcome.unbound_refused.reduce((n, page) => n + page.rows, 0);
}

async function plannedReads(sourceId?: string) {
  const returned: Array<{ entity_slug: string | null; source_id: string }> = [];
  const original = engine.executeRaw.bind(engine);
  (engine as { executeRaw: unknown }).executeRaw = async (sql: string, params?: unknown[]) => {
    const out = await original(sql, params as never) as Array<Record<string, unknown>>;
    for (const row of out) if ('fact' in row) returned.push(row as never);
    return out;
  };
  try {
    const plan = await planUnfencedFacts(engine, sourceId === undefined ? {} : { sourceId });
    return { plan, returned };
  } finally {
    (engine as { executeRaw: unknown }).executeRaw = original;
  }
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`unfenced-facts sweep read (${backend})`, () => {
    let close: () => Promise<void>;
    let dir: string;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      dir = mkdtempSync(join(tmpdir(), 'gst3490-'));
    });
    afterAll(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
    test('only fenceable unfenced rows are read; the skip counters are unchanged', async () => {
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [dir]);
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('source-b', 'source-b', NULL) ON CONFLICT (id) DO NOTHING`);
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example.', timeline: '' });
      for (let i = 0; i < 6; i++) await fact('default', null, `Unattributed claim ${i}`);
      for (let i = 0; i < 4; i++) await fact('default', 'people/nobody-example', `Claim about a page that does not exist ${i}`);
      for (let i = 0; i < 2; i++) await fact('default', 'people/alice-example', `Alice Example claim ${i}`);
      for (let i = 0; i < 3; i++) await fact('source-b', 'people/alice-example', `Claim in a source with no checkout ${i}`);
      for (let i = 0; i < 2; i++) await fact('source-b', null, `Unattributed claim in source-b ${i}`);

      const one = await plannedReads('default');
      expect(one.returned.filter(r => r.entity_slug === null)).toHaveLength(0);
      expect(one.returned.filter(r => r.entity_slug === 'people/nobody-example')).toHaveLength(0);
      expect(one.returned.map(r => r.entity_slug)).toEqual(['people/alice-example', 'people/alice-example']);
      expect(one.plan.outcome).toMatchObject({ scanned: 12, skipped_no_entity: 6, skipped_no_local_path: 0 });
      expect(noPageOrHeld(one.plan.outcome)).toBe(6);

      const all = await plannedReads();
      expect(all.returned.filter(r => r.source_id === 'source-b')).toHaveLength(0);
      expect(all.returned).toHaveLength(2);
      expect(all.plan.outcome).toMatchObject({ scanned: 17, skipped_no_entity: 8, skipped_no_local_path: 3 });
      expect(noPageOrHeld(all.plan.outcome)).toBe(6);
    });
  });
}
