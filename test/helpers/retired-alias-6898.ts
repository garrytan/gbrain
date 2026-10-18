/**
 * Shared fixture and cases for #6898 (facts resolved to retired alias pages),
 * run on PGLite (test/entity-resolve-retired-alias-6898.test.ts) and on
 * Postgres (test/e2e/entity-resolve-retired-alias-6898-postgres.test.ts).
 * Placeholder names only.
 */
import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { resolveEntitySlug, resolveEntitySlugWithSource, resolveStrictEntityReference } from '../../src/core/entities/resolve.ts';

function page(frontmatter: Record<string, unknown>, title: string): string {
  const yaml = Object.entries({ title, ...frontmatter }).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map(item => `  - ${JSON.stringify(item)}`).join('\n')}` : `${k}: ${JSON.stringify(v)}`).join('\n');
  return `---\n${yaml}\n---\n\n# ${title}\n`;
}

const PAGES: Array<[string, Record<string, unknown>, string]> = [
  // The issue's shape: a canonical page whose title is a one-word romanized
  // name and whose aliases are slug-form spellings, plus a retired page that
  // carries the same name tokens.
  ['people/aliceexample', { type: 'person', canonical: true, aliases: ['alice-example', 'aliceexample', 'Alice'] }, 'Aliceexample'],
  ['root/people/alice-example', { type: 'concept', status: 'historical-retired-alias', canonical: false, superseded_by: 'people/aliceexample' }, 'People Alice Example'],
  // Retired with nothing to follow: no superseded_by.
  ['concepts/old-widget-example', { type: 'concept', canonical: false }, 'Old Widget Example'],
  // Retired, redirect target missing.
  ['concepts/gone-widget-example', { type: 'concept', superseded_by: 'concepts/never-written-example' }, 'Gone Widget Example'],
  // A redirect cycle.
  ['concepts/loop-a-example', { type: 'concept', superseded_by: 'concepts/loop-b-example' }, 'Loop A Example'],
  ['concepts/loop-b-example', { type: 'concept', superseded_by: '[[concepts/loop-a-example]]' }, 'Loop B Example'],
  // A two-hop chain ending on a live page, the middle hop via merged_into.
  ['concepts/chain-one-example', { type: 'concept', superseded_by: 'concepts/chain-two-example.md' }, 'Chain One Example'],
  ['concepts/chain-two-example', { type: 'concept', merged_into: 'concepts/chain-three-example' }, 'Chain Two Example'],
  ['concepts/chain-three-example', { type: 'concept' }, 'Chain Three Example'],
  // A redirect to a private page.
  ['concepts/public-alias-example', { type: 'concept', canonical: false, superseded_by: 'concepts/private-target-example' }, 'Public Alias Example'],
  ['concepts/private-target-example', { type: 'concept', visibility: 'private' }, 'Private Target Example'],
  // A retired same-name page next to nothing else: the fuzzy arm must not take it.
  ['people/root-copy/bob-example', { type: 'person', status: 'retired-alias' }, 'Bob Example'],
  // A merged company that names no target is still a record of its own.
  ['companies/merged-co-example', { type: 'company', status: 'merged' }, 'Merged Co Example'],
  // Separator folding: aliases written with spaces or underscores.
  ['people/danaexample', { type: 'person', aliases: ['Dana Example'] }, 'Danaexample'],
  ['companies/acmeco-example', { type: 'company', aliases: ['acme_example'] }, 'Acmeco Example'],
  // A person whose status is about the person, not the page, stays a candidate.
  ['people/erin-example', { type: 'person', status: 'retired' }, 'Erin Example'],
];

export async function seedRetiredAliasBrain(engine: BrainEngine): Promise<void> {
  for (const [slug, fm, title] of PAGES) await importFromContent(engine, slug, page(fm, title), { noEmbed: true });
}

