/**
 * BrainEngine parity — `gbrain migrate --to pglite` from every source engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a brain seeded through typed members and migrated to a new PGLite brain gives the same target rows
 *    (sources, pages and their provenance columns, tags, timeline, raw data, links, manual dated link statements,
 *    facts, open loops, config) whichever engine the source brain ran on: PGLite always, Postgres with DATABASE_URL,
 *    the Rust engine with GBRAIN_TEST_RUST_ARM=1.
 *  - Regression: `runMigrateEngine` read the source brain through `executeRaw`, which a Rust brain refuses, so a Rust
 *    brain could not leave its engine; each source read is now a typed member every engine answers.
 *  - Why existing coverage misses it: the migrate tests (test/migrate-engine-*.test.ts) seed a PGLite source only, and
 *    no parity case ran the copy with a non-SQL source.
 *  - Seam: none on the source; the target is always a PGLite brain on disk, read back with SQL. Generated values (ids,
 *    timestamps) are compared by relation or presence, never by value.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { runMigrateEngine } from '../../src/commands/migrate-engine.ts';
import { loadConfigFileOnly, saveConfig } from '../../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { writeManualTransitions } from '../../src/core/link-temporal-apply.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = 'people/alice-example';
const CO = 'companies/acme-example';
const SIDE = 'side';
const SIDE_CONFIG = { federated: false, note: 'side source', webhook_secret: 'whsec-example', sync: { cadence: '1h', include: ['a', 'b'] } };

/** Seed the source brain through typed members only. */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  // A secret and nested keys: the copy hands over the whole stored config on every engine, not a redacted subset.
  await createSource(engine, backend, SIDE, SIDE_CONFIG, '/var/tmp/migrate-side');
  await engine.putPage(CO, { type: 'company', title: 'Acme', compiled_truth: 'Acme makes widgets.', timeline: '', frontmatter: { stage: 'seed' } });
  await engine.putPage(NOTE, {
    type: 'person', title: 'Alice', compiled_truth: 'Alice advises [[companies/acme-example]].', timeline: '- 2024-01-02: met',
    frontmatter: { role: 'advisor', aliases: ['Alice E'] }, source_path: 'people/alice-example.md', effective_date: new Date('2024-01-02T00:00:00Z'),
    effective_date_source: 'date', import_filename: 'alice-example', source_kind: 'markdown', source_uri: 'file:///people/alice-example.md', ingested_via: 'import',
  });
  await engine.putPage('notes/side-only', { type: 'note', title: 'Side', compiled_truth: 'Only in the side source.', timeline: '', frontmatter: {} }, { sourceId: SIDE });
  await engine.addTag(NOTE, 'advisor');
  await engine.addTag(NOTE, 'people');
  await engine.addTimelineEntry(NOTE, { date: '2024-01-02', source: 'meeting', summary: 'First meeting', detail: 'Coffee' });
  await engine.putRawData(NOTE, 'enrich', { score: 3, tags: ['a', 'b'] });
  await engine.addLink(NOTE, CO, 'advises Acme', 'advises', 'manual');
  await writeManualTransitions(engine, { from: NOTE, to: CO, linkType: 'advises', sourceId: 'default' }, { validFrom: '2020-01-01', validUntil: '2022-06-30' });
  const first = await engine.insertFact({ fact: 'Alice prefers async standups', kind: 'preference', entity_slug: NOTE, source: 'mcp:remember' }, { source_id: 'default' });
  await engine.insertFact({ fact: 'Alice prefers written standups', kind: 'preference', entity_slug: NOTE, source: 'mcp:remember' }, { source_id: 'default', supersedeId: first.id });
  await engine.insertFact({ fact: 'Side fact', entity_slug: 'notes/side-only', source: 'cli:think' }, { source_id: SIDE });
  await engine.upsertOpenLoop({
    sourceId: 'default', dedupKey: 'thread:a', loopType: 'unanswered_inbound', counterpartyEmail: 'a@example.com', summary: 'Reply to Alice',
    evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: 't-a', detector: 'deterministic_thread', lastActivityAt: '2026-01-02T00:00:00Z', openedAt: '2026-01-01T00:00:00Z',
  });
  await engine.setConfig('migtest.repo_path', '/var/tmp/migrate-repo');
  await engine.setConfig('migtest.flag', 'true');
}

