/**
 * B-10 (#6948 sweep): re-keying a fact's entity or source slug collided on the
 * ontology stint index and rolled the whole write back.
 *
 * `idx_facts_ontology_stint_dedup` (v188) is UNIQUE on (source, entity_slug,
 * dimension, value_hash, source_markdown_slug, valid_from) for every ontology
 * row, expired or not. When an observation is recorded under two spellings of
 * one entity (people/a and a page-less variant people/a-x, the usual B-7
 * leftover), re-keying one onto the other (a page rename, the phantom
 * redirect's fact migration, or a facts relink) raised a raw 23505 and the
 * rename, redirect or relink transaction rolled back. Each writer now drops the
 * duplicate observation before it moves (keeping the active one, and the row
 * already at the target when both are active) and repoints any supersession
 * reference to the survivor.
 *
 * Real PGLite, plus the Postgres arm when DATABASE_URL is set
 * (test/postgres-unit-arms.txt). Placeholder names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { readFacts } from '../../src/core/persistence/prepared-maintenance.ts';
import { relinkFactHash, submitRelinkGroup } from '../../src/core/facts/relink-publish.ts';
import { pathologicalArms } from './harness.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';

const VALID_FROM = '2026-03-01T00:00:00Z';
const observe = (engine: BrainEngine, entitySlug: string, source: string) =>
  engine.mergeOntologyFact({ entitySlug, dimension: 'role', value: 'advisor', source, validFrom: VALID_FROM, visibility: 'world' });
const rows = (engine: BrainEngine) => engine.executeRaw<{ id: number; entity_slug: string | null; source_markdown_slug: string | null; expired_at: string | null }>(
  `SELECT id, entity_slug, source_markdown_slug, expired_at FROM facts WHERE source_id = 'default' AND dimension = 'role' ORDER BY id`);
const md = (title: string, type: string) => `---\ntitle: ${title}\ntype: ${type}\n---\n\n# ${title}\n`;

const arms = pathologicalArms();
const engines: Array<{ name: string; engine: BrainEngine; close: () => Promise<void> }> = [];
beforeAll(async () => {
  for (const arm of arms) {
    const { engine, close } = await isolatedSharedSkillsEngine(arm.databaseUrl);
    engines.push({ name: arm.backend, engine, close });
  }
}, 120_000);
afterAll(async () => { for (const e of engines) await e.close(); });

for (const { backend } of arms) {
  const engine = () => engines.find(e => e.name === backend)!.engine;
  describe(`B-10 re-keying a fact never collides on the ontology stint index (${backend})`, () => {
    beforeEach(async () => {
      await engine().executeRaw(`DELETE FROM facts WHERE source_id = 'default'`);
      await engine().executeRaw(`DELETE FROM pages WHERE source_id = 'default'`);
    });

    test('renaming people/a onto its page-less variant people/a-x succeeds with one active observation', async () => {
      await importFromContent(engine(), 'people/a', md('A Example', 'person'), { noEmbed: true });
      await observe(engine(), 'people/a', 'meetings/m-example');
      await observe(engine(), 'people/a-x', 'meetings/m-example');
      expect(await rows(engine())).toHaveLength(2);
      await engine().updateSlug('people/a', 'people/a-x');
      const after = await rows(engine());
      expect(after.filter(r => r.expired_at === null).map(r => r.entity_slug)).toEqual(['people/a-x']);
      expect(after.filter(r => r.entity_slug === 'people/a')).toEqual([]);
    });

    test('the active observation survives when the target only holds an expired copy, and supersession links follow it', async () => {
      await importFromContent(engine(), 'people/e', md('E Example', 'person'), { noEmbed: true });
      await observe(engine(), 'people/e', 'meetings/m-example');
      await observe(engine(), 'people/e-x', 'meetings/m-example');
      const [moving, target] = (await rows(engine())).map(r => Number(r.id));
      await engine().executeRaw(`UPDATE facts SET expired_at = now() WHERE id = $1`, [target]);
      await observe(engine(), 'people/f', 'meetings/m-example');
      await engine().executeRaw(`UPDATE facts SET superseded_by = $1 WHERE entity_slug = 'people/f'`, [target]);
      await engine().updateSlug('people/e', 'people/e-x');
      const after = await rows(engine());
      expect(after.filter(r => r.entity_slug === 'people/e-x').map(r => [Number(r.id), r.expired_at])).toEqual([[moving, null]]);
      const [{ superseded_by }] = await engine().executeRaw<{ superseded_by: number | string }>(`SELECT superseded_by FROM facts WHERE entity_slug = 'people/f'`);
      expect(Number(superseded_by)).toBe(moving);
    });

    test('renaming the source page of two identical observations keeps one', async () => {
      await importFromContent(engine(), 'meetings/m-old', md('Meeting Example', 'meeting'), { noEmbed: true });
      await observe(engine(), 'people/b', 'meetings/m-old');
      await observe(engine(), 'people/b', 'meetings/m-new');
      await engine().updateSlug('meetings/m-old', 'meetings/m-new');
      const after = await rows(engine());
      expect(after.filter(r => r.expired_at === null).map(r => [r.entity_slug, r.source_markdown_slug])).toEqual([['people/b', 'meetings/m-new']]);
      expect(after.filter(r => r.source_markdown_slug === 'meetings/m-old')).toEqual([]);
    });

    test('the phantom redirect migrates an observation the canonical page already holds', async () => {
      await observe(engine(), 'people/c-example', 'people/c-example');
      await observe(engine(), 'people/c', 'people/c');
      await engine().executeRaw(`UPDATE facts SET entity_slug = 'people/c-example' WHERE entity_slug = 'people/c'`);
      const { migrated } = await engine().migrateFactsToCanonical('people/c', 'people/c-example', 'default');
      expect(migrated).toBe(0);
      const after = await rows(engine());
      expect(after.filter(r => r.expired_at === null).map(r => [r.entity_slug, r.source_markdown_slug])).toEqual([['people/c-example', 'people/c-example']]);
    });

    test('relinking an unlinked observation the entity page already holds retires it as a duplicate', async () => {
      await importFromContent(engine(), 'people/d-example', md('D Example', 'person'), { noEmbed: true });
      await observe(engine(), 'people/d-example', 'people/d-example');
      const [{ id }] = await engine().executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash,
          dim_status, confidence, source, source_markdown_slug, valid_from)
        SELECT source_id, NULL, 'D Example is an advisor', kind, visibility, dimension, value, value_hash, dim_status, confidence, 'chat 2026-10-01', NULL, valid_from
          FROM facts WHERE entity_slug = 'people/d-example' RETURNING id`);
      const [snap] = await readFacts(engine(), 'default', [Number(id)]);
      const result = await submitRelinkGroup(engine(), { engine: backend } as never, 'default', 'people/d-example', {
        kind: 'relink_facts', run_id: 'b10', queue_conflict: false, facts: [{ id: Number(id), hash: relinkFactHash(snap!), tier: 'mention', model: null, note: 'entity relinked from mention' }],
      });
      expect(result.ok).toBe(true);
      const after = await rows(engine());
      expect(after.filter(r => r.expired_at === null && r.entity_slug === 'people/d-example')).toHaveLength(1);
      expect(after.find(r => Number(r.id) === Number(id))?.expired_at).not.toBeNull();
    });
  });
}
