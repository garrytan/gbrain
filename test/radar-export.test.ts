/**
 * Tests for `gbrain radar export` — the Radar visual-mirror snapshot exporter.
 *
 * Radar reads the GBrain ENGINE only (never the Markdown vault). These tests
 * drive an in-memory PGLite engine, seed pages/links/tags (incl. a private
 * page), and assert: the snapshot layout, referential integrity, privacy
 * default-exclusion + opt-in, atomic swap (previous/ preservation), and the
 * incremental-ready manifest primitives. See
 * docs/designs/RADAR_SNAPSHOT_EXPORT.md.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  exportSnapshot,
  buildSnapshot,
  validateSnapshot,
  extractHeadings,
  safeSlugPath,
  pageKey,
} from '../src/core/radar/export.ts';
import type { RadarExportOpts } from '../src/core/radar/types.ts';

let engine: PGLiteEngine;
let tmp: string;

function readJson(dir: string, rel: string): any {
  return JSON.parse(readFileSync(join(dir, rel), 'utf8'));
}

function baseOpts(out: string, over: Partial<RadarExportOpts> = {}): RadarExportOpts {
  return {
    out,
    sourceId: null,
    scope: null,
    includePrivate: false,
    pretty: true,
    ...over,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-radar-test-'));
  const tables = [
    'content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries',
    'page_versions', 'ingest_log', 'pages', 'sources',
  ];
  for (const t of tables) {
    await (engine as unknown as { db: { exec(sql: string): Promise<unknown> } }).db.exec(
      `DELETE FROM ${t}`,
    );
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('default', 'Default') ON CONFLICT DO NOTHING`,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a small connected brain with a private page. */
async function seedBrain(): Promise<void> {
  await engine.putPage('wiki/alice-example', {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: '# Alice\n\nFounder of [Acme](wiki/acme-example).\n\n## History\n\nThings.',
    frontmatter: { tags: ['founder'], summary: 'A founder' },
  });
  await engine.putPage('wiki/acme-example', {
    type: 'company',
    title: 'Acme Example',
    compiled_truth: '# Acme\n\nA company. Backed by nobody.',
    frontmatter: { status: 'active' },
  });
  await engine.putPage('notes/secret-deal', {
    type: 'note',
    title: 'Secret Deal',
    compiled_truth: '# Secret\n\nConfidential.',
    frontmatter: { privacy: 'private' },
  });
  // Edge: alice -> acme (resolved). The alice -> secret-deal edge dangles in
  // the default export because the private page is excluded from scope (a real
  // dangling case — addLink requires both endpoints to exist in the DB).
  await engine.addLink('wiki/alice-example', 'wiki/acme-example', '', 'mentions', 'manual');
  await engine.addLink('wiki/alice-example', 'notes/secret-deal', '', 'mentions', 'manual');
  await engine.addTag('wiki/alice-example', 'founder');
}

describe('radar export — pure helpers', () => {
  test('extractHeadings parses ATX headings and skips code fences', () => {
    const body = '# Title\n\nText\n\n```\n# not a heading\n```\n\n## Section\n### Deep';
    const hs = extractHeadings(body);
    expect(hs.map((h) => h.text)).toEqual(['Title', 'Section', 'Deep']);
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3]);
  });

  test('safeSlugPath preserves hyphens/folders and blocks traversal', () => {
    expect(safeSlugPath('default', 'wiki/alice-example')).toBe('wiki/alice-example.json');
    expect(safeSlugPath('default', '../../etc/passwd')).toBe('etc/passwd.json');
    // Non-default source is prefixed to disambiguate same-slug collisions.
    expect(safeSlugPath('team', 'a/b')).toBe('team/a/b.json');
  });

  test('pageKey is source-scoped', () => {
    expect(pageKey('default', 'a/b')).toBe('default::a/b');
  });
});

