import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  shouldExclude,
  deriveDomain,
  formatOrphansText,
  findOrphans,
  queryOrphanPages,
  parseUserExcludePrefixes,
  type OrphanPage,
  type OrphanResult,
} from '../src/commands/orphans.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// --- shouldExclude ---

describe('shouldExclude', () => {
  test('excludes pseudo-page _atlas', () => {
    expect(shouldExclude('_atlas')).toBe(true);
  });

  test('excludes pseudo-page _index', () => {
    expect(shouldExclude('_index')).toBe(true);
  });

  test('excludes pseudo-page _stats', () => {
    expect(shouldExclude('_stats')).toBe(true);
  });

  test('excludes pseudo-page _orphans', () => {
    expect(shouldExclude('_orphans')).toBe(true);
  });

  test('excludes pseudo-page _scratch', () => {
    expect(shouldExclude('_scratch')).toBe(true);
  });

  test('excludes pseudo-page claude', () => {
    expect(shouldExclude('claude')).toBe(true);
  });

  test('excludes auto-generated _index suffix', () => {
    expect(shouldExclude('companies/_index')).toBe(true);
    expect(shouldExclude('people/_index')).toBe(true);
  });

  test('excludes auto-generated /log suffix', () => {
    expect(shouldExclude('projects/acme/log')).toBe(true);
  });

  test('excludes raw source slugs', () => {
    expect(shouldExclude('companies/acme/raw/crustdata')).toBe(true);
  });

  test('excludes deny-prefix: output/', () => {
    expect(shouldExclude('output/2026-q1')).toBe(true);
  });

  test('excludes deny-prefix: dashboards/', () => {
    expect(shouldExclude('dashboards/metrics')).toBe(true);
  });

  test('excludes deny-prefix: scripts/', () => {
    expect(shouldExclude('scripts/ingest-runner')).toBe(true);
  });

  test('excludes deny-prefix: templates/', () => {
    expect(shouldExclude('templates/meeting-note')).toBe(true);
  });

  test('excludes deny-prefix: openclaw/config/', () => {
    expect(shouldExclude('openclaw/config/agent')).toBe(true);
  });

  test('excludes first-segment: scratch', () => {
    expect(shouldExclude('scratch/idea-dump')).toBe(true);
  });

  test('excludes first-segment: thoughts', () => {
    expect(shouldExclude('thoughts/2026-04-17')).toBe(true);
  });

  test('excludes first-segment: catalog', () => {
    expect(shouldExclude('catalog/tools')).toBe(true);
  });

  test('excludes first-segment: entities', () => {
    expect(shouldExclude('entities/product-hunt')).toBe(true);
  });

  test('does NOT exclude a normal content page', () => {
    expect(shouldExclude('companies/acme')).toBe(false);
    expect(shouldExclude('people/jane-doe')).toBe(false);
    expect(shouldExclude('projects/gbrain')).toBe(false);
  });

  test('does NOT exclude a page ending with log-like text that is not /log', () => {
    expect(shouldExclude('devlog')).toBe(false);
    expect(shouldExclude('changelog')).toBe(false);
  });
});

/**
 * `orphans.exclude_prefixes` — user-configurable additive deny list.
 *
 * The shipped DENY_PREFIXES covers gbrain-internal conventions. A
 * PARA-organized vault, an Obsidian brain with `clips/`, a code corpus
 * with `transcripts/`, etc. all leak hundreds-to-thousands of "orphans"
 * that are reference material by design. These tests pin two contracts:
 *
 *   1. The parser tolerates the formats users actually type (whitespace,
 *      trailing commas, empty entries) and rejects garbage cleanly.
 *   2. User prefixes EXTEND the shipped defaults, never replace them.
 *      An empty / unset config preserves today's behavior exactly.
 */