export function retiredAliasCases(getEngine: () => BrainEngine): void {
  const resolve = (raw: string) => resolveEntitySlugWithSource(getEngine(), 'default', raw);

  describe('#6898 alias arm folds name separators', () => {
    test('the issue trace: people/alice-example resolves to the canonical page through its alias', async () => {
      expect(await resolve('people/alice-example')).toEqual({ slug: 'people/aliceexample', source: 'alias_exact' });
    });
    test('the display spelling Alice Example resolves to the canonical page through its alias', async () => {
      expect(await resolve('Alice Example')).toEqual({ slug: 'people/aliceexample', source: 'alias_exact' });
      expect(await resolveEntitySlug(getEngine(), 'default', 'Alice Example')).toBe('people/aliceexample');
    });
    test('hyphen, underscore and whitespace spellings meet the stored alias', async () => {
      expect(await resolve('dana-example')).toEqual({ slug: 'people/danaexample', source: 'alias_exact' });
      expect(await resolve('dana_example')).toEqual({ slug: 'people/danaexample', source: 'alias_exact' });
      expect(await resolve('Acme Example')).toEqual({ slug: 'companies/acmeco-example', source: 'alias_exact' });
      expect(await resolve('companies/acme-example')).toEqual({ slug: 'companies/acmeco-example', source: 'alias_exact' });
    });
    test('a slug-shaped reference keeps its directory: projects/acme-example never lands on the company alias', async () => {
      expect((await resolve('projects/acme-example'))?.slug).not.toBe('companies/acmeco-example');
    });
  });

  describe('#6898 exact hits on a retired page follow superseded_by or refuse', () => {
    test('the retired slug redirects to its canonical page', async () => {
      expect(await resolve('root/people/alice-example')).toEqual({ slug: 'people/aliceexample', source: 'exact_page' });
      expect(await resolveEntitySlug(getEngine(), 'default', 'root/people/alice-example')).toBe('people/aliceexample');
    });
    test('a chain through superseded_by and merged_into ends on the live page', async () => {
      expect(await resolve('concepts/chain-one-example')).toEqual({ slug: 'concepts/chain-three-example', source: 'exact_page' });
    });
    test('no redirect, a missing target or a cycle is unresolved instead of a guess', async () => {
      for (const slug of ['concepts/old-widget-example', 'concepts/gone-widget-example', 'concepts/loop-a-example']) {
        expect(await resolve(slug)).toEqual({ slug, source: 'fallback_slugify' });
        expect(await resolveEntitySlug(getEngine(), 'default', slug)).toBe(slug);
      }
    });
  });

  describe('#6898 guessing arms never pick a retired page', () => {
    test('fuzzy: a retired page that is the only same-name candidate is not taken', async () => {
      expect(await resolve('Bob Example')).toEqual({ slug: 'bob-example', source: 'fallback_slugify' });
      expect(await resolve('Old Widget Example')).toEqual({ slug: 'old-widget-example', source: 'fallback_slugify' });
    });
    test('a page whose status describes the entity stays a candidate', async () => {
      expect((await resolve('Erin Example'))?.slug).toBe('people/erin-example');
      expect(await resolve('Merged Co Example')).toEqual({ slug: 'companies/merged-co-example', source: 'fuzzy_match' });
      expect(await resolve('companies/merged-co-example')).toEqual({ slug: 'companies/merged-co-example', source: 'exact_page' });
    });
  });

  describe('#6898 strict resolver', () => {
    const strict = (raw: string, opts: { sameName?: boolean; excludePrivate?: boolean } = { sameName: true }) =>
      resolveStrictEntityReference(getEngine(), 'default', raw, opts);
    test('alias arm folds separators', async () => {
      expect(await strict('Alice Example')).toEqual({ slug: 'people/aliceexample', arm: 'alias_exact' });
      expect(await strict('people/alice-example')).toEqual({ slug: 'people/aliceexample', arm: 'alias_exact' });
    });
    test('same_name never picks a retired page', async () => {
      expect(await strict('Bob Example')).toEqual({ slug: null, miss: 'no_page' });
    });
    test('an exact retired hit follows superseded_by, or is not a fact entity', async () => {
      expect(await strict('root/people/alice-example')).toEqual({ slug: 'people/aliceexample', arm: 'exact_page' });
      expect(await strict('concepts/old-widget-example')).toEqual({ slug: null, miss: 'not_entity' });
    });
    test('a redirect is followed only to a page the caller can see', async () => {
      expect(await strict('concepts/public-alias-example')).toEqual({ slug: 'concepts/private-target-example', arm: 'exact_page' });
      expect(await strict('concepts/public-alias-example', { excludePrivate: true })).toEqual({ slug: null, miss: 'not_entity' });
    });
  });
}