describe('radar export — snapshot build + integrity', () => {
  test('full export writes the snapshot layout and passes validation', async () => {
    await seedBrain();
    const result = await exportSnapshot(engine, baseOpts(tmp));
    const cur = result.current_dir;

    // Layout exists.
    for (const f of [
      'manifest.json', 'tree.json', 'pages-index.json', 'graph.json',
      'search-index.json', 'views/recent.json',
    ]) {
      expect(existsSync(join(cur, f))).toBe(true);
    }

    const manifest = readJson(cur, 'manifest.json');
    expect(manifest.mode).toBe('full');
    expect(typeof manifest.snapshot_id).toBe('string');
    expect(typeof manifest.content_hash).toBe('string');
    expect(manifest.previous_snapshot_id).toBeNull();
    expect(manifest.brain_id).toBe('host');
    expect(manifest.validation.status).not.toBe('fail');

    // Private page excluded by default → 2 pages, not 3.
    expect(manifest.counts.pages).toBe(2);
    expect(manifest.counts.private_excluded).toBe(1);

    // pages-index ↔ per-page file existence.
    const index = readJson(cur, 'pages-index.json');
    expect(index.pages.length).toBe(2);
    for (const entry of index.pages) {
      expect(existsSync(join(cur, entry.page_path))).toBe(true);
      expect(entry.page_key).toBe(`${entry.source_id}::${entry.slug}`);
    }

    // Graph: one resolved edge (alice→acme), one dangling (alice→excluded private).
    const graph = readJson(cur, 'graph.json');
    const resolved = graph.edges.filter((e: any) => e.resolved);
    const dangling = graph.edges.filter((e: any) => !e.resolved);
    expect(resolved.length).toBe(1);
    expect(resolved[0].to_slug).toBe('wiki/acme-example');
    expect(resolved[0].to_key).toBe('default::wiki/acme-example');
    expect(dangling.length).toBe(1);
    expect(dangling[0].to_slug).toBe('notes/secret-deal');
    expect(dangling[0].to_key).toBeNull();
    expect(manifest.counts.edges_dangling).toBe(1);

    // inlink count surfaces on acme.
    const acmeNode = graph.nodes.find((n: any) => n.slug === 'wiki/acme-example');
    expect(acmeNode.inlinks).toBe(1);
  });

  test('per-page detail carries raw markdown, headings, tags, backlinks (no HTML)', async () => {
    await seedBrain();
    const result = await exportSnapshot(engine, baseOpts(tmp));
    const cur = result.current_dir;
    const acme = readJson(cur, 'pages/wiki/acme-example.json');
    expect(acme.markdown).toContain('# Acme');
    expect(JSON.stringify(acme)).not.toContain('<html');
    // acme is the target of alice's resolved edge → has a backlink.
    expect(acme.backlinks.length).toBe(1);
    expect(acme.backlinks[0].page_key).toBe('default::wiki/alice-example');

    const alice = readJson(cur, 'pages/wiki/alice-example.json');
    expect(alice.headings.map((h: any) => h.text)).toContain('Alice');
    expect(alice.tags).toContain('founder');
    expect(alice.outlinks.length).toBe(2);
  });

  test('search-index is lean (no full body)', async () => {
    await seedBrain();
    const result = await exportSnapshot(engine, baseOpts(tmp));
    const search = readJson(result.current_dir, 'search-index.json');
    expect(search.docs.length).toBe(2);
    const doc = search.docs.find((d: any) => d.slug === 'wiki/alice-example');
    expect(doc.title).toBe('Alice Example');
    expect(Array.isArray(doc.headings)).toBe(true);
    // No body / compiled_truth field on a search doc.
    expect(doc.body).toBeUndefined();
    expect(doc.compiled_truth).toBeUndefined();
  });

  test('--include-private includes the private page', async () => {
    await seedBrain();
    const result = await exportSnapshot(engine, baseOpts(tmp, { includePrivate: true }));
    const manifest = readJson(result.current_dir, 'manifest.json');
    expect(manifest.counts.pages).toBe(3);
    expect(manifest.counts.private_excluded).toBe(0);
    const index = readJson(result.current_dir, 'pages-index.json');
    const secret = index.pages.find((p: any) => p.slug === 'notes/secret-deal');
    expect(secret).toBeDefined();
    expect(secret.flags.private).toBe(true);
  });

  test('validateSnapshot reports no hard failures on a well-formed model', async () => {
    await seedBrain();
    const model = await buildSnapshot(engine, baseOpts(tmp));
    const failures = validateSnapshot(model);
    expect(failures).toEqual([]);
  });
});

describe('radar export — atomic swap', () => {
  test('second export preserves prior snapshot as previous/ and links it', async () => {
    await seedBrain();
    const first = await exportSnapshot(engine, baseOpts(tmp));
    expect(first.previous_dir).toBeNull();

    // Add a page, re-export.
    await engine.putPage('wiki/bob-example', {
      type: 'person', title: 'Bob', compiled_truth: '# Bob', frontmatter: {},
    });
    const second = await exportSnapshot(engine, baseOpts(tmp));

    expect(second.previous_dir).not.toBeNull();
    expect(existsSync(join(tmp, 'snapshot', 'previous', 'manifest.json'))).toBe(true);
    // The new manifest points back at the first snapshot.
    const curManifest = readJson(second.current_dir, 'manifest.json');
    expect(curManifest.previous_snapshot_id).toBe(first.snapshot_id);
    expect(curManifest.counts.pages).toBe(3);
    // previous/ still holds the older 2-page snapshot.
    const prevManifest = readJson(join(tmp, 'snapshot', 'previous'), 'manifest.json');
    expect(prevManifest.snapshot_id).toBe(first.snapshot_id);
    expect(prevManifest.counts.pages).toBe(2);
    // No tmp dir left behind.
    const leftovers = existsSync(join(tmp, 'snapshot'))
      ? readdirSync(join(tmp, 'snapshot')).filter((n: string) => n.startsWith('.tmp-'))
      : [];
    expect(leftovers).toEqual([]);
  });
});

describe('radar export — source scoping', () => {
  test('--source-id restricts the snapshot to one source', async () => {
    await seedBrain();
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('team', 'Team') ON CONFLICT DO NOTHING`,
    );
    await engine.putPage(
      'team-doc',
      { type: 'note', title: 'Team Doc', compiled_truth: '# Team', frontmatter: {} },
      { sourceId: 'team' },
    );

    const result = await exportSnapshot(engine, baseOpts(tmp, { sourceId: 'team' }));
    const manifest = readJson(result.current_dir, 'manifest.json');
    expect(manifest.source_ids).toEqual(['team']);
    expect(manifest.counts.pages).toBe(1);
    const index = readJson(result.current_dir, 'pages-index.json');
    expect(index.pages[0].slug).toBe('team-doc');
  });
});