describe('parseUserExcludePrefixes — comma-separated config parse', () => {
  test('happy path: comma-separated prefixes round-trip in order', () => {
    expect(parseUserExcludePrefixes('resources/,transcripts/,agents/')).toEqual([
      'resources/',
      'transcripts/',
      'agents/',
    ]);
  });

  test('whitespace around commas tolerated', () => {
    expect(parseUserExcludePrefixes('resources/ , transcripts/ ,agents/')).toEqual([
      'resources/',
      'transcripts/',
      'agents/',
    ]);
  });

  test('empty entries dropped (trailing commas, doubles, leading)', () => {
    expect(parseUserExcludePrefixes('resources/,,transcripts/,')).toEqual([
      'resources/',
      'transcripts/',
    ]);
    expect(parseUserExcludePrefixes(',resources/')).toEqual(['resources/']);
  });

  test('whitespace-only entries dropped', () => {
    expect(parseUserExcludePrefixes('resources/,   ,transcripts/')).toEqual([
      'resources/',
      'transcripts/',
    ]);
  });

  test('single prefix without commas', () => {
    expect(parseUserExcludePrefixes('resources/')).toEqual(['resources/']);
  });

  test('non-string input returns empty array (number, object, null, undefined)', () => {
    expect(parseUserExcludePrefixes(42)).toEqual([]);
    expect(parseUserExcludePrefixes({ foo: 'bar' })).toEqual([]);
    expect(parseUserExcludePrefixes(null)).toEqual([]);
    expect(parseUserExcludePrefixes(undefined)).toEqual([]);
    expect(parseUserExcludePrefixes(['resources/'])).toEqual([]);
  });

  test('empty string returns empty array', () => {
    expect(parseUserExcludePrefixes('')).toEqual([]);
    expect(parseUserExcludePrefixes('   ')).toEqual([]);
    expect(parseUserExcludePrefixes(',,')).toEqual([]);
  });
});

describe('shouldExclude — additive userPrefixes contract', () => {
  test('user prefix excludes a slug that the shipped defaults do not', () => {
    expect(shouldExclude('resources/clips/some-article')).toBe(false);
    expect(shouldExclude('resources/clips/some-article', ['resources/'])).toBe(true);
  });

  test('user prefix is additive: shipped defaults still fire', () => {
    // `output/` is in DENY_PREFIXES; passing a user list does not undo it.
    expect(shouldExclude('output/2026-q1', ['resources/'])).toBe(true);
    // Pseudo-pages still excluded regardless of user list.
    expect(shouldExclude('_atlas', ['resources/'])).toBe(true);
  });

  test('multiple user prefixes all apply', () => {
    const prefixes = ['resources/', 'transcripts/', 'agents/'];
    expect(shouldExclude('resources/clips/foo', prefixes)).toBe(true);
    expect(shouldExclude('transcripts/claude-code/2026-06-15/abc', prefixes)).toBe(true);
    expect(shouldExclude('agents/zosia/state', prefixes)).toBe(true);
    expect(shouldExclude('people/jane-doe', prefixes)).toBe(false);
  });

  test('empty userPrefixes preserves baseline behavior', () => {
    // The default parameter case AND the explicit empty case must agree:
    // any slug that was includable before staying includable.
    expect(shouldExclude('resources/clips/foo')).toBe(false);
    expect(shouldExclude('resources/clips/foo', [])).toBe(false);
    expect(shouldExclude('companies/acme')).toBe(false);
    expect(shouldExclude('companies/acme', [])).toBe(false);
  });

  test('user prefix uses startsWith semantics (same as DENY_PREFIXES)', () => {
    // The match is anchored at the start of the slug, NOT a substring
    // search. A page named `resources` (singular, no trailing slash on the
    // prefix because we ended the user prefix with `/`) would not match.
    expect(shouldExclude('not-resources/blah', ['resources/'])).toBe(false);
    expect(shouldExclude('resources', ['resources/'])).toBe(false);
    expect(shouldExclude('resources/anything', ['resources/'])).toBe(true);
  });

  test('user prefix without trailing slash still matches at slug start', () => {
    // We do not enforce a trailing slash on user prefixes. A user who sets
    // `resources` (no slash) gets startsWith semantics, which means
    // `resources-of-the-realm/...` would also match. Documented behavior.
    expect(shouldExclude('resources-of-the-realm/foo', ['resources'])).toBe(true);
    expect(shouldExclude('resources/foo', ['resources'])).toBe(true);
  });
});

// --- deriveDomain ---

describe('deriveDomain', () => {
  test('uses frontmatter domain when present', () => {
    expect(deriveDomain('companies', 'companies/acme')).toBe('companies');
  });

  test('falls back to first slug segment', () => {
    expect(deriveDomain(null, 'people/jane-doe')).toBe('people');
    expect(deriveDomain(undefined, 'projects/gbrain')).toBe('projects');
  });

  test('returns root for single-segment slugs with no frontmatter', () => {
    expect(deriveDomain(null, 'readme')).toBe('readme');
  });

  test('ignores empty-string frontmatter domain', () => {
    expect(deriveDomain('', 'people/alice')).toBe('people');
  });

  test('ignores whitespace-only frontmatter domain', () => {
    expect(deriveDomain('   ', 'people/alice')).toBe('people');
  });
});

