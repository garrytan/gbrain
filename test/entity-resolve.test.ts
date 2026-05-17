import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveEntitySlug,
  slugify,
  getPrefixExpansionDirs,
  DEFAULT_PREFIX_EXPANSION_DIRS,
} from '../src/core/entities/resolve.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * v0.34.5 — entity resolution prefix expansion tests.
 *
 * Validates that bare first names resolve to existing pages via prefix
 * expansion, preventing phantom stub creation.
 *
 * Privacy: all seed data uses canonical placeholders per CLAUDE.md
 * "Privacy rule: scrub real names from public docs" — alice-example,
 * bob-example, charlie-example, dave-example, acme-example. The
 * bug being fixed is name-agnostic; slugify('Alice') exercises the
 * same path that slugify('Jared') did pre-fix.
 *
 * Coverage matrix per plan mossy-popping-crown.md D5:
 *   - prefix expansion happy path (single + multi candidate)
 *   - tiebreak via connection_count DESC, slug ASC
 *   - companies/ prefix
 *   - links contribution to connection_count (not just chunks)
 *   - identical connection_count → slug ASC fallback
 *   - source-id isolation
 *   - config-driven dirs (entities.prefix_expansion_dirs)
 *   - integration regression: stub-guard → backstop → DB row, no markdown file
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();

  // Seed test pages. Two variants per first name so the tiebreak
  // path has real candidates to choose between.
  const pages = [
    { slug: 'people/alice-example',           title: 'Alice Example',           type: 'person' },
    { slug: 'people/charlie-example',         title: 'Charlie Example',         type: 'person' },
    { slug: 'people/charlie-ross-example',    title: 'Charlie Ross Example',    type: 'person' },
    { slug: 'people/bob-example',             title: 'Bob Example',             type: 'person' },
    { slug: 'people/bob-bankman-example',     title: 'Bob Bankman Example',     type: 'person' },
    { slug: 'people/dave-example',            title: 'Dave Example',            type: 'person' },
    { slug: 'companies/acme-example',         title: 'Acme Example',            type: 'company' },
    { slug: 'companies/acme-atlas-example',   title: 'Acme Atlas Example',      type: 'company' },
    // Links-only candidate (no chunks) — exercises the links contribution
    // to connection_count.
    { slug: 'people/eve-example',             title: 'Eve Example',             type: 'person' },
    { slug: 'people/eve-friend-example',      title: 'Eve Friend Example',      type: 'person' },
    // Tiebreak candidates with identical connection counts — exercises
    // the deterministic slug ASC secondary sort.
    { slug: 'people/frank-aaa-example',       title: 'Frank Aaa Example',       type: 'person' },
    { slug: 'people/frank-zzz-example',       title: 'Frank Zzz Example',       type: 'person' },
    // Custom-dir candidate for config-driven test (`funds`).
    { slug: 'funds/founders-x-example',       title: 'Founders X Example',      type: 'concept' },
    // Exact-prefix-match coverage (no hyphen suffix): `companies/glob` and
    // `concepts/rag` are the canonical shape codex flagged the resolver
    // would miss in its post-D9 review pass.
    { slug: 'companies/glob',                 title: 'Glob',                    type: 'company' },
    { slug: 'concepts/rag',                   title: 'RAG',                     type: 'concept' },
  ];

  for (const p of pages) {
    await engine.putPage(p.slug, {
      type: p.type as any,
      title: p.title,
      compiled_truth: `# ${p.title}`,
      frontmatter: { type: p.type, title: p.title, slug: p.slug },
    }, { sourceId: 'default' });
  }

  // Give alice-example 10 chunks — exercises the single-best-match path.
  await seedChunks(engine, 'people/alice-example', 10);
  // bob-example > bob-bankman-example — tiebreak via chunk count.
  await seedChunks(engine, 'people/bob-example', 20);
  await seedChunks(engine, 'people/bob-bankman-example', 3);
  // charlie-example > charlie-ross-example.
  await seedChunks(engine, 'people/charlie-example', 15);
  await seedChunks(engine, 'people/charlie-ross-example', 2);
  // acme-example > acme-atlas-example.
  await seedChunks(engine, 'companies/acme-example', 8);
  await seedChunks(engine, 'companies/acme-atlas-example', 1);
  // dave-example: single companion match, low chunks.
  await seedChunks(engine, 'people/dave-example', 4);

  // Links-only contribution: eve-example wins via inbound links rather
  // than chunks. The UNIQUE constraint on (from_page_id, to_page_id,
  // link_type, link_source, origin_page_id) means each (from, to, type)
  // pair allows at most 4 distinct rows (link_source: markdown/frontmatter/
  // manual/NULL). Seed multiple from-pages so eve accumulates enough
  // inbound links to beat eve-friend-example deterministically.
  const eve = await pageId(engine, 'people/eve-example');
  const alice = await pageId(engine, 'people/alice-example');
  const charlie = await pageId(engine, 'people/charlie-example');
  const dave = await pageId(engine, 'people/dave-example');
  const eveFriend = await pageId(engine, 'people/eve-friend-example');
  if (eve && alice && charlie && dave) {
    const sources: Array<string | null> = ['markdown', 'frontmatter', 'manual', null];
    for (const from of [alice, charlie, dave]) {
      for (const ls of sources) {
        await engine.executeRaw(
          `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
           VALUES ($1, $2, 'mentions', $3)
           ON CONFLICT DO NOTHING`,
          [from, eve, ls],
        );
      }
    }
  }
  // Eve-friend gets exactly one inbound link so it's a clear loser.
  if (eveFriend && alice) {
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       VALUES ($1, $2, 'mentions', 'markdown')
       ON CONFLICT DO NOTHING`,
      [alice, eveFriend],
    );
  }

  // Identical-count tiebreak: frank-aaa-example and frank-zzz-example
  // each get 5 chunks. The resolver should deterministically pick
  // frank-aaa-example (ASC).
  await seedChunks(engine, 'people/frank-aaa-example', 5);
  await seedChunks(engine, 'people/frank-zzz-example', 5);

  // funds candidate gets 3 chunks so the config-driven test has data to match.
  await seedChunks(engine, 'funds/founders-x-example', 3);

  // Source-isolation setup: create a sibling source and put `people/alice-example`
  // there too with WAY more chunks. The resolver in source 'default' must
  // still return `people/alice-example` (the default's row), NOT leak to
  // the high-chunk row in the other source.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('other-src', 'other-src', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [],
  );
  await engine.putPage('people/alice-example', {
    type: 'person' as any,
    title: 'Alice (other source)',
    compiled_truth: `# Alice in other source`,
    frontmatter: { type: 'person', title: 'Alice (other source)', slug: 'people/alice-example' },
  }, { sourceId: 'other-src' });
  await seedChunks(engine, 'people/alice-example', 50, 'other-src');
  // Sanity: put a name only in other-src so it must NOT resolve in default.
  await engine.putPage('people/grace-other-example', {
    type: 'person' as any,
    title: 'Grace (other source only)',
    compiled_truth: `# Grace only in other source`,
    frontmatter: { type: 'person', title: 'Grace (other source only)', slug: 'people/grace-other-example' },
  }, { sourceId: 'other-src' });
  await seedChunks(engine, 'people/grace-other-example', 20, 'other-src');
});