/** The target brain's rows the copy owns, with generated values reduced to relations. */
async function dumpTarget(path: string) {
  // The factory migrate itself opens the target with; the finally below closes it, so no engine outlives the dump.
  const target = await createEngine({ engine: 'pglite', database_path: path });
  await target.connect({ engine: 'pglite', database_path: path });
  try {
    const q = <T,>(sql: string) => target.executeRaw<T>(sql);
    return {
      sources: await q(`SELECT id, name, local_path, last_commit, config, archived, archived_at IS NOT NULL AS has_archived_at,
          contextual_retrieval_mode, trust_frontmatter_overrides FROM sources ORDER BY id COLLATE "C"`),
      pages: await q(`SELECT source_id, slug, type, title, compiled_truth, timeline, frontmatter, page_kind, source_path,
          effective_date::date::text AS effective_date, effective_date_source, import_filename, source_kind, source_uri, ingested_via,
          deleted_at IS NULL AS live FROM pages ORDER BY source_id COLLATE "C", slug COLLATE "C"`),
      tags: await q(`SELECT p.slug, t.tag FROM tags t JOIN pages p ON p.id = t.page_id ORDER BY p.slug COLLATE "C", t.tag COLLATE "C"`),
      timeline: await q(`SELECT p.slug, te.date::text AS date, te.source, te.summary, te.detail FROM timeline_entries te JOIN pages p ON p.id = te.page_id
          ORDER BY p.slug COLLATE "C", te.date, te.summary COLLATE "C"`),
      raw: await q(`SELECT p.slug, r.source, r.data FROM raw_data r JOIN pages p ON p.id = r.page_id ORDER BY p.slug COLLATE "C", r.source COLLATE "C"`),
      links: await q(`SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.context FROM links l JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id ORDER BY f.slug COLLATE "C", t.slug COLLATE "C", l.link_type COLLATE "C"`),
      transitions: await q(`SELECT f.slug AS from_slug, t.slug AS to_slug, lt.link_type, lt.kind, lt.occurred_on::date::text AS occurred_on, lt.producer
          FROM link_transitions lt JOIN pages f ON f.id = lt.from_page_id JOIN pages t ON t.id = lt.to_page_id WHERE lt.producer = 'manual'
          ORDER BY lt.kind COLLATE "C"`),
      facts: await q(`SELECT f.source_id, f.fact, f.kind, f.entity_slug, f.source, f.visibility, n.fact AS superseded_by_fact
          FROM facts f LEFT JOIN facts n ON n.id = f.superseded_by ORDER BY f.fact COLLATE "C"`),
      openLoops: await q(`SELECT source_id, dedup_key, loop_type, counterparty_email, summary, evidence::text AS evidence, thread_id, status, detector,
          opened_at::text AS opened_at FROM open_loops ORDER BY dedup_key COLLATE "C"`),
      suppressions: await q(`SELECT count(*)::int AS n FROM loop_suppressions`),
      config: await q(`SELECT key, value FROM config WHERE key LIKE 'migtest.%' ORDER BY key COLLATE "C"`),
      chunks: await q(`SELECT p.slug, count(c.*)::int AS n FROM pages p LEFT JOIN content_chunks c ON c.page_id = p.id GROUP BY p.slug ORDER BY p.slug COLLATE "C"`),
    };
  } finally {
    await target.disconnect();
  }
}