// --- formatOrphansText ---

describe('formatOrphansText', () => {
  function makeResult(orphans: OrphanPage[], overrides?: Partial<OrphanResult>): OrphanResult {
    return {
      orphans,
      total_orphans: orphans.length,
      total_linkable: orphans.length + 50,
      total_pages: orphans.length + 60,
      excluded: 10,
      ...overrides,
    };
  }

  test('shows summary line', () => {
    const result = makeResult([]);
    const out = formatOrphansText(result);
    expect(out).toContain('0 orphans out of');
    expect(out).toContain('total');
    expect(out).toContain('excluded');
  });

  test('shows "No orphan pages found." when empty', () => {
    const out = formatOrphansText(makeResult([]));
    expect(out).toContain('No orphan pages found.');
  });

  test('groups orphans by domain', () => {
    const orphans: OrphanPage[] = [
      { slug: 'companies/acme', title: 'Acme Corp', domain: 'companies' },
      { slug: 'people/alice', title: 'Alice', domain: 'people' },
      { slug: 'companies/beta', title: 'Beta Inc', domain: 'companies' },
    ];
    const out = formatOrphansText(makeResult(orphans));
    expect(out).toContain('[companies]');
    expect(out).toContain('[people]');
    // companies section should appear before people (alphabetical)
    const companiesIdx = out.indexOf('[companies]');
    const peopleIdx = out.indexOf('[people]');
    expect(companiesIdx).toBeLessThan(peopleIdx);
  });

  test('sorts orphans alphabetically within each domain group', () => {
    const orphans: OrphanPage[] = [
      { slug: 'companies/zeta', title: 'Zeta', domain: 'companies' },
      { slug: 'companies/alpha', title: 'Alpha', domain: 'companies' },
      { slug: 'companies/beta', title: 'Beta', domain: 'companies' },
    ];
    const out = formatOrphansText(makeResult(orphans));
    const alphaIdx = out.indexOf('companies/alpha');
    const betaIdx = out.indexOf('companies/beta');
    const zetaIdx = out.indexOf('companies/zeta');
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(betaIdx).toBeLessThan(zetaIdx);
  });

  test('includes slug and title in output', () => {
    const orphans: OrphanPage[] = [
      { slug: 'companies/acme', title: 'Acme Corp', domain: 'companies' },
    ];
    const out = formatOrphansText(makeResult(orphans));
    expect(out).toContain('companies/acme');
    expect(out).toContain('Acme Corp');
  });

  test('summary line shows correct numbers', () => {
    const orphans: OrphanPage[] = [
      { slug: 'a/b', title: 'B', domain: 'a' },
      { slug: 'a/c', title: 'C', domain: 'a' },
    ];
    const result: OrphanResult = {
      orphans,
      total_orphans: 2,
      total_linkable: 100,
      total_pages: 120,
      excluded: 20,
    };
    const out = formatOrphansText(result);
    expect(out).toContain('2 orphans out of 100 linkable pages (120 total; 20 excluded)');
  });
});

// ────────────────────────────────────────────────────────────────
// findOrphans + queryOrphanPages with explicit engine (v0.17 change)
// ────────────────────────────────────────────────────────────────