afterAll(async () => {
  await engine.disconnect();
});

async function seedChunks(eng: PGLiteEngine, slug: string, count: number, sourceId = 'default'): Promise<void> {
  const rows = await eng.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  if (rows.length === 0) return;
  const pid = rows[0].id;
  for (let i = 0; i < count; i++) {
    await eng.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (page_id, chunk_index) DO NOTHING`,
      [pid, i, `Chunk ${i} about ${slug}`],
    );
  }
}

async function pageId(eng: PGLiteEngine, slug: string, sourceId = 'default'): Promise<string | null> {
  const rows = await eng.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
    [slug, sourceId],
  );
  return rows[0]?.id ?? null;
}

describe('resolveEntitySlug — prefix expansion (v0.34.5)', () => {
  it('fuzzy title match wins over prefix expansion when no bare slug exists (round-22 P2)', async () => {
    // Codex round-22 P2: when a bare token is the TITLE of one
    // entity (e.g. "Liz" on people/elizabeth-example) AND also a
    // slug prefix of another (people/liz-smith), the resolver
    // previously routed via prefix expansion → people/liz-smith
    // (wrong; user meant Liz=Elizabeth). Fix: bare-name prefix
    // expansion only short-circuits exact/fuzzy when there's a
    // STUB-shaped bare slug to override. With no bare slug at all,
    // fuzzy runs first.
    await engine.putPage(
      'people/elizabeth-fuzzy-example',
      {
        type: 'person' as any,
        title: 'Liz',
        compiled_truth: '# Liz (Elizabeth)',
        frontmatter: { type: 'person', title: 'Liz', slug: 'people/elizabeth-fuzzy-example' },
      },
      { sourceId: 'default' },
    );
    await seedChunks(engine, 'people/elizabeth-fuzzy-example', 50);
    await engine.putPage(
      'people/liz-smith-example',
      {
        type: 'person' as any,
        title: 'Liz Smith',
        compiled_truth: '# Liz Smith',
        frontmatter: { type: 'person', title: 'Liz Smith', slug: 'people/liz-smith-example' },
      },
      { sourceId: 'default' },
    );
    await seedChunks(engine, 'people/liz-smith-example', 5);

    // "Liz" should fuzzy-match the title and return elizabeth, NOT
    // prefix-expand to liz-smith.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Liz');
    expect(result).toBe('people/elizabeth-fuzzy-example');
  });

  it('prefers prefix expansion over an existing STUB-shaped unprefixed phantom (round-7 P2)', async () => {
    // Codex round-7 P2 #1: when both the canonical `people/alice-example`
    // AND an unprefixed STUB phantom `alice` exist, resolveEntitySlug
    // must return the canonical, NOT exact-match the phantom and keep
    // splitting facts onto it.
    await engine.putPage(
      'alice-phantom-test',
      {
        type: 'concept' as any,
        title: 'alice-phantom-test',
        compiled_truth: '# alice-phantom-test',
        frontmatter: { type: 'concept', title: 'alice-phantom-test', slug: 'alice-phantom-test' },
      },
      { sourceId: 'default' },
    );
    // The seed `people/alice-example` already exists from beforeAll.
    // resolveEntitySlug('alice') must return the canonical, not the
    // bare slug.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'alice');
    expect(result).toBe('people/alice-example');
  });

  it('returns a real bare page for capitalized input without fuzzy/prefix detours (round-25 P2)', async () => {
    // Codex round-25 P2: when pg_trgm is unavailable and the input
    // is a capitalized real-bare-page name (`Alice` with `alice` real
    // page), the old code fell through to fuzzy (null on no pg_trgm)
    // then catch-all prefix expansion → people/alice-* (wrong; user
    // meant the bare `alice` page). The fix returns the token NOW
    // when bareBody is real (non-stub).
    const realBody = '# Realbare\n\nIntentional top-level page with prose.';
    await engine.putPage(
      'realbare',
      {
        type: 'concept' as any,
        title: 'Realbare',
        compiled_truth: realBody,
        frontmatter: { type: 'concept', title: 'Realbare', slug: 'realbare' },
      },
      { sourceId: 'default' },
    );
    await engine.putPage(
      'people/realbare-other-example',
      {
        type: 'person' as any,
        title: 'Realbare Other Example',
        compiled_truth: '# Realbare Other',
        frontmatter: { type: 'person', title: 'Realbare Other Example', slug: 'people/realbare-other-example' },
      },
      { sourceId: 'default' },
    );
    await seedChunks(engine, 'people/realbare-other-example', 50);

    // Capitalized single-word bare name `Realbare`. isBareName→true,
    // slugify('Realbare')→'realbare'. The bare `realbare` page exists
    // and is real (non-stub). Must return 'realbare' from step 1
    // directly — without bouncing through fuzzy/catch-all prefix
    // expansion that could mis-route to people/realbare-*.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Realbare');
    expect(result).toBe('realbare');
  });

  it('preserves a bare page whose content lives in the timeline column (round-18 P2)', async () => {
    // Codex round-18 P2: tryExactSlugBody must look at BOTH
    // compiled_truth AND timeline when deciding whether a bare slug
    // is real or stub-shaped. A real page with stubby
    // compiled_truth + populated pages.timeline column would
    // previously look stub-shaped and get overridden by prefix
    // expansion.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
       VALUES ('default', 'tl-only-page', 'concept', 'markdown', 'TL Only Page', '# TL Only Page',
               '- 2026-04-01: First milestone\n- 2026-05-01: Second milestone',
               $1::jsonb, 'h', now())
       ON CONFLICT (source_id, slug) DO UPDATE SET timeline = EXCLUDED.timeline`,
      [JSON.stringify({ type: 'concept', title: 'TL Only Page', slug: 'tl-only-page' })],
    );
    await engine.putPage(
      'concepts/tl-only-page-canonical',
      {
        type: 'concept' as any,
        title: 'TL Only Page Canonical',
        compiled_truth: '# canonical',
        frontmatter: { type: 'concept', title: 'TL Only Page Canonical', slug: 'concepts/tl-only-page-canonical' },
      },
      { sourceId: 'default' },
    );
    // The bare slug exists with a timeline-column body, so the
    // resolver must NOT override to the canonical.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'tl-only-page');
    expect(result).toBe('tl-only-page');
  });

  it('preserves a TERSE real top-level page (one sentence) (round-11 P2)', async () => {
    // Codex round-11 P2: a 50-char threshold misclassifies terse but
    // intentional pages (e.g. `# RAG` + a one-sentence note). The
    // fix is threshold = 0 — only the literal stub shape (frontmatter
    // + H1 + maybe an empty fence) is a stub. Any user content beyond
    // that, however short, makes the page real.
    await engine.putPage(
      'rag-terse',
      {
        type: 'concept' as any,
        title: 'RAG Terse',
        compiled_truth: '# RAG Terse\n\nLook it up.',
        frontmatter: { type: 'concept', title: 'RAG Terse', slug: 'rag-terse' },
      },
      { sourceId: 'default' },
    );
    await engine.putPage(
      'concepts/rag-terse-example',
      {
        type: 'concept' as any,
        title: 'RAG Terse Example',
        compiled_truth: '# RAG Terse Example',
        frontmatter: { type: 'concept', title: 'RAG Terse Example', slug: 'concepts/rag-terse-example' },
      },
      { sourceId: 'default' },
    );
    // The 10-char "Look it up." should be enough to keep the bare
    // page intact even with the canonical candidate present.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'rag-terse');
    expect(result).toBe('rag-terse');
  });

  it('preserves exact bare-slug match for a REAL top-level page (round-8 P2 #2)', async () => {
    // Codex round-8 P2 #2: when a user has a legitimate top-level
    // `rag-real` page with real body content AND a `concepts/rag-real`
    // prefixed page, the bare `rag-real` must NOT be overridden by
    // prefix expansion. The bare page is intentional, not a phantom.
    const realBody = '# RAG Real\n\nThis is a real top-level page with intentional content. '.repeat(20);
    await engine.putPage(
      'rag-real',
      {
        type: 'concept' as any,
        title: 'RAG Real',
        compiled_truth: realBody,
        frontmatter: { type: 'concept', title: 'RAG Real', slug: 'rag-real' },
      },
      { sourceId: 'default' },
    );
    await engine.putPage(
      'concepts/rag-real-example',
      {
        type: 'concept' as any,
        title: 'RAG Real Example',
        compiled_truth: '# RAG Real Example',
        frontmatter: { type: 'concept', title: 'RAG Real Example', slug: 'concepts/rag-real-example' },
      },
      { sourceId: 'default' },
    );
    // resolveEntitySlug('rag-real') must NOT redirect to concepts/...
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'rag-real');
    expect(result).toBe('rag-real');
  });

  it('resolves "Alice" to people/alice-example', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Alice');
    expect(result).toBe('people/alice-example');
  });

  it('resolves "alice" (lowercase) to people/alice-example', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'alice');
    expect(result).toBe('people/alice-example');
  });

  it('resolves "Charlie" to people/charlie-example (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Charlie');
    expect(result).toBe('people/charlie-example');
  });

  it('resolves "Bob" to people/bob-example (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Bob');
    expect(result).toBe('people/bob-example');
  });

  it('resolves "Dave" to people/dave-example (single match)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Dave');
    expect(result).toBe('people/dave-example');
  });

  it('falls through to slugify for unknown names', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Zyxwvut');
    expect(result).toBe('zyxwvut');
  });

  it('exact match still works for fully-qualified slugs', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people/alice-example');
    expect(result).toBe('people/alice-example');
  });

  it('multi-word input does NOT trigger prefix expansion', async () => {
    // "Alice Example" should go through fuzzy match, not prefix expansion
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Alice Example');
    // Should resolve via fuzzy match to the same page
    expect(result).toContain('alice-example');
  });

  it('hyphenated input does NOT trigger prefix expansion', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'alice-example');
    expect(result).toBe('people/alice-example');
  });

  it('returns null for empty input', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', '');
    expect(result).toBeNull();
  });
});