describe('engine parity: gbrain migrate from each source engine', () => {
  parityTest('a seeded brain migrates to PGLite with the same target rows on every source engine', {
    methods: ['putPage', 'addTag', 'addTimelineEntry', 'putRawData', 'addLink', 'writeManualLinkTransitions', 'insertFact', 'upsertOpenLoop',
      'setConfig', 'readManagedModeRows', 'getStats', 'listAllPageRefs', 'getPage', 'getLinks', 'readEngineMigrationHistory', 'readMigrationRows',
      'readMigrationPageColumns', 'listManualLinkTransitions', 'countLiveTimelineEntries', 'getAllConfig'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await seed(engine, backend);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-migrate-parity-home-'));
    const targetPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-parity-target-')), 'brain.pglite');
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        // The configured engine only has to differ from the target; the source engine is the arm's own handle.
        saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });
        _resetCliExitVerdictForTests();
        await runMigrateEngine(engine, ['--to', 'pglite', '--path', targetPath]);
        const verdict = currentExitCode();
        const switched = loadConfigFileOnly()?.engine;
        expect({ backend, verdict, switched }).toEqual({ backend, verdict: 0, switched: 'pglite' });
        return dumpTarget(targetPath);
      });
    } finally {
      _resetCliExitVerdictForTests();
      rmSync(home, { recursive: true, force: true });
      rmSync(join(targetPath, '..'), { recursive: true, force: true });
    }
  });

  parityTest('the source-side migration reads answer the same on every engine', {
    methods: ['putPage', 'addTag', 'addTimelineEntry', 'putRawData', 'addLink', 'writeManualLinkTransitions', 'insertFact', 'upsertOpenLoop',
      'setConfig', 'createVersion', 'softDeletePage', 'readEngineMigrationHistory', 'readMigrationRows', 'readMigrationPageColumns',
      'listManualLinkTransitions', 'countLiveTimelineEntries'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await seed(engine, backend);
    const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString().slice(0, 10));
    const page = await engine.readMigrationPageColumns(NOTE, 'default');
    const sources = (await engine.readMigrationRows('sources'))!;
    const facts = (await engine.readMigrationRows('facts'))!;
    const loops = (await engine.readMigrationRows('open_loops'))!;
    const suppressions = (await engine.readMigrationRows('loop_suppressions'))!;
    const before = { history: await engine.readEngineMigrationHistory(), timeline: await engine.countLiveTimelineEntries() };
    await engine.createVersion(NOTE);
    await engine.softDeletePage(NOTE);
    const after = { history: await engine.readEngineMigrationHistory(), timeline: await engine.countLiveTimelineEntries() };
    return {
      before, after,
      // A soft-deleted page keeps its columns and its manual statements.
      deletedPage: (await engine.readMigrationPageColumns(NOTE, 'default'))?.source_path ?? null,
      missingPage: await engine.readMigrationPageColumns('notes/none-example', 'default'),
      // The Rust store keeps no content author (GST-4056, rust/docs/store/seed.md) and omits the column; an absent author reads as none.
      page: page && { ...page, effective_date: iso(page.effective_date), ingested_at: page.ingested_at != null, content_author: page.content_author ?? null },
      transitions: await engine.listManualLinkTransitions(NOTE, 'default'),
      noTransitions: await engine.listManualLinkTransitions(CO, 'default'),
      sourceColumns: sources.columns,
      sources: sources.rows.map(r => ({ id: r.id, name: r.name, local_path: r.local_path, config: JSON.parse(String(r.config_json)), archived: r.archived,
        archived_at: r.archived_at, contextual_retrieval_mode: r.contextual_retrieval_mode, trust_frontmatter_overrides: r.trust_frontmatter_overrides })),
      factColumnsCopied: ['id', 'source_id', 'entity_slug', 'fact', 'kind', 'visibility', 'source', 'superseded_by', 'embedding'].filter(c => facts.columns.includes(c)),
      facts: facts.rows.map(r => ({ source_id: r.source_id, fact: r.fact, kind: r.kind, entity_slug: r.entity_slug, superseded: r.superseded_by != null,
        embedding: r.embedding ?? null })),
      loopColumnsCopied: ['id', 'source_id', 'dedup_key', 'evidence', 'opened_at'].filter(c => loops.columns.includes(c)),
      loops: loops.rows.map(r => ({ dedup_key: r.dedup_key, summary: r.summary, evidence: JSON.parse(String(r.evidence)), status: r.status })),
      suppressions: { columns: suppressions.columns, rows: suppressions.rows.length },
      // The side source's config is handed over whole: every stored key, the secret and the nested object included.
      sideConfigWhole: (() => {
        const side = sources.rows.find(r => r.id === SIDE);
        const config = JSON.parse(String(side?.config_json));
        expect(config).toEqual(SIDE_CONFIG);
        return Object.keys(config).sort();
      })(),
    };
  });
});