describe('findOrphans (engine-injected)', () => {
  let engine: PGLiteEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000); // OAuth v25 + full migration chain needs breathing room

  afterEach(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  test('returns pages with no inbound links, excluding pseudo-pages', async () => {
    // Build a tiny brain: alice links to bob. alice is an orphan (nothing
    // points to her), bob is not (alice points to him). _atlas is a pseudo
    // page that should be excluded by default.
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice works with Bob.',
      timeline: '',
    });
    await engine.putPage('people/bob', {
      type: 'person',
      title: 'Bob',
      compiled_truth: 'Bob.',
      timeline: '',
    });
    await engine.putPage('_atlas', {
      type: 'concept',
      title: 'Atlas',
      compiled_truth: 'pseudo-page',
      timeline: '',
    });
    // Create the link alice -> bob.
    await engine.addLink('people/alice', 'people/bob', 'mentioned', 'references', 'markdown');

    const result = await findOrphans(engine);

    const slugs = result.orphans.map(o => o.slug).sort();
    expect(slugs).toEqual(['people/alice']); // _atlas excluded by default; bob has a backlink
    expect(result.total_orphans).toBe(1);
    expect(result.total_pages).toBe(3);
    expect(result.excluded).toBeGreaterThanOrEqual(1); // _atlas was filtered
  });

  test('includePseudo: true surfaces pseudo-pages too', async () => {
    await engine.putPage('_atlas', {
      type: 'concept',
      title: 'Atlas',
      compiled_truth: 'pseudo',
      timeline: '',
    });

    const result = await findOrphans(engine, { includePseudo: true });

    const slugs = result.orphans.map(o => o.slug).sort();
    expect(slugs).toContain('_atlas');
  });

  test('queryOrphanPages delegates to the passed engine (no global db)', async () => {
    await engine.putPage('topic/standalone', {
      type: 'concept',
      title: 'Standalone',
      compiled_truth: 'no inbound links',
      timeline: '',
    });

    const rows = await queryOrphanPages(engine);
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('topic/standalone');
  });

  test('zero pages: empty result (no crash on empty brain)', async () => {
    const result = await findOrphans(engine);
    expect(result.orphans).toEqual([]);
    expect(result.total_orphans).toBe(0);
    expect(result.total_pages).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────
  // Soft-delete filtering on BOTH sides (v0.26.5 invariant; codex C11)
  // ────────────────────────────────────────────────────────────────

  test('REGRESSION: soft-deleted page with no inbound is NOT in orphan results', async () => {
    // Candidate-filter regression. Pre-fix, findOrphanPages returned every
    // page without inbound links — including soft-deleted ones. Now the
    // outer query filters p.deleted_at IS NULL.
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice has no inbound links and is soft-deleted.',
      timeline: '',
    });
    // Soft-delete alice directly via the DB handle (no engine method exposed).
    await (engine as any).db.query(
      `UPDATE pages SET deleted_at = now() WHERE slug = 'people/alice'`
    );

    const rows = await queryOrphanPages(engine);
    const slugs = rows.map(r => r.slug);
    expect(slugs).not.toContain('people/alice');
  });

  test('REGRESSION: live page with ONLY inbound link from soft-deleted source IS orphan (codex C11)', async () => {
    // Link-source-filter regression. Pre-fix, a live page that had ONE
    // inbound link from a soft-deleted source was hidden from orphan
    // results because the EXISTS check didn't filter the source side.
    // Now the inner JOIN filters src.deleted_at IS NULL too.
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice was soft-deleted but used to link to Bob.',
      timeline: '',
    });
    await engine.putPage('people/bob', {
      type: 'person',
      title: 'Bob',
      compiled_truth: 'Bob has no live inbound links.',
      timeline: '',
    });
    await engine.addLink('people/alice', 'people/bob', 'mentioned', 'references', 'markdown');

    // Soft-delete alice. Bob's ONLY inbound link is now from a deleted page.
    await (engine as any).db.query(
      `UPDATE pages SET deleted_at = now() WHERE slug = 'people/alice'`
    );

    const rows = await queryOrphanPages(engine);
    const slugs = rows.map(r => r.slug).sort();
    // alice is soft-deleted → not in results (candidate filter).
    // bob has no LIVE inbound link → IS in results (link-source filter — codex C11).
    expect(slugs).not.toContain('people/alice');
    expect(slugs).toContain('people/bob');
  });

  test('live page with inbound link from LIVE source is NOT orphan (regression for unchanged behavior)', async () => {
    // Sanity check: the soft-delete filter must NOT break the basic
    // "live link counts" case.
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice is live and links to Bob.',
      timeline: '',
    });
    await engine.putPage('people/bob', {
      type: 'person',
      title: 'Bob',
      compiled_truth: 'Bob has a live inbound from Alice.',
      timeline: '',
    });
    await engine.addLink('people/alice', 'people/bob', 'mentioned', 'references', 'markdown');

    const rows = await queryOrphanPages(engine);
    const slugs = rows.map(r => r.slug);
    // alice is orphan (no inbound), bob is NOT (alice links to him).
    expect(slugs).toContain('people/alice');
    expect(slugs).not.toContain('people/bob');
  });
});