describe('resolveEntitySlug — additional coverage (D5)', () => {
  it('expands bare "Acme" to companies/acme-example via the companies/ directory', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Acme');
    expect(result).toBe('companies/acme-example');
  });

  it('uses inbound + outbound link counts (not just chunks) for connection_count', async () => {
    // eve-example has many inbound links + zero chunks; eve-friend-example
    // has one inbound link + zero chunks. The winner is whichever the
    // connection_count expression scores higher, and that scoring HAS
    // to consider links or eve-example would tie eve-friend-example.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Eve');
    expect(result).toBe('people/eve-example');
  });

  it('breaks identical-count ties deterministically via slug ASC', async () => {
    // frank-aaa-example and frank-zzz-example both have exactly 5
    // chunks and 0 links. Tiebreak is slug ASC → "aaa" wins.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Frank');
    expect(result).toBe('people/frank-aaa-example');
  });

  it('matches exact prefix slug (no hyphen suffix) — companies/glob', async () => {
    // Codex review post-D9: prefix expansion previously only matched
    // `<dir>/<token>-%` and missed canonical slugs like `companies/glob`
    // or `people/alice`. The fix also matches `<dir>/<token>` exactly.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Glob');
    expect(result).toBe('companies/glob');
  });

  it('resolves bare concept names via the default concepts/ directory', async () => {
    // Codex review post-D9: `concepts/` is documented everywhere and
    // the default `type: concept` home, but the original default dir
    // list omitted it.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'RAG');
    expect(result).toBe('concepts/rag');
  });

  it('scopes prefix expansion to the requested source_id', async () => {
    // people/alice-example exists in BOTH 'default' (10 chunks) and
    // 'other-src' (50 chunks). Resolving "Alice" in 'default' must
    // return default's row, not leak to other-src's higher-chunk row.
    // If the SQL ever drops `WHERE p.source_id = $1`, the high-chunk
    // other-src row would win the tiebreak — this test pins that.
    const defaultResult = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Alice');
    expect(defaultResult).toBe('people/alice-example');

    // "Grace" only exists in other-src. Resolving in 'default' must
    // fall through to slugify, NOT find the other-src row.
    const defaultGrace = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Grace');
    expect(defaultGrace).toBe('grace');

    // And in other-src, Grace resolves cleanly.
    const otherGrace = await resolveEntitySlug(engine as unknown as BrainEngine, 'other-src', 'Grace');
    expect(otherGrace).toBe('people/grace-other-example');
  });
});

