/**
 * v0.37.7.0 #1204 — `gbrain extract --source-id <id>` scopes extraction.
 *
 * Federated brain users running `gbrain extract` need to scope by
 * source. Pre-fix, every run walked all sources together which
 * confused link resolution on cross-source duplicates. This test
 * pins the new `--source-id` flag: walk + extract only that source's
 * pages, while the resolver still sees ALL sources so qualified
 * `[[source:slug]]` wikilinks across sources can resolve.
 *
 * Hermetic via PGLite in-memory (no DATABASE_URL needed). Dedicated
 * file per D4 lock.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll(): Promise<void> {
  for (const t of ['content_chunks', 'links', 'timeline_entries', 'tags', 'raw_data', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

describe('extract --source-id flag (#1204)', () => {
  beforeEach(async () => {
    await truncateAll();
    // Two sources, each with a page whose body contains a wikilink to
    // its sibling in the same source.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('alpha', 'alpha'), ('beta', 'beta')
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES
         ('people/alice', 'alpha', 'person', 'Alice', 'Met [[people/bob]] today.', ''),
         ('people/bob', 'alpha', 'person', 'Bob', 'Friend of [[people/alice]].', ''),
         ('people/carol', 'beta', 'person', 'Carol', 'Met [[people/dave]].', ''),
         ('people/dave', 'beta', 'person', 'Dave', 'Friend of [[people/carol]].', '')`,
    );
  });

  test('without --source-id, walks all sources', async () => {
    const captured: unknown[] = [];
    const origLog = console.log;
    console.log = (m: unknown) => { captured.push(m); };
    try {
      await runExtract(engine, ['links', '--source', 'db', '--json']);
    } finally {
      console.log = origLog;
    }
    // Some non-zero number of links across both sources.
    const linkRows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links`,
    );
    expect(Number(linkRows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
  });

  test('--source-id alpha scopes extraction to alpha only', async () => {
    const captured: unknown[] = [];
    const origLog = console.log;
    console.log = (m: unknown) => { captured.push(m); };
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', 'alpha', '--json']);
    } finally {
      console.log = origLog;
    }
    // Links produced should only originate from alpha-source pages.
    const linkRows = await engine.executeRaw<{ slug: string; source_id: string }>(
      `SELECT p.slug, p.source_id FROM links l
         JOIN pages p ON l.from_page_id = p.id`,
    );
    // Every link's from-page must be in alpha.
    for (const r of linkRows) {
      expect(r.source_id).toBe('alpha');
    }
    // And there should be at least one such link.
    expect(linkRows.length).toBeGreaterThanOrEqual(1);
  });

  test('--source-id beta scopes to beta and produces beta-origin links only', async () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', 'beta', '--json']);
    } finally {
      console.log = origLog;
    }
    const linkRows = await engine.executeRaw<{ source_id: string }>(
      `SELECT p.source_id FROM links l
         JOIN pages p ON l.from_page_id = p.id`,
    );
    for (const r of linkRows) {
      expect(r.source_id).toBe('beta');
    }
  });

  test('--source-id with non-matching source produces zero links', async () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', 'nonexistent', '--json']);
    } finally {
      console.log = origLog;
    }
    const linkRows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links`,
    );
    expect(Number(linkRows[0]?.n ?? 0)).toBe(0);
  });
});

// ─── Issue #1493 (codex P1): qualified pin + scoped default fallback ──

describe('extract --source db: any-dir wikilinks across sources (#1493)', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('alpha', 'alpha'), ('beta', 'beta')
       ON CONFLICT (id) DO NOTHING`,
    );
  });

  async function runLinksDb(extra: string[] = []): Promise<void> {
    const origLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['links', '--source', 'db', ...extra, '--json']);
    } finally {
      console.log = origLog;
    }
  }

  test('qualified [[beta:janus/target]] links to the PINNED source', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES
         ('concepts/note', 'alpha', 'concept', 'Note', 'See [[beta:janus/target]].', ''),
         ('janus/target', 'beta', 'concept', 'Target', 'The target.', '')`,
    );
    await runLinksDb();
    const rows = await engine.executeRaw<{ to_slug: string; to_source: string }>(
      `SELECT t.slug AS to_slug, t.source_id AS to_source
         FROM links l JOIN pages t ON l.to_page_id = t.id`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].to_slug).toBe('janus/target');
    expect(rows[0].to_source).toBe('beta');
  });

  test('pin miss is NOT misdirected to a same-slug page in origin/default', async () => {
    // janus/dup exists in alpha AND default — but the wikilink pins beta,
    // where it does not exist. No edge at all (skip beats misdirect).
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES
         ('concepts/note', 'alpha', 'concept', 'Note', 'See [[beta:janus/dup]].', ''),
         ('janus/dup', 'alpha', 'concept', 'Dup A', 'x', ''),
         ('janus/dup', 'default', 'concept', 'Dup D', 'x', '')`,
    );
    await runLinksDb();
    const rows = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*)::text AS n FROM links`);
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('scoped --source-id run keeps the default-source fallback for unqualified any-dir links', async () => {
    // The target lives ONLY in the default source; the scoped slugExists
    // snapshot must include the default overlay so the candidate survives
    // to resolveCandidateSources' documented fallback (parity with
    // whitelisted refs, which bypass slugExists).
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES
         ('concepts/note', 'alpha', 'concept', 'Note', 'See [[janus/shared-doc]].', ''),
         ('janus/shared-doc', 'default', 'concept', 'Shared', 'The doc.', '')`,
    );
    await runLinksDb(['--source-id', 'alpha']);
    const rows = await engine.executeRaw<{ to_slug: string; to_source: string; from_source: string }>(
      `SELECT t.slug AS to_slug, t.source_id AS to_source, f.source_id AS from_source
         FROM links l JOIN pages t ON l.to_page_id = t.id JOIN pages f ON l.from_page_id = f.id`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_source).toBe('alpha');
    expect(rows[0].to_slug).toBe('janus/shared-doc');
    expect(rows[0].to_source).toBe('default');
  });

  test('scoped run still refuses cross-source (non-default) any-dir resolution', async () => {
    // Target exists only in beta. Scoped alpha run: slugExists domain is
    // alpha ∪ default → miss → recorded unresolved, no edge (a bare
    // unqualified link must not silently span unrelated sources).
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES
         ('concepts/note', 'alpha', 'concept', 'Note', 'See [[janus/foreign]].', ''),
         ('janus/foreign', 'beta', 'concept', 'Foreign', 'x', '')`,
    );
    await runLinksDb(['--source-id', 'alpha']);
    const rows = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*)::text AS n FROM links`);
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });
});
