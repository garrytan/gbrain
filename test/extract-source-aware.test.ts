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