describe('getPrefixExpansionDirs — config-driven (D2)', () => {
  it('returns DEFAULT_PREFIX_EXPANSION_DIRS when no config exists', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-prefix-default-'));
    try {
      const dirs = await withEnv({ GBRAIN_HOME: tmpHome }, () => getPrefixExpansionDirs());
      expect(dirs).toEqual([...DEFAULT_PREFIX_EXPANSION_DIRS]);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('default dir list includes concepts/ for concept entity resolution', async () => {
    expect(DEFAULT_PREFIX_EXPANSION_DIRS).toContain('concepts');
    expect([...DEFAULT_PREFIX_EXPANSION_DIRS]).toEqual([
      'people',
      'companies',
      'deals',
      'topics',
      'concepts',
    ]);
  });

  it('honors entities.prefix_expansion_dirs config override', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-prefix-custom-'));
    try {
      // GBRAIN_HOME=<tmp> → config lives at <tmp>/.gbrain/config.json.
      const cfgDir = join(tmpHome, '.gbrain');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          entities: { prefix_expansion_dirs: ['funds', 'people'] },
        }),
        'utf-8',
      );
      const dirs = await withEnv({ GBRAIN_HOME: tmpHome }, () => getPrefixExpansionDirs());
      expect(dirs).toEqual(['funds', 'people']);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when config override is empty or malformed', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-prefix-bad-'));
    try {
      const cfgDir = join(tmpHome, '.gbrain');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          entities: { prefix_expansion_dirs: [123, '', null] }, // all bad
        }),
        'utf-8',
      );
      const dirs = await withEnv({ GBRAIN_HOME: tmpHome }, () => getPrefixExpansionDirs());
      expect(dirs).toEqual([...DEFAULT_PREFIX_EXPANSION_DIRS]);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('resolves through a custom funds/ directory when configured', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-prefix-funds-'));
    try {
      const cfgDir = join(tmpHome, '.gbrain');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          entities: { prefix_expansion_dirs: ['funds'] },
        }),
        'utf-8',
      );
      const result = await withEnv({ GBRAIN_HOME: tmpHome }, () =>
        resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Founders'),
      );
      expect(result).toBe('funds/founders-x-example');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('stub-guard + backstop integration (D5 regression — IRON RULE)', () => {
  it('writeFactsToFence refuses to stub-create an unprefixed slug; backstop drops fact + audits to JSONL', async () => {
    // Regression for the literal bug class this PR fixes. When
    // resolveEntitySlug falls through to slugify("Zander") → "zander"
    // (no matching page, no prefix), writeFactsToFence must NOT create
    // a phantom `zander.md`. Instead it returns stubGuardBlocked: true
    // so the caller (backstop) logs + audits + skips.
    //
    // The pre-codex-review version of this PR inserted these facts into
    // the DB to avoid silent data loss, but that produced
    // legacy-shape rows (row_num NULL + entity_slug NOT NULL) that
    // trip the v0.32.2 extract_facts reconciliation guard. The fix is
    // to NOT insert and instead write a structured audit entry to
    // ~/.gbrain/facts.dropped.jsonl for operator recovery.
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-stub-guard-'));
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-stub-'));
    try {
      // Codex round-5 P2: writeFactsToFence acquires page-locks under
      // `gbrainPath('page-locks')`. Without GBRAIN_HOME isolation the
      // test writes lockfiles into the developer's real ~/.gbrain and
      // fails in hermetic / read-only-home runners with EPERM.
      const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        writeFactsToFence(
          engine as unknown as BrainEngine,
          { sourceId: 'default', localPath: brainDir, slug: 'zander' },
          [
            {
              fact: 'Zander likes integration tests.',
              kind: 'fact' as const,
              notability: 'medium' as const,
              source: 'test:regression',
              visibility: 'private' as const,
              embedding: null,
              sessionId: null,
            },
          ],
        ),
      );

      // The guard fired.
      expect(result.stubGuardBlocked).toBe(true);
      expect(result.inserted).toBe(0);
      expect(result.ids).toEqual([]);

      // No phantom markdown file was created at the brain root.
      expect(existsSync(join(brainDir, 'zander.md'))).toBe(false);

      // Simulate the backstop's fallback under a controlled GBRAIN_HOME
      // so the JSONL lands in the tempdir and not the real brain.
      const { appendDroppedFactAudit } = await import('../src/core/facts/dropped-audit.ts');
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        appendDroppedFactAudit({
          source_id: 'default',
          phantom_slug: 'zander',
          reason: 'stub_guard_blocked',
          fact: 'Zander likes integration tests.',
          kind: 'fact',
          notability: 'medium',
          visibility: 'private',
          source: 'test:regression',
          source_session: null,
        });
      });

      // The fact is NOT in the DB — this is the v0.32.2 reconciliation
      // guard fix. Previous regression test asserted the OPPOSITE; this
      // updated assertion pins the codex P1 fix.
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM facts WHERE source_id = 'default' AND fact = 'Zander likes integration tests.'`,
        [],
      );
      expect(rows.length).toBe(0);

      // No legacy-shape rows produced by this code path.
      const legacyRows = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM facts WHERE row_num IS NULL AND entity_slug = 'zander'`,
        [],
      );
      expect(legacyRows[0].n).toBe(0);

      // The audit log captured the fact for operator recovery.
      const auditPath = join(gbrainHome, '.gbrain', 'facts.dropped.jsonl');
      expect(existsSync(auditPath)).toBe(true);
      const auditLines = readFileSync(auditPath, 'utf-8').trim().split('\n');
      expect(auditLines.length).toBe(1);
      const entry = JSON.parse(auditLines[0]);
      expect(entry.phantom_slug).toBe('zander');
      expect(entry.reason).toBe('stub_guard_blocked');
      expect(entry.fact).toBe('Zander likes integration tests.');
      expect(entry.kind).toBe('fact');
      expect(entry.notability).toBe('medium');

      // And no markdown file.
      expect(existsSync(join(brainDir, 'zander.md'))).toBe(false);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });

  it('writeFactsToFence blocks appends to an existing stub-shaped phantom file (round-24 P2)', async () => {
    // Codex round-24 P2: a pre-v0.34.5 phantom file on disk would
    // previously slip past the stub-guard because the guard only
    // fired on missing files. New facts kept appending to the
    // phantom, growing the split.
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-existing-phantom-'));
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-existing-phantom-home-'));
    try {
      // Seed a stub-shaped phantom file on disk (no machine fence yet).
      const phantomFile = join(brainDir, 'zoltan-phantom.md');
      writeFileSync(
        phantomFile,
        '---\ntype: person\ntitle: zoltan-phantom\nslug: zoltan-phantom\n---\n\n# zoltan-phantom\n',
        'utf-8',
      );

      const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        writeFactsToFence(
          engine as unknown as BrainEngine,
          { sourceId: 'default', localPath: brainDir, slug: 'zoltan-phantom' },
          [
            {
              fact: 'A fact about Zoltan.',
              kind: 'fact' as const,
              notability: 'medium' as const,
              source: 'test:regression',
              visibility: 'private' as const,
              embedding: null,
              sessionId: null,
            },
          ],
        ),
      );

      // Stub-guard fired, no insert.
      expect(result.stubGuardBlocked).toBe(true);
      expect(result.inserted).toBe(0);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });

  it('writeFactsToFence materializes a real DB-only unprefixed page instead of firing stub-guard (round-18 P1)', async () => {
    // Codex round-18 P1: when an unprefixed slug has a real DB body
    // (put_page MCP created it on a source with local_path but never
    // synced to disk), writeFactsToFence must NOT fire the stub-
    // guard and drop the fact. Instead it should materialize the DB
    // body to disk, then append the fence — preserving both the
    // existing page content AND the new fact.
    const realBody = '# Real Bare Page\n\nThis is real content that must be preserved.';
    await engine.putPage(
      'real-bare-page',
      {
        type: 'concept' as any,
        title: 'Real Bare Page',
        compiled_truth: realBody,
        frontmatter: { type: 'concept', title: 'Real Bare Page', slug: 'real-bare-page' },
      },
      { sourceId: 'default' },
    );
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-stub-guard-real-'));
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-stub-guard-real-home-'));
    try {
      // The bare-slug .md file does NOT exist on disk pre-call.
      expect(existsSync(join(brainDir, 'real-bare-page.md'))).toBe(false);

      const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        writeFactsToFence(
          engine as unknown as BrainEngine,
          { sourceId: 'default', localPath: brainDir, slug: 'real-bare-page' },
          [
            {
              fact: 'A fact about the real bare page.',
              kind: 'fact' as const,
              notability: 'medium' as const,
              source: 'test:regression',
              visibility: 'private' as const,
              embedding: null,
              sessionId: null,
            },
          ],
        ),
      );

      // No stub-guard fire; fact inserted.
      expect(result.stubGuardBlocked).toBeUndefined();
      expect(result.inserted).toBe(1);

      // Markdown file now exists at the bare path WITH the real body + the fence.
      const filePath = join(brainDir, 'real-bare-page.md');
      expect(existsSync(filePath)).toBe(true);
      const onDisk = readFileSync(filePath, 'utf-8');
      expect(onDisk).toContain('This is real content that must be preserved.');
      expect(onDisk).toContain('A fact about the real bare page.');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });

  it('writeFactsToFence DOES create the page when the slug has a directory prefix', async () => {
    // Inverse coverage: confirm the guard ONLY fires on unprefixed slugs.
    // A `people/yvonne-example` write should land normally.
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-stub-guard-ok-'));
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-stub-guard-ok-home-'));
    try {
      // GBRAIN_HOME isolation per codex round-5 P2 (page-locks).
      const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        writeFactsToFence(
          engine as unknown as BrainEngine,
          { sourceId: 'default', localPath: brainDir, slug: 'people/yvonne-example' },
          [
            {
              fact: 'Yvonne likes prefixed slugs.',
              kind: 'fact' as const,
              notability: 'medium' as const,
              source: 'test:regression',
              visibility: 'private' as const,
              embedding: null,
              sessionId: null,
            },
          ],
        ),
      );

      // No guard fire; row inserted.
      expect(result.stubGuardBlocked).toBeUndefined();
      expect(result.inserted).toBe(1);
      expect(result.ids.length).toBe(1);

      // Markdown file exists at the prefixed path.
      expect(existsSync(join(brainDir, 'people/yvonne-example.md'))).toBe(true);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Alice Example')).toBe('alice-example');
  });

  it('handles single word', () => {
    expect(slugify('Alice')).toBe('alice');
  });

  it('strips accents', () => {
    expect(slugify('José García')).toBe('jose-garcia');
  });
});
