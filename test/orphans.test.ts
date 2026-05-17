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

  test('excludes deny-prefix: navigation/', () => {
    expect(shouldExclude('navigation/ai')).toBe(true);
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
      total_pages: orphans.length + 60,
      ...overrides,
    };
  }

  test('shows summary line', () => {
    const result = makeResult([]);
    const out = formatOrphansText(result);
    expect(out).toContain('0 islanded pages out of');
    expect(out).toContain('total');
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
      total_pages: 120,
    };
    const out = formatOrphansText(result);
    expect(out).toContain('2 islanded pages out of 120 total');
  });
});

// ────────────────────────────────────────────────────────────────
// findOrphans + queryOrphanPages with explicit engine (v0.17 change)
// ────────────────────────────────────────────────────────────────

describe('findOrphans (engine-injected, islanded semantics)', () => {
  let engine: PGLiteEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000); // OAuth v25 + full migration chain needs breathing room

  afterEach(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  test('returns islanded pages — neither alice (outbound-only) nor bob (inbound-only) qualify', async () => {
    // Under islanded semantics (v0.33+ step-4 alignment) "orphan" means
    // no in AND no out. alice→bob makes alice a hub (has outbound, fine)
    // and bob a leaf (has inbound, fine). Neither is islanded.
    // carol is a true islanded page — added to confirm at least one
    // result so we're testing for inclusion, not just emptiness.
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
    await engine.putPage('people/carol', {
      type: 'person',
      title: 'Carol',
      compiled_truth: 'Carol — no links to or from her.',
      timeline: '',
    });
    await engine.addLink('people/alice', 'people/bob', 'mentioned', 'references', 'markdown');

    const result = await findOrphans(engine);

    const slugs = result.orphans.map(o => o.slug).sort();
    expect(slugs).toEqual(['people/carol']);
    expect(result.total_orphans).toBe(1);
    expect(result.total_pages).toBe(3);
  });

  test('outbound-only hub is NOT counted as orphan', async () => {
    await engine.putPage('hub/index', {
      type: 'concept',
      title: 'Index Hub',
      compiled_truth: 'Links out to many.',
      timeline: '',
    });
    await engine.putPage('leaf/one', {
      type: 'concept',
      title: 'Leaf One',
      compiled_truth: 'A leaf.',
      timeline: '',
    });
    await engine.addLink('hub/index', 'leaf/one', 'references', 'references', 'markdown');

    const result = await findOrphans(engine);

    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).not.toContain('hub/index'); // has outbound — not islanded
    expect(slugs).not.toContain('leaf/one'); // has inbound — not islanded
    expect(result.total_orphans).toBe(0);
  });

  test('soft-deleted page is excluded from orphan count (and row still exists with deleted_at)', async () => {
    await engine.putPage('topic/will-delete', {
      type: 'concept',
      title: 'Soon Deleted',
      compiled_truth: 'islanded, then soft-deleted',
      timeline: '',
    });
    const sd = await engine.softDeletePage('topic/will-delete');
    expect(sd).not.toBeNull();

    // Verify the row is actually soft-deleted (not hard-deleted) — the
    // predicate's `deleted_at IS NULL` clause is what does the exclusion.
    // Defensive check: codex post-impl flagged that prior fixture used
    // hard-delete and tests would pass even with deleted_at predicate
    // removed. Probe directly.
    const { rows } = await (engine as unknown as { db: { query: (s: string) => Promise<{ rows: Array<{ deleted_at: unknown }> }> } })
      .db.query("SELECT deleted_at FROM pages WHERE slug = 'topic/will-delete'");
    expect(rows.length).toBe(1);
    expect(rows[0].deleted_at).not.toBeNull();

    const result = await findOrphans(engine);
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).not.toContain('topic/will-delete');
  });

  test.each([
    ['_atlas'],
    ['_index'],
    ['claude'],
    ['emails/2026-05-01-foo'],
    ['attachments/abc'],
    ['0-daily/2026-05-17'],
    ['4-archive/old-notes'],
    ['templates/meeting-note'],
    ['navigation/ai'],
    ['output/2026-q1'],
    ['dashboards/metrics'],
    ['scripts/ingest-runner'],
    ['openclaw/config/agent'],
    ['scratch/idea'],
    ['thoughts/2026-04-17'],
    ['catalog/tools'],
    ['entities/product-hunt'],
    ['some/page/_index'], // suffix /_index — note the LIKE escape on _
    ['projects/acme/log'], // suffix /log
    ['companies/acme/raw/crustdata'], // contains /raw/
  ])('SQL excludes %s when islanded (default mode)', async (slug) => {
    await engine.putPage(slug, {
      type: 'concept',
      title: slug,
      compiled_truth: 'islanded test fixture',
      timeline: '',
    });
    const result = await findOrphans(engine);
    expect(result.orphans.map(o => o.slug)).not.toContain(slug);
  });

  test('LIKE escape: bare _index is excluded (exact), but /_zindex is NOT excluded by the suffix pattern', async () => {
    // Defensive: '%/#_index' ESCAPE '#' must match LITERAL '_index'.
    // Without the escape, the bare '_' wildcard would also match
    // '/_zindex' which is wrong. Build both fixtures and verify.
    await engine.putPage('weird/_zindex', { type: 'concept', title: 'Weird zindex', compiled_truth: 'islanded', timeline: '' });
    // also seed a 2nd page so weird/_zindex is islanded (and not the only row)
    await engine.putPage('weird/something-else', { type: 'concept', title: 'Other', compiled_truth: 'islanded', timeline: '' });

    const result = await findOrphans(engine);
    const slugs = result.orphans.map(o => o.slug);
    // weird/_zindex is NOT '/_index' suffix; should pass through as islanded
    expect(slugs).toContain('weird/_zindex');
  });

  test('includePseudo=true surfaces pseudo slugs but only if they are islanded', async () => {
    await engine.putPage('_atlas', {
      type: 'concept',
      title: 'Atlas',
      compiled_truth: 'pseudo (islanded)',
      timeline: '',
    });
    await engine.putPage('_index', {
      type: 'concept',
      title: 'Index',
      compiled_truth: 'pseudo with outbound',
      timeline: '',
    });
    await engine.putPage('topic/real', {
      type: 'concept',
      title: 'Real Topic',
      compiled_truth: 'pseudo target',
      timeline: '',
    });
    await engine.addLink('_index', 'topic/real', 'references', 'references', 'markdown');

    const result = await findOrphans(engine, { includePseudo: true });
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).toContain('_atlas'); // pseudo, islanded — surfaced
    expect(slugs).not.toContain('_index'); // pseudo but has outbound — still not islanded
  });

  test('CRITICAL: findOrphans count equals getHealth.orphan_pages (alignment regression)', async () => {
    // The headline guarantee of v0.33+ step-4 alignment: the two surfaces
    // share an SQL predicate, so their counts must match by construction.
    // Mix islanded + non-islanded + soft-deleted + excluded-prefix pages
    // to make the assertion meaningful.
    await engine.putPage('people/islanded-1', { type: 'person', title: 'Islanded 1', compiled_truth: 'lone', timeline: '' });
    await engine.putPage('people/islanded-2', { type: 'person', title: 'Islanded 2', compiled_truth: 'lone', timeline: '' });
    await engine.putPage('people/hub', { type: 'person', title: 'Hub', compiled_truth: 'has outbound', timeline: '' });
    await engine.putPage('people/leaf', { type: 'person', title: 'Leaf', compiled_truth: 'has inbound', timeline: '' });
    await engine.addLink('people/hub', 'people/leaf', 'references', 'references', 'markdown');
    await engine.putPage('emails/excluded-by-prefix', { type: 'concept', title: 'Excluded', compiled_truth: 'source-type', timeline: '' });
    await engine.putPage('people/soft-delete-me', { type: 'person', title: 'To soft-delete', compiled_truth: 'will be hidden', timeline: '' });
    await engine.softDeletePage('people/soft-delete-me');

    const findResult = await findOrphans(engine);
    const health = await engine.getHealth();

    expect(findResult.total_orphans).toBe(health.orphan_pages);
    // also sanity-check we counted the two real islanded pages
    expect(findResult.total_orphans).toBe(2);
  });

  test('queryOrphanPages still returns no-inbound rows (unchanged contract)', async () => {
    // v0.33+ step-4: queryOrphanPages stays on findOrphanPages for
    // enrichment-pattern consumers. It returns ALL no-inbound pages
    // (including hubs with outbound), which is the right semantic for
    // "candidates needing inbound links".
    await engine.putPage('topic/standalone', {
      type: 'concept',
      title: 'Standalone',
      compiled_truth: 'no inbound links',
      timeline: '',
    });
    await engine.putPage('topic/hub', {
      type: 'concept',
      title: 'Hub',
      compiled_truth: 'outbound only',
      timeline: '',
    });
    await engine.addLink('topic/hub', 'topic/standalone', 'references', 'references', 'markdown');

    const rows = await queryOrphanPages(engine);
    const slugs = rows.map(r => r.slug);
    // topic/hub has no inbound — included.
    // topic/standalone has inbound from hub — excluded.
    expect(slugs).toContain('topic/hub');
    expect(slugs).not.toContain('topic/standalone');
  });

  test('zero pages: empty result (no crash on empty brain)', async () => {
    const result = await findOrphans(engine);
    expect(result.orphans).toEqual([]);
    expect(result.total_orphans).toBe(0);
    expect(result.total_pages).toBe(0);
  });
});
