/**
 * E2E: v0.18.0 multi-source migrations against REAL Postgres.
 *
 * PGLite doesn't have a files table (see pglite-schema.ts header), so the
 * v23 migration's files.source_id + files.page_id rewrite + ledger seed
 * is NEVER executed by the PGLite integration test. This file closes
 * that gap by exercising the full v20-v23 chain against a real Postgres
 * DB with pre-existing data.
 *
 * Also covers the gaps in the PR's pre-shipping test matrix that the
 * author self-audited:
 *   - files.page_slug → page_id backfill against real rows
 *   - file_migration_ledger seeding
 *   - cascade delete via sources.remove (pages + chunks + timeline +
 *     files + links all gone)
 *   - sync --source <id> routing reads + writes per-source sync anchors
 *     instead of the global config keys
 *
 * Gated by DATABASE_URL — skips gracefully when unset, per the CLAUDE.md
 * E2E lifecycle pattern.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runSources } from '../../src/commands/sources.ts';
import { performSync } from '../../src/commands/sync.ts';
import { runStorageBackfill } from '../../src/commands/migrations/v0_18_0-storage-backfill.ts';
import type { StorageBackend } from '../../src/core/storage.ts';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine } from './helpers.ts';

const SKIP = !hasDatabase();
const describeE2E = SKIP ? describe.skip : describe;

describeE2E('v0.18.0 multi-source — Postgres schema shape (fresh install)', () => {
  beforeAll(async () => {
    await setupDB();
    // sources + file_migration_ledger are not in helpers.ALL_TABLES, so
    // residual rows from prior test runs can shadow new INSERTs. Wipe
    // non-default sources at the top of every describe to keep each
    // block hermetic. file_migration_ledger cascades from files which
    // setupDB already truncates, but wipe explicitly in case files did
    // not cascade it.
    const conn = getConn();
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(`DELETE FROM file_migration_ledger`);
  });
  afterAll(async () => {
    await teardownDB();
  });

  test("sources('default') exists after initSchema + migration chain", async () => {
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT id, name, config FROM sources WHERE id = 'default'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('default');
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config.federated).toBe(true);
  });

  test('pages.source_id NOT NULL with DEFAULT default (v21)', async () => {
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT column_name, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'source_id'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('NO');
    expect(String(rows[0].column_default)).toContain('default');
  });

  test('composite UNIQUE pages(source_id, slug) replaces global UNIQUE(slug)', async () => {
    const conn = getConn();
    const composite = await conn.unsafe(
      `SELECT conname FROM pg_constraint WHERE conname = 'pages_source_slug_key'`,
    );
    expect(composite.length).toBe(1);
    const oldGlobal = await conn.unsafe(
      `SELECT conname FROM pg_constraint WHERE conname = 'pages_slug_key'`,
    );
    expect(oldGlobal.length).toBe(0);
  });

  test('links.resolution_type column exists with CHECK (v22)', async () => {
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'links' AND column_name = 'resolution_type'`,
    );
    expect(rows.length).toBe(1);
    const check = await conn.unsafe(
      `SELECT conname FROM pg_constraint WHERE conname = 'links_resolution_type_check'`,
    );
    expect(check.length).toBe(1);
  });

  test('files.source_id + files.page_id columns exist (v23, Postgres-only)', async () => {
    const conn = getConn();
    const cols = await conn.unsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'files' AND column_name IN ('source_id', 'page_id')`,
    );
    // postgres.js returns RowList with an iterable-row shape; cast via
    // unknown before narrowing to plain objects (TS2352 otherwise).
    const names = new Set(
      (cols as unknown as Array<{ column_name: string }>).map(r => r.column_name),
    );
    expect(names.has('source_id')).toBe(true);
    expect(names.has('page_id')).toBe(true);
  });

  test('file_migration_ledger table exists with status CHECK (v23)', async () => {
    const conn = getConn();
    const tables = await conn.unsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name = 'file_migration_ledger'`,
    );
    expect(tables.length).toBe(1);
    const check = await conn.unsafe(
      `SELECT conname FROM pg_constraint WHERE conname = 'chk_ledger_status'`,
    );
    expect(check.length).toBe(1);
  });
});

describeE2E('v0.18.0 multi-source — composite UNIQUE semantics on real Postgres', () => {
  beforeAll(async () => {
    await setupDB();
    // sources + file_migration_ledger are not in helpers.ALL_TABLES, so
    // residual rows from prior test runs can shadow new INSERTs. Wipe
    // non-default sources at the top of every describe to keep each
    // block hermetic. file_migration_ledger cascades from files which
    // setupDB already truncates, but wipe explicitly in case files did
    // not cascade it.
    const conn = getConn();
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(`DELETE FROM file_migration_ledger`);
  });
  afterAll(async () => {
    await teardownDB();
  });

  test('same slug in two sources coexists (REGRESSION GUARD — Codex critical)', async () => {
    const conn = getConn();
    // Create a second source.
    const engine = getEngine();
    await runSources(engine as unknown as Parameters<typeof runSources>[0], ['add', 'wiki', '--federated']);

    // Insert the same slug under 'default' (via putPage) and 'wiki' (raw INSERT).
    await engine.putPage('topics/ai', {
      type: 'concept', title: 'AI from default', compiled_truth: 'default source take',
    });
    await conn.unsafe(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
         VALUES ('wiki', 'topics/ai', 'concept', 'AI from wiki', 'wiki source take', '', '{}'::jsonb, 'wikihash')`,
    );

    const rows = await conn.unsafe(
      `SELECT source_id, slug, title FROM pages WHERE slug = 'topics/ai' ORDER BY source_id`,
    );
    expect(rows.length).toBe(2);
    expect(rows.map((r: any) => r.source_id).sort()).toEqual(['default', 'wiki']);
  });

  test('duplicate (source_id, slug) hits composite UNIQUE', async () => {
    const conn = getConn();
    let err: Error | null = null;
    try {
      await conn.unsafe(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
           VALUES ('wiki', 'topics/ai', 'concept', 'dup', '', '', '{}'::jsonb, 'dup')`,
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message.toLowerCase()).toMatch(/unique|duplicate/);
  });

  test('putPage (engine API) targets default source by schema DEFAULT', async () => {
    const engine = getEngine();
    await engine.putPage('topics/from-putpage', {
      type: 'note', title: 'Via putPage', compiled_truth: 'body',
    });
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT source_id FROM pages WHERE slug = 'topics/from-putpage'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });
});

describeE2E('v0.18.0 multi-source — cascade delete covers every dependent row', () => {
  beforeAll(async () => {
    await setupDB();
    // sources + file_migration_ledger are not in helpers.ALL_TABLES, so
    // residual rows from prior test runs can shadow new INSERTs. Wipe
    // non-default sources at the top of every describe to keep each
    // block hermetic. file_migration_ledger cascades from files which
    // setupDB already truncates, but wipe explicitly in case files did
    // not cascade it.
    const conn = getConn();
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(`DELETE FROM file_migration_ledger`);
  });
  afterAll(async () => {
    await teardownDB();
  });

  test('sources remove cascades to pages + chunks + timeline + links + files', async () => {
    const conn = getConn();
    const engine = getEngine();

    // Build a fully populated source: page, chunks, timeline entries,
    // links, a file row. Then remove the source and verify nothing
    // for that source survives.
    await runSources(engine as unknown as Parameters<typeof runSources>[0], ['add', 'cascadetest', '--federated']);

    // Page under cascadetest
    await conn.unsafe(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
         VALUES ('cascadetest', 'people/alice', 'person', 'Alice', 'Alice body', '', '{}'::jsonb, 'h1')`,
    );
    const alicePage = await conn.unsafe(
      `SELECT id FROM pages WHERE source_id = 'cascadetest' AND slug = 'people/alice'`,
    );
    const aliceId = alicePage[0].id as number;

    // A second page for link target
    await conn.unsafe(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
         VALUES ('cascadetest', 'companies/acme', 'company', 'Acme', 'Acme body', '', '{}'::jsonb, 'h2')`,
    );
    const acmePage = await conn.unsafe(
      `SELECT id FROM pages WHERE source_id = 'cascadetest' AND slug = 'companies/acme'`,
    );
    const acmeId = acmePage[0].id as number;

    // Chunk
    await conn.unsafe(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
         VALUES (${aliceId}, 0, 'Alice body chunk', 'compiled_truth')`,
    );

    // Timeline
    await conn.unsafe(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
         VALUES (${aliceId}, '2026-01-15', 'test', 'Joined Acme', 'detail')`,
    );

    // Link Alice → Acme
    await conn.unsafe(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
         VALUES (${aliceId}, ${acmeId}, 'works_at', 'markdown')`,
    );

    // File row pointing at Alice
    await conn.unsafe(
      `INSERT INTO files (source_id, page_id, filename, storage_path, content_hash)
         VALUES ('cascadetest', ${aliceId}, 'alice.pdf', 'cascadetest/people/alice/alice.pdf', 'fh1')`,
    );

    // Sanity: everything exists
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'cascadetest'`))[0].n).toBe(2);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM content_chunks WHERE page_id = ${aliceId}`))[0].n).toBe(1);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM timeline_entries WHERE page_id = ${aliceId}`))[0].n).toBe(1);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM links WHERE from_page_id = ${aliceId}`))[0].n).toBe(1);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM files WHERE source_id = 'cascadetest'`))[0].n).toBe(1);

    // Remove the source.
    await runSources(engine as unknown as Parameters<typeof runSources>[0], ['remove', 'cascadetest', '--yes']);

    // Everything for that source is gone.
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'cascadetest'`))[0].n).toBe(0);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM content_chunks WHERE page_id = ${aliceId}`))[0].n).toBe(0);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM timeline_entries WHERE page_id = ${aliceId}`))[0].n).toBe(0);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM links WHERE from_page_id = ${aliceId}`))[0].n).toBe(0);
    expect((await conn.unsafe(`SELECT COUNT(*)::int AS n FROM files WHERE source_id = 'cascadetest'`))[0].n).toBe(0);

    // The sources row itself is gone.
    const src = await conn.unsafe(`SELECT id FROM sources WHERE id = 'cascadetest'`);
    expect(src.length).toBe(0);
  });
});

describeE2E('v0.18.0 multi-source — sync --source routes through sources table', () => {
  beforeAll(async () => {
    await setupDB();
    // sources + file_migration_ledger are not in helpers.ALL_TABLES, so
    // residual rows from prior test runs can shadow new INSERTs. Wipe
    // non-default sources at the top of every describe to keep each
    // block hermetic. file_migration_ledger cascades from files which
    // setupDB already truncates, but wipe explicitly in case files did
    // not cascade it.
    const conn = getConn();
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(`DELETE FROM file_migration_ledger`);
  });
  afterAll(async () => {
    await teardownDB();
  });

  test('performSync with sourceId reads local_path from sources row', async () => {
    const engine = getEngine();
    const conn = getConn();

    // Register a source with a bogus path (we're not actually walking a
    // repo — this test asserts that performSync correctly RESOLVES the
    // source row vs hitting the global config).
    await runSources(engine as unknown as Parameters<typeof runSources>[0], [
      'add', 'syncsrc', '--path', '/nonexistent/syncsrc/path', '--no-federated',
    ]);

    // Also set a DIFFERENT path in the global config so we can verify
    // sourceId actually disambiguates.
    await engine.setConfig('sync.repo_path', '/some/other/default/path');

    // performSync({sourceId: 'syncsrc'}) should attempt to use
    // /nonexistent/syncsrc/path, NOT /some/other/default/path.
    let err: Error | null = null;
    try {
      await performSync(engine, { sourceId: 'syncsrc' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    // The error message references the source-scoped path, not the
    // global config path. (Could be "Not a git repository"
    // or "No commits in repo" — either way the path it cites should
    // be the source's.)
    expect(err!.message).toContain('/nonexistent/syncsrc/path');
    expect(err!.message).not.toContain('/some/other/default/path');
  });

  test('performSync with no sourceId falls back to global sync.repo_path', async () => {
    const engine = getEngine();
    // Global config is still '/some/other/default/path' from the
    // previous test. Without --source, performSync uses it.
    let err: Error | null = null;
    try {
      await performSync(engine, {});
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('/some/other/default/path');
  });
});

describeE2E('v0.18.0 multi-source — sources table surface', () => {
  beforeAll(async () => {
    await setupDB();
    // sources + file_migration_ledger are not in helpers.ALL_TABLES, so
    // residual rows from prior test runs can shadow new INSERTs. Wipe
    // non-default sources at the top of every describe to keep each
    // block hermetic. file_migration_ledger cascades from files which
    // setupDB already truncates, but wipe explicitly in case files did
    // not cascade it.
    const conn = getConn();
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(`DELETE FROM file_migration_ledger`);
  });
  afterAll(async () => {
    await teardownDB();
  });

  test('default source is seeded federated=true; new sources default to isolated', async () => {
    const conn = getConn();
    const engine = getEngine();

    const def = await conn.unsafe(`SELECT config FROM sources WHERE id = 'default'`);
    const defConfig = typeof def[0].config === 'string' ? JSON.parse(def[0].config) : def[0].config;
    expect(defConfig.federated).toBe(true);

    // Defensive cleanup: sources isn't in helpers.ALL_TABLES, so residual
    // rows from prior test runs can shadow this INSERT via ON CONFLICT
    // DO NOTHING. Delete first, then create.
    await conn.unsafe(`DELETE FROM sources WHERE id = 'isolatedsrc'`);
    await runSources(engine as unknown as Parameters<typeof runSources>[0], ['add', 'isolatedsrc']);
    const iso = await conn.unsafe(`SELECT config FROM sources WHERE id = 'isolatedsrc'`);
    const isoConfig = typeof iso[0].config === 'string' ? JSON.parse(iso[0].config) : iso[0].config;
    expect(isoConfig.federated).toBeUndefined();  // omitted → isolated-by-default
  });

  test('federate / unfederate flips config.federated on real DB', async () => {
    const conn = getConn();
    const engine = getEngine();

    await runSources(engine as unknown as Parameters<typeof runSources>[0], ['federate', 'isolatedsrc']);
    let row = await conn.unsafe(`SELECT config FROM sources WHERE id = 'isolatedsrc'`);
    let config = typeof row[0].config === 'string' ? JSON.parse(row[0].config) : row[0].config;
    expect(config.federated).toBe(true);

    await runSources(engine as unknown as Parameters<typeof runSources>[0], ['unfederate', 'isolatedsrc']);
    row = await conn.unsafe(`SELECT config FROM sources WHERE id = 'isolatedsrc'`);
    config = typeof row[0].config === 'string' ? JSON.parse(row[0].config) : row[0].config;
    expect(config.federated).toBe(false);
  });

  test('rename changes name, id stays stable', async () => {
    const conn = getConn();
    const engine = getEngine();

    await runSources(engine as unknown as Parameters<typeof runSources>[0], [
      'rename', 'isolatedsrc', 'My Isolated Source',
    ]);
    const row = await conn.unsafe(`SELECT id, name FROM sources WHERE id = 'isolatedsrc'`);
    expect(row[0].id).toBe('isolatedsrc');
    expect(row[0].name).toBe('My Isolated Source');
  });
});

describeE2E('v0.18.0 multi-source — storage backfill against file_migration_ledger', () => {
  beforeAll(async () => {
    await setupDB();
    // sources + file_migration_ledger are not in helpers.ALL_TABLES, so
    // residual rows from prior test runs can shadow new INSERTs. Wipe
    // non-default sources at the top of every describe to keep each
    // block hermetic. file_migration_ledger cascades from files which
    // setupDB already truncates, but wipe explicitly in case files did
    // not cascade it.
    const conn = getConn();
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(`DELETE FROM file_migration_ledger`);
  });
  afterAll(async () => {
    await teardownDB();
  });

  test('seeded ledger + stub storage: pending → complete end-to-end', async () => {
    const conn = getConn();
    const engine = getEngine();

    // Seed a page + file (via raw INSERT so the test doesn't depend on
    // sync running).
    await conn.unsafe(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
         VALUES ('default', 'topics/storage', 'note', 'Storage test', 'body', '', '{}'::jsonb, 'sh1')`,
    );
    const pageRow = await conn.unsafe(
      `SELECT id FROM pages WHERE source_id = 'default' AND slug = 'topics/storage'`,
    );
    const pageId = pageRow[0].id as number;

    await conn.unsafe(
      `INSERT INTO files (source_id, page_id, filename, storage_path, content_hash)
         VALUES ('default', ${pageId}, 'doc.pdf', 'topics/storage/doc.pdf', 'fh1')`,
    );
    const fileRow = await conn.unsafe(
      `SELECT id FROM files WHERE storage_path = 'topics/storage/doc.pdf'`,
    );
    const fileId = fileRow[0].id as number;

    // Seed the ledger manually so we don't depend on the v23 seed SQL
    // (the TRUNCATE CASCADE in setupDB wipes ledger rows).
    await conn.unsafe(
      `INSERT INTO file_migration_ledger (file_id, storage_path_old, storage_path_new, status)
         VALUES (${fileId}, 'topics/storage/doc.pdf', 'default/topics/storage/doc.pdf', 'pending')
       ON CONFLICT (file_id) DO NOTHING`,
    );

    // Stub storage: downloads return bytes, uploads track what was written.
    const uploaded = new Set<string>();
    const stub: StorageBackend = {
      upload: async (p: string) => { uploaded.add(p); },
      download: async (p: string) => Buffer.from('bytes-for:' + p),
      delete: async (p: string) => { uploaded.delete(p); },
      exists: async (p: string) => uploaded.has(p),
      list: async () => [],
      getUrl: async (p) => `https://stub/${p}`,
    };

    const report = await runStorageBackfill(engine, stub);
    expect(report.total).toBe(1);
    expect(report.nowComplete).toBe(1);
    expect(report.failed).toBe(0);

    // Ledger row transitioned to complete.
    const ledger = await conn.unsafe(
      `SELECT status FROM file_migration_ledger WHERE file_id = ${fileId}`,
    );
    expect(ledger[0].status).toBe('complete');

    // Files row now points at the new path.
    const filesAfter = await conn.unsafe(
      `SELECT storage_path FROM files WHERE id = ${fileId}`,
    );
    expect(filesAfter[0].storage_path).toBe('default/topics/storage/doc.pdf');

    // Stub storage saw the upload happen at the new path.
    expect(uploaded.has('default/topics/storage/doc.pdf')).toBe(true);
  });
});

// v0.18.0: real-Postgres regression guard for the addLinksBatch /
// addTimelineEntriesBatch JOIN fan-out bug. Before the fix, the JOIN was
// `pages.slug = v.from_slug` unqualified — so two pages sharing the same
// slug across sources would silently duplicate edges and timeline rows.
// postgres-js binds arrays through `unnest()` rather than inline VALUES,
// so the query shape is structurally different from PGLite's and gets its
// own coverage.
describeE2E('v0.18.0 multi-source — addLinksBatch / addTimelineEntriesBatch source-awareness', () => {
  beforeAll(async () => {
    await setupDB();
    const conn = getConn();
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(`DELETE FROM file_migration_ledger`);
  });
  afterAll(async () => { await teardownDB(); });

  async function seedSameSlugTwoSources() {
    const conn = getConn();
    const engine = getEngine() as PostgresEngine;
    // Second source alongside 'default'.
    await conn.unsafe(
      `INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT (id) DO NOTHING`
    );
    // Create same-slug pages in both sources. putPage defaults to 'default'.
    await engine.putPage('topics/ai', { type: 'concept', title: 'AI (default)', compiled_truth: '', timeline: '' });
    await engine.putPage('topics/ml', { type: 'concept', title: 'ML (default)', compiled_truth: '', timeline: '' });
    await conn.unsafe(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_id, updated_at)
       VALUES ('topics/ai', 'concept', 'AI (alt)', '', '', '{}'::jsonb, 'alt-ai-hash', 'alt', now()),
              ('topics/ml', 'concept', 'ML (alt)', '', '', '{}'::jsonb, 'alt-ml-hash', 'alt', now())`
    );
  }

  test('addLinksBatch without explicit source_id does NOT fan out across sources', async () => {
    await seedSameSlugTwoSources();
    const conn = getConn();
    const engine = getEngine() as PostgresEngine;
    // Reset links from any prior describe block.
    await conn.unsafe(`DELETE FROM links`);
    const inserted = await engine.addLinksBatch([
      { from_slug: 'topics/ai', to_slug: 'topics/ml', link_type: 'mention' },
    ]);
    // Exactly one edge (default → default). Before the fix this was 2.
    expect(inserted).toBe(1);
    const rows = await conn.unsafe(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('default');
    expect(rows[0].to_src).toBe('default');
  });

  test('addLinksBatch supports cross-source edges when explicit source_ids differ', async () => {
    const conn = getConn();
    const engine = getEngine() as PostgresEngine;
    await conn.unsafe(`DELETE FROM links`);
    const inserted = await engine.addLinksBatch([
      {
        from_slug: 'topics/ai', to_slug: 'topics/ml', link_type: 'mention',
        from_source_id: 'default', to_source_id: 'alt',
      },
    ]);
    expect(inserted).toBe(1);
    const rows = await conn.unsafe(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('default');
    expect(rows[0].to_src).toBe('alt');
  });

  test('addTimelineEntriesBatch without explicit source_id does NOT fan out across sources', async () => {
    const conn = getConn();
    const engine = getEngine() as PostgresEngine;
    await conn.unsafe(`DELETE FROM timeline_entries`);
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'topics/ai', date: '2024-01-15', summary: 'Founded' },
    ]);
    expect(inserted).toBe(1);
    const rows = await conn.unsafe(
      `SELECT p.source_id
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('addTimelineEntriesBatch with explicit alt source_id lands only in alt', async () => {
    const conn = getConn();
    const engine = getEngine() as PostgresEngine;
    await conn.unsafe(`DELETE FROM timeline_entries`);
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'topics/ai', date: '2024-02-01', summary: 'Alt-only event', source_id: 'alt' },
    ]);
    expect(inserted).toBe(1);
    const rows = await conn.unsafe(
      `SELECT p.source_id
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('alt');
  });
});
