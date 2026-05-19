/**
 * TIM-28: wikilink alias / title / basename fallback resolution.
 *
 * Pre-fix the FS extractor resolved wikilink targets via path-equality only,
 * which on Obsidian-style vaults yielded a ~5% wikilink → edge ratio (45/812
 * on the TimelyCare vault). This suite locks the four resolution paths added
 * in v0.36.0:
 *
 *   1. `path`     — `[Name](path)` markdown ref or `[[a/b/c]]` wikilink whose
 *                   slugified target lives in the local slug set.
 *   2. `alias`    — frontmatter `aliases: [...]` resolver hit.
 *   3. `title`    — first H1 heading hit.
 *   4. `basename` — last `/`-segment of a known slug hit.
 *
 * The link `resolution_type` column is the audit trail — it records which
 * resolver fired so we can grade recall later.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import {
  WikilinkAliasIndex,
  deriveTitleFromContent,
  type PageAliasFields,
} from '../src/core/link-extraction.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as unknown as { db: { exec: (s: string) => Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
}

const page = (title: string, body = '', extraFrontmatter: Record<string, unknown> = {}): PageInput => ({
  type: 'concept', title, compiled_truth: body, timeline: '', frontmatter: extraFrontmatter,
});

beforeEach(async () => {
  await truncateAll();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-aliases-'));
}, 15_000);

function writeFile(rel: string, content: string) {
  const full = join(brainDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

// ─── Unit tests: WikilinkAliasIndex ─────────────────────────────

describe('WikilinkAliasIndex (unit)', () => {
  const entries: PageAliasFields[] = [
    {
      slug: '10_projects/team-training/_team-training',
      aliases: ['Team Training', 'TT', 'training-hub'],
      title: 'Team Training',
    },
    {
      slug: '10_projects/user-research/_user-research',
      aliases: 'User Research',  // string, not array — also valid YAML
      title: 'User Research',
    },
    {
      slug: '30_resources/rapid-research-framework-v9',
      // no aliases — title-only resolution
      title: 'Rapid Research Framework',
    },
  ];

  test('alias-string and alias-array both populate the index', () => {
    const idx = new WikilinkAliasIndex(entries);
    expect(idx.tryResolve('User Research')?.slug)
      .toBe('10_projects/user-research/_user-research');
    expect(idx.tryResolve('Team Training')?.slug)
      .toBe('10_projects/team-training/_team-training');
  });

  test('alias resolver beats title and basename', () => {
    const idx = new WikilinkAliasIndex(entries);
    // 'TT' only matches via aliases.
    expect(idx.tryResolve('TT')).toEqual({
      slug: '10_projects/team-training/_team-training',
      resolutionType: 'alias',
    });
  });

  test('title resolver matches when no alias is declared', () => {
    const idx = new WikilinkAliasIndex(entries);
    expect(idx.tryResolve('Rapid Research Framework')).toEqual({
      slug: '30_resources/rapid-research-framework-v9',
      resolutionType: 'title',
    });
  });

  test('basename resolver matches short-form wikilinks like [[_Team-Training]]', () => {
    const idx = new WikilinkAliasIndex(entries);
    // Obsidian short form. The slug `10_projects/team-training/_team-training`
    // has basename `_team-training` — basename map keys are lowercased.
    expect(idx.tryResolve('_Team-Training')).toEqual({
      slug: '10_projects/team-training/_team-training',
      resolutionType: 'basename',
    });
  });

  test('display-aliased form: pipe display name is consulted as an alias key', () => {
    const idx = new WikilinkAliasIndex(entries);
    // `[[some/missing/path|User Research]]` — path part misses but display
    // matches the frontmatter alias.
    const r = idx.tryResolve('some/missing/path', 'User Research');
    expect(r?.slug).toBe('10_projects/user-research/_user-research');
    expect(r?.resolutionType).toBe('alias');
  });

  test('returns null when no resolver matches', () => {
    const idx = new WikilinkAliasIndex(entries);
    expect(idx.tryResolve('totally-unknown-target')).toBeNull();
  });

  test('first-write-wins on basename collisions stays deterministic', () => {
    const idx = new WikilinkAliasIndex([
      { slug: 'a/notes', title: 'Notes' },
      { slug: 'b/notes', title: 'Notes' },
    ]);
    // First page registered owns 'notes' for both basename and title.
    expect(idx.tryResolve('Notes')?.slug).toBe('a/notes');
  });

  test('size() reports per-map cardinality', () => {
    const idx = new WikilinkAliasIndex(entries);
    const s = idx.size();
    // aliases: TT, team-training, training-hub, user-research
    expect(s.aliases).toBeGreaterThanOrEqual(4);
    expect(s.titles).toBe(3);
    expect(s.basenames).toBe(3);
  });
});

describe('deriveTitleFromContent', () => {
  test('returns first H1 text', () => {
    expect(deriveTitleFromContent('# Hello World\n\nbody')).toBe('Hello World');
  });
  test('skips frontmatter and finds the first H1 below', () => {
    expect(deriveTitleFromContent('---\nfoo: bar\n---\n\n# Real Title\n'))
      .toBe('Real Title');
  });
  test('strips inline markdown decoration from the heading', () => {
    expect(deriveTitleFromContent('# **My** _Title_'))
      .toBe('My Title');
  });
  test('returns undefined when there is no H1', () => {
    expect(deriveTitleFromContent('## not h1\nbody')).toBeUndefined();
  });
});

// ─── Integration: extract --source fs ──────────────────────────

describe('gbrain extract links --source fs uses alias/title fallback (TIM-28)', () => {
  test('aliased-display wikilink resolves via path when slug matches', async () => {
    await engine.putPage('10_projects/user-research/_user-research', page('User Research'));
    await engine.putPage('10_projects/team-training/_team-training', page('Team Training'));

    writeFile('10_Projects/user-research/_User-Research.md', '---\ntitle: User Research\n---\n# User Research\n');
    writeFile('10_Projects/team-training/_Team-Training.md',
      '---\ntitle: Team Training\n---\n# Team Training\n\n' +
      'See [[10_Projects/user-research/_User-Research|User Research]] for context.\n');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('10_projects/team-training/_team-training');
    const userRefs = links.filter(l => l.to_slug === '10_projects/user-research/_user-research');
    expect(userRefs.length).toBe(1);
    // PascalCase path slugifies + matches the canonical slug → 'path'.
    // The resolution_type is persisted; verify via the engine.
    const rows = await (engine as unknown as { db: { query: (s: string) => Promise<{ rows: { resolution_type: string | null }[] }> } }).db
      .query("SELECT resolution_type FROM links WHERE to_page_id = (SELECT id FROM pages WHERE slug = '10_projects/user-research/_user-research')");
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0].resolution_type).toBe('path');
  });

  test('short-form wikilink resolves via basename fallback', async () => {
    await engine.putPage('10_projects/team-assessment/_team-assessment', page('Team Assessment'));
    await engine.putPage('10_projects/foo/_foo', page('Foo'));

    writeFile('10_Projects/team-assessment/_Team-Assessment.md', '---\ntitle: Team Assessment\n---\n');
    writeFile('10_Projects/foo/_Foo.md',
      '---\ntitle: Foo\n---\nLink to [[_Team-Assessment]].\n');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('10_projects/foo/_foo');
    const hit = links.find(l => l.to_slug === '10_projects/team-assessment/_team-assessment');
    expect(hit).toBeDefined();

    const rows = await (engine as unknown as { db: { query: (s: string) => Promise<{ rows: { resolution_type: string | null }[] }> } }).db
      .query("SELECT resolution_type FROM links WHERE to_page_id = (SELECT id FROM pages WHERE slug = '10_projects/team-assessment/_team-assessment')");
    expect(rows.rows[0].resolution_type).toBe('basename');
  });

  test('frontmatter aliases resolve a renamed page', async () => {
    // Page lives at a versioned slug, but exposes the canonical name as an alias.
    await engine.putPage('30_resources/rapid-research-framework-v9', page('Rapid Research Framework v9'));
    await engine.putPage('80_archived/some-old-page', page('Old Page'));

    writeFile('30_Resources/rapid-research-framework-v9.md',
      '---\ntitle: Rapid Research Framework v9\naliases:\n  - rapid-research-framework\n  - rrf\n---\n# Rapid Research Framework v9\n');
    writeFile('80_Archived/some-old-page.md',
      '---\ntitle: Old Page\n---\n' +
      'Refers to [[rapid-research-framework]].\n');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('80_archived/some-old-page');
    const hit = links.find(l => l.to_slug === '30_resources/rapid-research-framework-v9');
    expect(hit).toBeDefined();

    const rows = await (engine as unknown as { db: { query: (s: string) => Promise<{ rows: { resolution_type: string | null }[] }> } }).db
      .query("SELECT resolution_type FROM links WHERE to_page_id = (SELECT id FROM pages WHERE slug = '30_resources/rapid-research-framework-v9')");
    expect(rows.rows[0].resolution_type).toBe('alias');
  });

  test('H1 title falls through when no alias is declared', async () => {
    await engine.putPage('30_resources/some-heading-page', page('Some Heading Page'));
    await engine.putPage('30_resources/referrer', page('Referrer'));

    writeFile('30_Resources/some-heading-page.md',
      '---\ntitle: Some Heading Page\n---\n# Cool Topic\n\nbody\n');
    writeFile('30_Resources/referrer.md',
      '---\ntitle: Referrer\n---\nSee [[Cool Topic]].\n');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('30_resources/referrer');
    const hit = links.find(l => l.to_slug === '30_resources/some-heading-page');
    expect(hit).toBeDefined();

    const rows = await (engine as unknown as { db: { query: (s: string) => Promise<{ rows: { resolution_type: string | null }[] }> } }).db
      .query("SELECT resolution_type FROM links WHERE to_page_id = (SELECT id FROM pages WHERE slug = '30_resources/some-heading-page')");
    expect(rows.rows[0].resolution_type).toBe('title');
  });

  test('a truly dangling wikilink stays dangling (no false-positive)', async () => {
    await engine.putPage('10_projects/foo/_foo', page('Foo'));

    writeFile('10_Projects/foo/_Foo.md',
      '---\ntitle: Foo\n---\nDangling [[this-page-does-not-exist]] reference.\n');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('10_projects/foo/_foo');
    expect(links.length).toBe(0);
  });
});
