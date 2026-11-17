/**
 * BrainEngine parity — config + stats/ingest families.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: config reads/writes, brain stats/health counters and the
 *    ingest log return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine that drifts on config upsert/unset/prefix-listing
 *    (LIKE escaping), on counter arithmetic in getStats/getHealth, or on
 *    ingest-log scoping — the surfaces `gbrain stats`, `doctor` and every
 *    config-driven feature read.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and does not exercise config or ingest log;
 *    per-engine unit tests never compare two engines on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    A fresh brain already holds config rows from initSchema, so config
 *    cases compare only keys under a prefix the scenario owns.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWN = 'parity.cfg.';

describe('engine parity: config', () => {
  parityTest(
    'setConfig upserts and getConfig reads back; missing keys are null',
    { methods: ['setConfig', 'getConfig'] },
    async (engine) => {
      const before = await engine.getConfig(`${OWN}alpha`);
      await engine.setConfig(`${OWN}alpha`, 'one');
      const first = await engine.getConfig(`${OWN}alpha`);
      await engine.setConfig(`${OWN}alpha`, 'two');
      const second = await engine.getConfig(`${OWN}alpha`);
      await engine.setConfig(`${OWN}empty`, '');
      const empty = await engine.getConfig(`${OWN}empty`);
      await engine.setConfig(`${OWN}json`, JSON.stringify({ a: [1, 2], b: 'x' }));
      const json = await engine.getConfig(`${OWN}json`);
      expect(before).toBeNull();
      expect(first).toBe('one');
      expect(second).toBe('two');
      expect(JSON.parse(json!)).toEqual({ a: [1, 2], b: 'x' });
      return { before, first, second, empty, json, missing: await engine.getConfig(`${OWN}missing`) };
    },
  );

  parityTest(
    'unsetConfig returns the deleted row count and is a no-op for a missing key',
    { methods: ['setConfig', 'getConfig', 'unsetConfig'] },
    async (engine) => {
      await engine.setConfig(`${OWN}gone`, 'x');
      const removed = await engine.unsetConfig(`${OWN}gone`);
      const removedAgain = await engine.unsetConfig(`${OWN}gone`);
      const never = await engine.unsetConfig(`${OWN}never-set`);
      expect(removed).toBe(1);
      expect(removedAgain).toBe(0);
      return { removed, removedAgain, never, after: await engine.getConfig(`${OWN}gone`) };
    },
  );

  parityTest(
    'listConfigKeys matches a literal prefix, sorted, and escapes LIKE wildcards',
    { methods: ['setConfig', 'listConfigKeys'] },
    async (engine) => {
      for (const key of ['pfx.a.one', 'pfx.a.two', 'pfx.b.one', 'pfxXa.one', 'pf_x.one', 'pf%x.one', 'other.key']) {
        await engine.setConfig(key, 'v');
      }
      const a = await engine.listConfigKeys('pfx.a.');
      const all = await engine.listConfigKeys('pfx');
      const underscore = await engine.listConfigKeys('pf_');
      const percent = await engine.listConfigKeys('pf%');
      const none = await engine.listConfigKeys('nothing-here-');
      expect(a).toEqual(['pfx.a.one', 'pfx.a.two']);
      expect(underscore).toEqual(['pf_x.one']);
      expect(percent).toEqual(['pf%x.one']);
      expect(none).toEqual([]);
      return { a, all, underscore, percent, none };
    },
  );

  parityTest(
    'getAllConfig returns every row as a key->value map reflecting set and unset',
    { methods: ['setConfig', 'unsetConfig', 'getAllConfig', 'listConfigKeys'] },
    async (engine) => {
      await engine.setConfig(`${OWN}x`, '1');
      await engine.setConfig(`${OWN}y`, '2');
      await engine.setConfig(`${OWN}z`, '3');
      await engine.unsetConfig(`${OWN}y`);
      const everything = await engine.getAllConfig();
      const owned = Object.fromEntries(Object.entries(everything).filter(([k]) => k.startsWith(OWN)).sort(([a], [b]) => (a < b ? -1 : 1)));
      expect(owned).toEqual({ [`${OWN}x`]: '1', [`${OWN}z`]: '3' });
      // The map and the prefix listing agree about the whole key set.
      const listed = await engine.listConfigKeys('');
      expect(sorted(Object.keys(everything))).toEqual(sorted(listed));
      return { owned };
    },
  );
});

describe('engine parity: stats + ingest log', () => {
  parityTest(
    'getStats counts pages, chunks, embeddings, links, tags and timeline entries',
    { methods: ['putPage', 'upsertChunks', 'addLink', 'addTag', 'addTimelineEntry', 'getStats'] },
    async (engine) => {
      const empty = await engine.getStats();
      await engine.putPage('people/stats-alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice at acme.', timeline: '' });
      await engine.putPage('companies/stats-acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme makes widgets.', timeline: '' });
      await engine.putPage('notes/stats-note', { type: 'note', title: 'Note', compiled_truth: 'A plain note.', timeline: '' });
      await engine.upsertChunks('people/stats-alice', [
        { chunk_index: 0, chunk_text: 'Alice at acme.', chunk_source: 'compiled_truth', embedding: basisEmbedding(1) },
        { chunk_index: 1, chunk_text: 'Alice timeline.', chunk_source: 'timeline' },
      ]);
      await engine.upsertChunks('companies/stats-acme', [
        { chunk_index: 0, chunk_text: 'Acme makes widgets.', chunk_source: 'compiled_truth', embedding: basisEmbedding(2) },
      ]);
      await engine.addLink('people/stats-alice', 'companies/stats-acme', 'works at', 'works_at');
      await engine.addTag('people/stats-alice', 'founder');
      await engine.addTag('people/stats-alice', 'advisor');
      await engine.addTag('companies/stats-acme', 'founder');
      await engine.addTimelineEntry('people/stats-alice', { date: '2026-01-02', summary: 'Joined acme', detail: '' });
      const stats = await engine.getStats();
      expect(empty.page_count).toBe(0);
      expect(stats.page_count).toBe(3);
      expect(stats.chunk_count).toBe(3);
      expect(stats.embedded_count).toBe(2);
      expect(stats.link_count).toBe(1);
      expect(stats.tag_count).toBe(2); // distinct tags
      expect(stats.timeline_entry_count).toBe(1);
      expect(stats.pages_by_type).toEqual({ person: 1, company: 1, note: 1 });
      return { empty, stats };
    },
  );

  parityTest(
    'getStats and getHealth confine to a source scope',
    { methods: ['putPage', 'upsertChunks', 'getStats', 'getHealth'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'stats-other');
      await engine.putPage('people/scope-a', { type: 'person', title: 'A', compiled_truth: 'A.', timeline: '' });
      await engine.putPage('people/scope-b', { type: 'person', title: 'B', compiled_truth: 'B.', timeline: '' }, { sourceId: 'stats-other' });
      await engine.putPage('notes/scope-c', { type: 'note', title: 'C', compiled_truth: 'C.', timeline: '' }, { sourceId: 'stats-other' });
      await engine.upsertChunks('notes/scope-c', [
        { chunk_index: 0, chunk_text: 'C.', chunk_source: 'compiled_truth', embedding: basisEmbedding(3) },
      ], { sourceId: 'stats-other' });
      const whole = await engine.getStats();
      const def = await engine.getStats({ sourceId: 'default' });
      const other = await engine.getStats({ sourceId: 'stats-other' });
      const both = await engine.getStats({ sourceIds: ['default', 'stats-other'] });
      const healthDefault = await engine.getHealth({ sourceId: 'default' });
      const healthOther = await engine.getHealth({ sourceId: 'stats-other' });
      expect(whole.page_count).toBe(3);
      expect(def.page_count).toBe(1);
      expect(other.page_count).toBe(2);
      expect(both.page_count).toBe(3);
      expect(other.embedded_count).toBe(1);
      expect(healthDefault.page_count).toBe(1);
      expect(healthOther.page_count).toBe(2);
      const healthKeys = ['page_count', 'embed_coverage', 'missing_embeddings', 'orphan_pages', 'dead_links', 'entity_page_count'] as const;
      return {
        whole, def, other, both,
        healthDefault: pick(healthDefault, healthKeys),
        healthOther: pick(healthOther, healthKeys),
      };
    },
  );

  parityTest(
    'getHealth reports coverage, orphans, missing embeddings and the score parts',
    { methods: ['putPage', 'upsertChunks', 'addLink', 'getHealth'] },
    async (engine) => {
      const empty = await engine.getHealth();
      await engine.putPage('people/health-alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.', timeline: '' });
      await engine.putPage('companies/health-acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme.', timeline: '' });
      await engine.putPage('people/health-loner', { type: 'person', title: 'Loner', compiled_truth: 'Alone.', timeline: '' });
      await engine.upsertChunks('people/health-alice', [
        { chunk_index: 0, chunk_text: 'Alice.', chunk_source: 'compiled_truth', embedding: basisEmbedding(4) },
      ]);
      await engine.upsertChunks('companies/health-acme', [
        { chunk_index: 0, chunk_text: 'Acme.', chunk_source: 'compiled_truth' },
      ]);
      await engine.addLink('people/health-alice', 'companies/health-acme', '', 'works_at');
      const health = await engine.getHealth();
      expect(health.page_count).toBe(3);
      expect(health.missing_embeddings).toBe(1);
      expect(health.orphan_pages).toBe(1);
      expect(health.dead_links).toBe(0);
      const keys = [
        'page_count', 'linkable_page_count', 'embed_coverage', 'stale_pages', 'orphan_pages', 'missing_embeddings',
        'brain_score', 'dead_links', 'entity_page_count', 'entity_types_status', 'link_coverage', 'timeline_coverage',
        'embed_coverage_score', 'link_density_score', 'timeline_coverage_score', 'no_orphans_score', 'no_dead_links_score',
      ] as const;
      return {
        empty: pick(empty, ['page_count', 'missing_embeddings', 'orphan_pages', 'dead_links'] as const),
        health: pick(health, keys),
        mostConnected: sorted(health.most_connected.map((m) => `${m.slug}:${m.link_count}`)),
      };
    },
  );

  parityTest(
    'logIngest then getIngestLog returns entries newest-first with a limit and source scope',
    { methods: ['logIngest', 'getIngestLog'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'ingest-other');
      const empty = await engine.getIngestLog();
      await engine.logIngest({ source_type: 'markdown', source_ref: 'a.md', pages_updated: ['people/a', 'people/b'], summary: 'first' });
      await engine.logIngest({ source_id: 'ingest-other', source_type: 'git', source_ref: 'repo@1', pages_updated: [], summary: 'second' });
      await engine.logIngest({ source_type: 'markdown', source_ref: 'c.md', pages_updated: ['notes/c'], summary: 'third' });
      const view = (e: { source_id: string; source_type: string; source_ref: string; pages_updated: string[]; summary: string; created_at: Date }) =>
        pick(e, ['source_id', 'source_type', 'source_ref', 'pages_updated', 'summary', 'created_at'] as const);
      const all = await engine.getIngestLog();
      const limited = await engine.getIngestLog({ limit: 2 });
      const scopedDefault = await engine.getIngestLog({ sourceIds: ['default'] });
      const scopedOther = await engine.getIngestLog({ sourceIds: ['ingest-other'] });
      expect(empty).toEqual([]);
      expect(all).toHaveLength(3);
      expect(limited).toHaveLength(2);
      expect(scopedDefault.map((e) => e.summary).sort()).toEqual(['first', 'third']);
      expect(scopedOther.map((e) => e.summary)).toEqual(['second']);
      return {
        // created_at ties inside one transaction-less burst are not ordered by contract: compare as sets.
        all: sorted(all.map(view), (e) => e.summary),
        limitedCount: limited.length,
        scopedDefault: sorted(scopedDefault.map(view), (e) => e.summary),
        scopedOther: scopedOther.map(view),
      };
    },
  );
});
