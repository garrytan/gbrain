/**
 * v0.36 — dream-cycle `infer_links` phase tests.
 *
 * Pins:
 *   - Generic-domain emails (gmail/yahoo/etc.) do NOT emit links
 *   - Corporate-domain emails emit [[companies/<label>]] (subdomain stripped)
 *   - Compound-country TLDs (.com.ky / .co.uk) emit the company label, not the TLD
 *   - current_company/at_company plain strings get wrapped as wikilinks
 *   - Already-wrapped pages are no-ops (idempotency)
 *   - Soft-deleted pages (deleted_at NOT NULL) are skipped
 *   - Missing target slugs surface as links_unresolved, NEVER auto-stub
 *   - dryRun honored: counters tick, no DB writes
 *   - Regression set: 5 extractor-drift cohorts must not produce wrong links
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runPhaseInferLinks,
  domainToCompanySlug,
  companyNameToSlug,
} from '../src/core/cycle/phases/infer-links.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM pages`);
});

async function seedPage(
  slug: string,
  frontmatter: Record<string, unknown> = {},
  opts: { deleted?: boolean; type?: string; compiledTruth?: string } = {},
): Promise<number> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title, frontmatter, compiled_truth, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      slug,
      opts.type ?? (slug.startsWith('people/') ? 'person' : slug.startsWith('companies/') ? 'company' : 'concept'),
      slug.split('/').pop(),
      JSON.stringify(frontmatter),
      opts.compiledTruth ?? `# ${slug}`,
      opts.deleted ? new Date().toISOString() : null,
    ],
  );
  const r = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return r[0].id;
}

async function getFrontmatter(slug: string): Promise<Record<string, unknown>> {
  const r = await engine.executeRaw<{ frontmatter: Record<string, unknown> | null }>(
    `SELECT frontmatter FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return r[0]?.frontmatter ?? {};
}

// ───────────────────────────── pure helpers ─────────────────────────────

describe('domainToCompanySlug', () => {
  test('generic providers return null', () => {
    expect(domainToCompanySlug('me@gmail.com')).toBeNull();
    expect(domainToCompanySlug('foo@yahoo.com')).toBeNull();
    expect(domainToCompanySlug('bar@protonmail.com')).toBeNull();
    expect(domainToCompanySlug('me@icloud.com')).toBeNull();
    expect(domainToCompanySlug('me@duck.com')).toBeNull();
  });

  test('corporate domain → companies/<label>', () => {
    expect(domainToCompanySlug('founder@anthropic.com')).toBe('companies/anthropic');
    expect(domainToCompanySlug('pm@stripe.com')).toBe('companies/stripe');
  });

  test('subdomain stripped', () => {
    expect(domainToCompanySlug('user@mail.stripe.com')).toBe('companies/stripe');
    expect(domainToCompanySlug('foo@api.acme.co')).toBe('companies/acme');
  });

  test('compound country TLDs handled', () => {
    expect(domainToCompanySlug('counsel@careyolsen.com.ky')).toBe('companies/careyolsen');
    expect(domainToCompanySlug('partner@walkersglobal.co.uk')).toBe('companies/walkersglobal');
  });

  test('bare domain (no @) works', () => {
    expect(domainToCompanySlug('anthropic.com')).toBe('companies/anthropic');
  });

  test('garbage input returns null', () => {
    expect(domainToCompanySlug('')).toBeNull();
    expect(domainToCompanySlug('not-an-email')).toBeNull();
    expect(domainToCompanySlug('@@@')).toBeNull();
  });
});

describe('companyNameToSlug', () => {
  test('plain display name → kebab slug', () => {
    expect(companyNameToSlug('Sober Grid')).toBe('companies/sober-grid');
    expect(companyNameToSlug('Carey Olsen')).toBe('companies/carey-olsen');
  });

  test('strips punctuation', () => {
    expect(companyNameToSlug('Foo, Inc.')).toBe('companies/foo-inc');
  });

  test('empty/whitespace → null', () => {
    expect(companyNameToSlug('')).toBeNull();
    expect(companyNameToSlug('   ')).toBeNull();
  });
});

// ─────────────────────────────── phase tests ───────────────────────────────

describe('runPhaseInferLinks', () => {
  test('email + existing target → emits email_domain wikilink', async () => {
    await seedPage('companies/anthropic', {});
    await seedPage('people/test-person', { email: 'pm@anthropic.com' });

    const r = await runPhaseInferLinks(engine, {});
    expect(r.status).toBe('ok');
    expect(r.details.links_inferred).toBe(1);
    expect(r.details.links_unresolved).toBe(0);

    const fm = await getFrontmatter('people/test-person');
    expect(fm.email).toBe('pm@anthropic.com');
    expect(fm.email_domain).toBe('[[companies/anthropic]]');
  });

  test('generic email domain → no link, no unresolved counter', async () => {
    await seedPage('people/gmail-person', { email: 'someone@gmail.com' });

    const r = await runPhaseInferLinks(engine, {});
    expect(r.details.links_inferred).toBe(0);
    expect(r.details.links_unresolved).toBe(0);

    const fm = await getFrontmatter('people/gmail-person');
    expect(fm.email_domain).toBeUndefined();
  });

  test('current_company plain string → wikilink wrap', async () => {
    await seedPage('companies/sober-grid', {});
    await seedPage('people/beau-mann', { current_company: 'Sober Grid' });

    const r = await runPhaseInferLinks(engine, {});
    expect(r.details.links_inferred).toBe(1);

    const fm = await getFrontmatter('people/beau-mann');
    expect(fm.current_company).toBe('[[companies/sober-grid]]');
  });

  test('idempotent: already-wrapped page is a no-op', async () => {
    await seedPage('companies/anthropic', {});
    await seedPage('people/already-linked', {
      email: 'pm@anthropic.com',
      email_domain: '[[companies/anthropic]]',
    });

    const r = await runPhaseInferLinks(engine, {});
    expect(r.details.links_inferred).toBe(0);
    expect(r.details.pages_updated).toBe(0);
  });

  test('soft-deleted page skipped', async () => {
    await seedPage('companies/anthropic', {});
    await seedPage('people/deleted-person', { email: 'pm@anthropic.com' }, { deleted: true });

    const r = await runPhaseInferLinks(engine, {});
    expect(r.details.links_inferred).toBe(0);
    expect(r.details.pages_scanned).toBe(0);
  });

  test('missing target slug → links_unresolved increments, no stub created', async () => {
    await seedPage('people/orphan-link', { email: 'pm@nonexistent-co.com' });

    const r = await runPhaseInferLinks(engine, {});
    expect(r.details.links_inferred).toBe(0);
    expect(r.details.links_unresolved).toBe(1);

    // Verify no stub was created.
    const stubs = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE slug = 'companies/nonexistent-co'`,
    );
    expect(stubs.length).toBe(0);
  });

  test('dryRun: counters tick, no DB writes', async () => {
    await seedPage('companies/anthropic', {});
    await seedPage('people/dryrun-test', { email: 'pm@anthropic.com' });

    const r = await runPhaseInferLinks(engine, { dryRun: true });
    expect(r.details.dryRun).toBe(true);
    expect(r.details.links_inferred).toBe(1);

    const fm = await getFrontmatter('people/dryrun-test');
    expect(fm.email_domain).toBeUndefined();
  });

  test('subdomain rule: mail.stripe.com → companies/stripe', async () => {
    await seedPage('companies/stripe', {});
    await seedPage('people/subdomain-test', { email: 'user@mail.stripe.com' });

    const r = await runPhaseInferLinks(engine, {});
    expect(r.details.links_inferred).toBe(1);

    const fm = await getFrontmatter('people/subdomain-test');
    expect(fm.email_domain).toBe('[[companies/stripe]]');
  });

  describe('array-valued frontmatter (companies / firms)', () => {
    test('companies: ["display name"] → element wrapped when target exists', async () => {
      await seedPage('companies/hash-directors', {});
      await seedPage('people/anoop-array', { companies: ['Hash Directors'] });

      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(1);

      const fm = await getFrontmatter('people/anoop-array');
      expect(fm.companies).toEqual(['[[companies/hash-directors]]']);
    });

    test('companies: [slug-shaped string] → prepends companies/ then wraps', async () => {
      await seedPage('companies/hash-directors', {});
      await seedPage('people/anoop-slug-shape', { companies: ['hash-directors'] });

      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(1);

      const fm = await getFrontmatter('people/anoop-slug-shape');
      expect(fm.companies).toEqual(['[[companies/hash-directors]]']);
    });

    test('companies: mixed resolvable + missing — wraps resolvable, leaves missing as plain string', async () => {
      await seedPage('companies/hash-directors', {});
      // companies/dapprly does NOT exist
      await seedPage('people/mixed-arr', { companies: ['Hash Directors', 'Dapprly'] });

      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(1);
      expect(r.details.links_unresolved).toBe(1);

      const fm = await getFrontmatter('people/mixed-arr');
      expect(fm.companies).toEqual(['[[companies/hash-directors]]', 'Dapprly']);
    });

    test('companies: all-wrapped → idempotent no-op', async () => {
      await seedPage('companies/hash-directors', {});
      await seedPage('people/already-arr', { companies: ['[[companies/hash-directors]]'] });

      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(0);
      expect(r.details.pages_updated).toBe(0);
    });

    test('firms: [...] also handled', async () => {
      await seedPage('companies/walkers', {});
      await seedPage('people/firms-test', { firms: ['Walkers'] });

      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(1);

      const fm = await getFrontmatter('people/firms-test');
      expect(fm.firms).toEqual(['[[companies/walkers]]']);
    });
  });

  // ─── Regression cohorts (extractor-drift catalog 2026-05-21) ───
  describe('regression — extractor-drift cohorts must not produce wrong links', () => {
    test('cohort: Reana → Rena (single-token first-name slug must not match)', async () => {
      // If a Reana-derived person ends up with current_company "Rena",
      // companyNameToSlug produces companies/rena. With no companies/rena
      // page seeded, the result must be unresolved, NOT a wrong link.
      await seedPage('people/reana-person', { current_company: 'Rena' });
      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(0);
      expect(r.details.links_unresolved).toBe(1);
    });

    test('cohort: Marfire mentioned as a pool/firm string does not auto-link to a person', async () => {
      // Marfire is a competitor/firm, not a person. A page with hash_owner: "Marfire"
      // (wrong extraction) should not emit a people/marfire link.
      await seedPage('companies/some-co', { hash_owner: 'Marfire' });
      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(0);
      expect(r.details.links_unresolved).toBe(1);
    });

    test('cohort: hash_owner resolves only when person page exists', async () => {
      await seedPage('people/petri-basson', {});
      await seedPage('companies/test-firm', { hash_owner: 'petri-basson' });
      const r = await runPhaseInferLinks(engine, {});
      expect(r.details.links_inferred).toBe(1);
      const fm = await getFrontmatter('companies/test-firm');
      expect(fm.hash_owner).toBe('[[people/petri-basson]]');
    });
  });
});
