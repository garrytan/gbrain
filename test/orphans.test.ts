import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  shouldExclude,
  deriveDomain,
  formatOrphansText,
  findOrphans,
  queryOrphanPages,
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
  }, 60_000);

  afterEach(async () => {
    await engine.disconnect();
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
});
