/**
 * BrainEngine parity: the ranking-stage reads hybrid search runs after fusion
 * (engine-sql/search-reads.ts) and the onboarding counts
 * (engine-sql/health.ts countOnboardSignal).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read returns the same answer on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts): supersede probe and slugs, alias canonical
 *    refs, collapse facts, bare-slug suffix lookup, generated pages, live page
 *    ids, ranking links, SQL cosines and the six onboarding counts.
 *  - Regression: an engine whose supersede, alias, collapse, demotion or
 *    cosine read drifts gives a different hybridSearch ranking per backend;
 *    a drifted count gives a different onboarding nudge.
 *  - Why existing coverage misses it: the search tests run these reads on
 *    PGLite only, through hybridSearch, and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw). Page, chunk and link ids
 *    are serial and engine-dependent (PGLite also skips ids), so every case
 *    maps ids back to slugs before it returns. Seeded chunks go through
 *    sealChunks, so the text projection is sealed.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { archiveSource, basisEmbedding, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

async function put(engine: BrainEngine, slug: string, extra: Record<string, unknown> = {}, opts?: { sourceId?: string }) {
  const type = slug.startsWith('people/') ? 'person' : slug.startsWith('companies/') ? 'company' : 'note';
  return engine.putPage(slug, { type, title: slug, compiled_truth: `Page ${slug}.`, timeline: '', ...extra } as never, opts);
}

/** Page id → slug for the pages a case wrote (ids never leave the arm). */
function slugsOf(pages: Array<{ id: number; slug: string }>) {
  const byId = new Map(pages.map(p => [Number(p.id), p.slug]));
  return (ids: Iterable<number>) => sorted([...ids].map(id => byId.get(Number(id)) ?? `unknown:${id}`));
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

describe('engine parity: search reads', () => {
  parityTest(
    'hasSupersedeEdges and supersedingPageSlugs: same-source live superseder only, policy scoped',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'hasSupersedeEdges', 'supersedingPageSlugs'] },
    async (engine, backend) => {
      const before = await engine.hasSupersedeEdges();
      await createSource(engine, backend, 'other');
      const pages = [
        await put(engine, 'notes/canon'), await put(engine, 'notes/stale'),
        await put(engine, 'notes/gone-canon'), await put(engine, 'notes/orphaned'),
        await put(engine, 'notes/plain'),
      ];
      await put(engine, 'notes/canon', {}, { sourceId: 'other' });
      await engine.addLink('notes/canon', 'notes/stale', '', 'supersedes', 'manual');
      await engine.addLink('notes/gone-canon', 'notes/orphaned', '', 'supersedes', 'manual');
      await engine.addLink('notes/canon', 'notes/plain', '', 'mentions', 'manual');
      await engine.softDeletePage('notes/gone-canon');
      const name = slugsOf(pages);
      const ids = pages.map(p => p.id);
      const view = (m: Map<number, string>) => sorted([...m].map(([id, by]) => `${name([id])[0]}<${by}`));
      const after = await engine.hasSupersedeEdges();
      const open = view(await engine.supersedingPageSlugs(ids));
      const scoped = view(await engine.supersedingPageSlugs(ids, { sourceId: 'default' }));
      const elsewhere = view(await engine.supersedingPageSlugs(ids, { sourceId: 'other' }));
      const none = view(await engine.supersedingPageSlugs([]));
      expect(before).toBe(false);
      expect(after).toBe(true);
      expect(open).toEqual(['notes/stale<notes/canon']);
      expect(scoped).toEqual(open);
      expect(elsewhere).toEqual([]);
      return { before, after, open, scoped, elsewhere, none };
    },
  );

  parityTest(
    'aliasCanonicalRefs: the refs a rename made canonical, per source and policy',
    { methods: ['putPage', 'updateSlug', 'aliasCanonicalRefs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await put(engine, 'concepts/before');
      await engine.updateSlug('concepts/before', 'concepts/after');
      await put(engine, 'concepts/unaliased');
      await put(engine, 'concepts/after', {}, { sourceId: 'other' });
      const refs = [
        { slug: 'concepts/after', source_id: 'default' }, { slug: 'concepts/unaliased', source_id: 'default' },
        { slug: 'concepts/after', source_id: 'other' }, { slug: 'concepts/before', source_id: 'default' },
      ];
      const key = (rows: Array<{ source_id: string; canonical_slug: string }>) => sorted(rows.map(r => `${r.source_id}::${r.canonical_slug}`));
      const open = key(await engine.aliasCanonicalRefs(refs));
      const scoped = key(await engine.aliasCanonicalRefs(refs, { sourceIds: ['default'] }));
      const elsewhere = key(await engine.aliasCanonicalRefs(refs, { sourceId: 'other' }));
      const empty = key(await engine.aliasCanonicalRefs([]));
      expect(open).toEqual(['default::concepts/after']);
      return { open, scoped, elsewhere, empty };
    },
  );

  parityTest(
    'aliasCanonicalRefs: a policy reads only live pages the caller may see; no policy reads every page row',
    { methods: ['putPage', 'updateSlug', 'softDeletePage', 'aliasCanonicalRefs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'arch');
      for (const slug of ['c/open', 'c/private', 'c/gone', 'c/quiet', 'c/aliased-priv']) {
        await put(engine, `${slug}-old`);
        await engine.updateSlug(`${slug}-old`, slug);
      }
      await put(engine, 'c/away-old', {}, { sourceId: 'arch' });
      await engine.updateSlug('c/away-old', 'c/away', { sourceId: 'arch' });
      await put(engine, 'c/private', { frontmatter: { visibility: 'private' } });
      await put(engine, 'c/aliased-priv', { frontmatter: { access: 'private' } });
      await put(engine, 'c/quiet', { frontmatter: { quarantine: { reason: 'test' } } });
      await engine.softDeletePage('c/gone');
      await put(engine, 'c/plain');
      const refs = [
        { slug: 'c/quiet', source_id: 'default' }, { slug: 'c/open', source_id: 'default' },
        { slug: 'c/private', source_id: 'default' }, { slug: 'c/gone', source_id: 'default' },
        { slug: 'c/plain', source_id: 'default' }, { slug: 'c/away', source_id: 'arch' },
        { slug: 'c/open', source_id: 'default' }, { slug: 'c/open-old', source_id: 'default' },
        { slug: 'c/aliased-priv', source_id: 'default' }, { slug: 'c/away', source_id: 'default' },
      ];
      const key = (rows: Array<{ source_id: string; canonical_slug: string }>) => sorted(rows.map(r => `${r.source_id}::${r.canonical_slug}`));
      const raw = await engine.aliasCanonicalRefs(refs);
      const types = sorted(raw.map(r => Object.entries(r).map(([k, v]) => `${k}:${typeof v}`).sort().join(',')));
      const open = key(raw);
      const live = key(await engine.aliasCanonicalRefs(refs, { sourceIds: [] }));
      const hidden = key(await engine.aliasCanonicalRefs(refs, { excludePrivate: true }));
      // Hybrid search passes its whole option bag; keys the SQL does not read change nothing.
      const bag = key(await engine.aliasCanonicalRefs(refs, { excludePrivate: true, limit: 5, requireSafeChunks: true, sourceId: 'default' } as never));
      const federated = key(await engine.aliasCanonicalRefs(refs, { sourceIds: ['arch', 'nowhere'], sourceId: 'default' }));
      await archiveSource(engine, backend, 'arch');
      const archivedOpen = key(await engine.aliasCanonicalRefs(refs));
      const archivedLive = key(await engine.aliasCanonicalRefs(refs, { sourceId: 'arch' }));
      expect(open).toEqual(['arch::c/away', 'default::c/aliased-priv', 'default::c/gone', 'default::c/open', 'default::c/private', 'default::c/quiet']);
      expect(live).toEqual(['arch::c/away', 'default::c/aliased-priv', 'default::c/open', 'default::c/private']);
      expect(hidden).not.toContain('default::c/private');
      expect(federated).toEqual(['arch::c/away']);
      expect(archivedOpen).toEqual(open);
      expect(archivedLive).toEqual([]);
      return { types, open, live, hidden, bag, federated, archivedOpen, archivedLive };
    },
  );

  parityTest(
    'resolveAliases: excludePrivate hides the aliases of private pages, as hybrid search passes it',
    { methods: ['putPage', 'setPageAliases', 'resolveAliases'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await put(engine, 'people/open', { title: 'Open One' });
      await put(engine, 'people/hidden', { title: 'Hidden One', frontmatter: { visibility: 'private' } });
      await put(engine, 'people/by-access', { title: 'Access One', frontmatter: { access: 'private' } });
      await put(engine, 'people/elsewhere', { title: 'Elsewhere' }, { sourceId: 'other' });
      await engine.setPageAliases('people/open', 'default', ['shared name', 'open alias']);
      await engine.setPageAliases('people/hidden', 'default', ['shared name', 'hidden alias']);
      await engine.setPageAliases('people/by-access', 'default', ['access alias']);
      await engine.setPageAliases('people/elsewhere', 'other', ['shared name']);
      const names = ['shared name', 'open alias', 'hidden alias', 'access alias'];
      const flat = (m: Map<string, Array<{ slug: string; source_id: string }>>) => [...m].map(([k, v]) => `${k} -> ${v.map(r => `${r.source_id}:${r.slug}`).join(', ')}`);
      const none = flat(await engine.resolveAliases(names));
      const off = flat(await engine.resolveAliases(names, { excludePrivate: false }));
      const hidden = flat(await engine.resolveAliases(names, { excludePrivate: true }));
      // Hybrid search passes its source scope with excludePrivate, and a bag that may carry requireSafeChunks.
      const scoped = flat(await engine.resolveAliases(names, { sourceId: 'default', excludePrivate: true, requireSafeChunks: true }));
      const federated = flat(await engine.resolveAliases(names, { sourceIds: ['default', 'other'], excludePrivate: true }));
      // The alias hop hands over its whole identity-tier bag: the slug excludes and the hop switches change nothing here.
      const hop = flat(await engine.resolveAliases(names, { sourceId: 'default', excludePrivate: true, excludeSlugPrefixes: ['test/', 'attachments/'], excludeSlugs: ['people/open'], tokenHop: true, qualified: true } as never));
      expect(off).toEqual(none);
      expect(none).toEqual([
        'access alias -> default:people/by-access',
        'hidden alias -> default:people/hidden',
        'open alias -> default:people/open',
        'shared name -> default:people/hidden, default:people/open, other:people/elsewhere',
      ]);
      expect(hidden).toEqual(['open alias -> default:people/open', 'shared name -> default:people/open, other:people/elsewhere']);
      expect(scoped).toEqual(['open alias -> default:people/open', 'shared name -> default:people/open']);
      expect(federated).toEqual(hidden);
      expect(hop).toEqual(scoped);
      return { none, off, hidden, scoped, federated, hop };
    },
  );

  // The Rust store has no writer for derived alias rows yet, so this case stops on that typed refusal there; the store's own
  // test (rust/crates/gbrain-store/src/aliases.rs) covers the same shadow rule.
  parityTest(
    'resolveAliases: a private page titled like a derived alias shadows it only for a caller that may read the page',
    { methods: ['putPage', 'replaceDerivedAliases', 'resolveAliases'] },
    async (engine) => {
      await put(engine, 'companies/acme', { title: 'Acme Co' });
      await put(engine, 'companies/beta', { title: 'Beta Co' });
      await put(engine, 'notes/acme-title', { title: 'Acme', frontmatter: { visibility: 'private' } });
      await put(engine, 'notes/beta-title', { title: 'Beta' });
      await engine.replaceDerivedAliases('companies/acme', 'default', [{ alias_norm: 'acme', origin: 'declared', case_sensitive: false, alias_text: 'Acme' }]);
      await engine.replaceDerivedAliases('companies/beta', 'default', [{ alias_norm: 'beta', origin: 'declared', case_sensitive: false, alias_text: 'Beta' }]);
      const flat = (m: Map<string, Array<{ slug: string; source_id: string }>>) => [...m].map(([k, v]) => `${k} -> ${v.map(r => `${r.source_id}:${r.slug}`).join(', ')}`);
      const none = flat(await engine.resolveAliases(['acme', 'beta']));
      const hidden = flat(await engine.resolveAliases(['acme', 'beta'], { excludePrivate: true }));
      // Both derived aliases yield to a page titled with their name; the private "Acme" title is not visible under excludePrivate.
      expect(none).toEqual([]);
      expect(hidden).toEqual(['acme -> default:companies/acme']);
      return { none, hidden };
    },
  );

  parityTest(
    'pageCollapseFacts: every page row answers by id, any source or deletion, with text-cast frontmatter and code-point bounds',
    { methods: ['putPage', 'softDeletePage', 'pageCollapseFacts'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const body = `  ${'é'.repeat(230)}\u{1F600}  `;
      const pages = [
        await put(engine, 'notes/numeric', { frontmatter: { redirect_to: '   ', redirect: 7, merged_into: 'notes/t' } }),
        await put(engine, 'notes/re', { compiled_truth: '\tlead ', frontmatter: { status: 'Re-Redirected', superseded_by: ' notes/s ' } }, { sourceId: 'other' }),
        await put(engine, 'notes/aliased', { compiled_truth: body, frontmatter: { status: 'aliased', superseded_by: 'notes/s' } }),
        await put(engine, 'notes/alias-x', { frontmatter: { status: 'alias-x', superseded_by: 'notes/s', merged_into: { slug: 'x' } } }),
        await put(engine, 'notes/gone', { compiled_truth: body }),
        await put(engine, 'notes/empty-status', { frontmatter: { status: null, redirect: '', superseded_by: 'notes/s' } }),
      ];
      await engine.softDeletePage('notes/gone');
      const name = slugsOf(pages);
      const ids = pages.map(p => p.id);
      const byName = (slug: string) => pages.find(p => p.slug === slug)!.id;
      const bodyIds = [byName('notes/re'), byName('notes/aliased'), byName('notes/gone')];
      const rows = await engine.pageCollapseFacts([...ids, ids[0]!, 2_000_000_000], bodyIds);
      const view = sorted(rows.map(r => ({
        slug: name([r.id])[0], idType: typeof r.id, target: r.target, body_chars: r.body_chars === null ? null : Number(r.body_chars),
        body: r.body, lead: r.lead,
      })), r => r.slug!);
      expect(view.map(r => r.slug)).toEqual(['notes/alias-x', 'notes/aliased', 'notes/empty-status', 'notes/gone', 'notes/numeric', 'notes/re']);
      expect(view.find(r => r.slug === 'notes/numeric')!.target).toBe('7');
      expect(view.find(r => r.slug === 'notes/aliased')).toMatchObject({ target: null, body_chars: 231 });
      expect(view.find(r => r.slug === 'notes/gone')!.body).toBe(view.find(r => r.slug === 'notes/aliased')!.body);
      return { view, unbodied: (await engine.pageCollapseFacts(ids, [])).map(r => r.lead) };
    },
  );

  parityTest(
    'pageCollapseFacts: redirect target, bounded body length, md5 of a substantial body and its lead',
    { methods: ['putPage', 'pageCollapseFacts'] },
    async (engine) => {
      const long = 'shared document body '.repeat(20).trim();
      const pages = [
        await put(engine, 'notes/redirect', { frontmatter: { redirect_to: ' notes/target ' } }),
        await put(engine, 'notes/merged', { frontmatter: { merged_into: 'notes/target' } }),
        await put(engine, 'notes/status-alias', { frontmatter: { status: 'Alias', superseded_by: 'notes/target' } }),
        await put(engine, 'notes/status-other', { frontmatter: { status: 'draft', superseded_by: 'notes/target' } }),
        await put(engine, 'notes/long-a', { compiled_truth: long }),
        await put(engine, 'notes/long-b', { compiled_truth: long }),
        await put(engine, 'notes/short', { compiled_truth: 'tiny' }),
      ];
      const name = slugsOf(pages);
      const bodyIds = pages.filter(p => p.slug !== 'notes/redirect').map(p => p.id);
      const rows = await engine.pageCollapseFacts(pages.map(p => p.id), bodyIds);
      const view = sorted(rows.map(r => ({
        slug: name([r.id])[0], target: r.target, body_chars: r.body_chars === null ? null : Number(r.body_chars),
        body: r.body, lead: r.lead,
      })), r => r.slug!);
      const a = view.find(r => r.slug === 'notes/long-a')!;
      expect(a.body).not.toBeNull();
      expect(a.body).toBe(view.find(r => r.slug === 'notes/long-b')!.body);
      expect(view.find(r => r.slug === 'notes/short')!.body).toBeNull();
      expect(view.find(r => r.slug === 'notes/redirect')).toMatchObject({ target: 'notes/target', lead: null });
      expect(view.find(r => r.slug === 'notes/status-other')!.target).toBeNull();
      return { view, missing: await engine.pageCollapseFacts([], []) };
    },
  );

  parityTest(
    'slugsEndingIn: live slugs equal to or ending in /word, LIKE-escaped, at most two',
    { methods: ['putPage', 'softDeletePage', 'slugsEndingIn'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      for (const slug of ['people/widget', 'companies/widget', 'notes/widget', 'widget', 'notes/a_b', 'notes/axb', 'notes/gone']) await put(engine, slug);
      await put(engine, 'notes/solo', {}, { sourceId: 'other' });
      await engine.softDeletePage('notes/gone');
      const many = (await engine.slugsEndingIn('default', 'widget')).length;
      const escaped = sorted(await engine.slugsEndingIn('default', 'a_b'));
      const deleted = await engine.slugsEndingIn('default', 'gone');
      const otherSource = await engine.slugsEndingIn('default', 'solo');
      const own = await engine.slugsEndingIn('other', 'solo');
      expect(many).toBe(2);
      expect(escaped).toEqual(['notes/a_b']);
      return { many, escaped, deleted, otherSource, own };
    },
  );

  parityTest(
    'generatedPagesIn, livePageIdsAt and pagesLinkingTo: the generated-page demotion reads',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'generatedPagesIn', 'livePageIdsAt', 'pagesLinkingTo'] },
    async (engine) => {
      const pages = [
        await put(engine, 'people/alice-example'),
        await put(engine, 'notes/dream', { frontmatter: { dream_generated: true }, compiled_truth: 'dream body' }),
        await put(engine, 'notes/receipt', { type: 'extract_receipt' }),
        await put(engine, 'notes/human'),
        await put(engine, 'notes/linker'),
        await put(engine, 'notes/gone'),
      ];
      await engine.addLink('notes/linker', 'people/alice-example', 'mentions alice', 'mentions', 'manual');
      await engine.addLink('notes/human', 'notes/linker', '', 'mentions', 'manual');
      await engine.softDeletePage('notes/gone');
      const name = slugsOf(pages);
      const id = (slug: string) => pages.find(p => p.slug === slug)!.id;
      const generated = sorted((await engine.generatedPagesIn(pages.map(p => p.id))).map(r => ({
        slug: name([r.id])[0], dream: (r.frontmatter as Record<string, unknown> | null)?.dream_generated ?? null, compiled_truth: r.compiled_truth,
      })), r => r.slug!);
      const live = name(await engine.livePageIdsAt([
        { slug: 'people/alice-example', source_id: 'default' }, { slug: 'notes/gone', source_id: 'default' },
        { slug: 'notes/missing', source_id: 'default' }, { slug: 'people/alice-example', source_id: 'other' },
      ]));
      const linking = name(await engine.pagesLinkingTo(pages.map(p => p.id), [id('people/alice-example')]));
      expect(generated.map(g => g.slug)).toEqual(['notes/dream', 'notes/receipt']);
      expect(live).toEqual(['people/alice-example']);
      expect(linking).toEqual(['notes/linker']);
      return { generated, live, linking };
    },
  );

  parityTest(
    'slugsEndingIn: case-sensitive literal suffix after a slash, whole-slug match, exact source, restored pages',
    { methods: ['putPage', 'softDeletePage', 'restorePage', 'slugsEndingIn'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      for (const slug of ['notes/widget', 'archive/notes/widget', 'notes/a-b', 'notes/back', 'notes/idget-not']) await put(engine, slug);
      await engine.softDeletePage('notes/back');
      const whileDeleted = await engine.slugsEndingIn('default', 'back');
      await engine.restorePage('notes/back');
      const out = {
        twoExact: sorted(await engine.slugsEndingIn('default', 'widget')),
        withSlash: sorted(await engine.slugsEndingIn('default', 'notes/widget')),
        noSlash: await engine.slugsEndingIn('default', 'idget'),
        upper: await engine.slugsEndingIn('default', 'WIDGET'),
        percent: await engine.slugsEndingIn('default', 'a%b'),
        underscore: await engine.slugsEndingIn('default', 'a_b'),
        backslash: await engine.slugsEndingIn('default', 'a\\b'),
        empty: await engine.slugsEndingIn('default', ''),
        whileDeleted,
        restored: await engine.slugsEndingIn('default', 'back'),
        sourcePrefix: await engine.slugsEndingIn('oth', 'widget'),
        unknownSource: await engine.slugsEndingIn('nowhere', 'widget'),
      };
      expect(out.twoExact).toEqual(['archive/notes/widget', 'notes/widget']);
      expect(out.withSlash).toEqual(['archive/notes/widget', 'notes/widget']);
      expect(out.restored).toEqual(['notes/back']);
      return out;
    },
  );

  parityTest(
    'generatedPagesIn: soft-deleted and other-source pages count, a JSON true or the text "true" at the top level only',
    { methods: ['putPage', 'softDeletePage', 'generatedPagesIn'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const pages = [
        await put(engine, 'notes/dream-bool', { frontmatter: { dream_generated: true, topic: 'a' }, compiled_truth: 'bool body' }),
        await put(engine, 'notes/dream-text', { frontmatter: { dream_generated: 'true' } }),
        await put(engine, 'notes/dream-false', { frontmatter: { dream_generated: false } }),
        await put(engine, 'notes/dream-upper', { frontmatter: { dream_generated: 'TRUE' } }),
        await put(engine, 'notes/dream-one', { frontmatter: { dream_generated: 1 } }),
        await put(engine, 'notes/dream-nested', { frontmatter: { meta: { dream_generated: true } } }),
        await put(engine, 'notes/receipt-gone', { type: 'extract_receipt' }),
        await put(engine, 'notes/dream-gone', { frontmatter: { dream_generated: true } }),
        await put(engine, 'notes/dream-other', { frontmatter: { dream_generated: true } }, { sourceId: 'other' }),
        await put(engine, 'notes/human'),
      ];
      await engine.softDeletePage('notes/receipt-gone');
      await engine.softDeletePage('notes/dream-gone');
      const name = slugsOf(pages);
      const ids = pages.map(p => Number(p.id));
      const view = (rows: Array<{ id: number; frontmatter: Record<string, unknown> | null; compiled_truth: string | null }>) =>
        sorted(rows.map(r => ({ slug: name([r.id])[0], frontmatter: r.frontmatter, compiled_truth: r.compiled_truth })), r => r.slug!);
      const all = view(await engine.generatedPagesIn([...ids, ...ids, 2147483647, 0, -1]));
      const one = view(await engine.generatedPagesIn([ids[1]!]));
      const none = await engine.generatedPagesIn([ids[9]!]);
      const empty = await engine.generatedPagesIn([]);
      const refused: Record<string, boolean> = {};
      for (const [label, bad] of [['above int4', 2147483648], ['below int4', -2147483649], ['fraction', 1.5]] as const) {
        refused[label] = await engine.generatedPagesIn([ids[0]!, bad]).then(() => false, () => true);
      }
      expect(all.map(r => r.slug)).toEqual(['notes/dream-bool', 'notes/dream-gone', 'notes/dream-other', 'notes/dream-text', 'notes/receipt-gone']);
      expect(all.length).toBe(5);
      return { all, one, none, empty, refused };
    },
  );

  parityTest(
    'livePageIdsAt: one id per live page however often its ref repeats, source and slug together, restored pages',
    { methods: ['putPage', 'softDeletePage', 'restorePage', 'livePageIdsAt'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const pages = [
        await put(engine, 'notes/a'), await put(engine, 'notes/b'), await put(engine, 'notes/gone'), await put(engine, 'notes/back'),
        await put(engine, 'notes/a', {}, { sourceId: 'other' }), await put(engine, 'notes/only-other', {}, { sourceId: 'other' }),
      ];
      const key = new Map(pages.map(p => [Number(p.id), `${p.source_id}:${p.slug}`]));
      const name = (ids: number[]) => ({ count: ids.length, pages: sorted(ids.map(id => key.get(Number(id)) ?? `unknown:${id}`)) });
      await engine.softDeletePage('notes/gone');
      await engine.softDeletePage('notes/back');
      const ref = (source_id: string, slug: string) => ({ source_id, slug });
      const whileDeleted = name(await engine.livePageIdsAt([ref('default', 'notes/back')]));
      await engine.restorePage('notes/back');
      const out = {
        repeated: name(await engine.livePageIdsAt([ref('default', 'notes/a'), ref('default', 'notes/a'), ref('other', 'notes/a'), ref('default', 'notes/a')])),
        crossed: name(await engine.livePageIdsAt([ref('default', 'notes/only-other'), ref('other', 'notes/b'), ref('missing', 'notes/a')])),
        deleted: name(await engine.livePageIdsAt([ref('default', 'notes/gone'), ref('default', 'notes/b')])),
        whileDeleted,
        restored: name(await engine.livePageIdsAt([ref('default', 'notes/back')])),
        empty: await engine.livePageIdsAt([]),
      };
      expect(out.repeated).toEqual({ count: 2, pages: ['default:notes/a', 'other:notes/a'] });
      expect(out.crossed.count).toBe(0);
      expect(out.restored.count).toBe(1);
      return out;
    },
  );

  parityTest(
    'cosinesByChunkIds: text-space cosine per visible embedded chunk; unembedded and deleted chunks are absent',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'softDeletePage', 'cosinesByChunkIds'] },
    async (engine) => {
      const query = basisEmbedding(3);
      await seedPage(engine, { slug: 'notes/same', input: { type: 'note', title: 'same', compiled_truth: 'same axis', timeline: '' },
        chunks: [chunk(0, 'same axis', { embedding: basisEmbedding(3) }), chunk(1, 'no vector')] });
      await seedPage(engine, { slug: 'notes/orthogonal', input: { type: 'note', title: 'orth', compiled_truth: 'other axis', timeline: '' },
        chunks: [chunk(0, 'other axis', { embedding: basisEmbedding(9) })] });
      await seedPage(engine, { slug: 'notes/deleted', input: { type: 'note', title: 'deleted', compiled_truth: 'gone', timeline: '' },
        chunks: [chunk(0, 'gone', { embedding: basisEmbedding(3) })] });
      const chunkName = new Map<number, string>();
      for (const slug of ['notes/same', 'notes/orthogonal', 'notes/deleted']) {
        for (const c of await engine.getChunks(slug)) chunkName.set(Number(c.id), `${slug}#${c.chunk_index}`);
      }
      await engine.softDeletePage('notes/deleted');
      const cosines = await engine.cosinesByChunkIds([...chunkName.keys()], 'embedding', query);
      const view = sorted([...cosines].map(([id, cos]) => `${chunkName.get(id)}=${round(cos)}`));
      expect(view).toEqual(['notes/orthogonal#0=0', 'notes/same#0=1']);
      return { view, empty: [...await engine.cosinesByChunkIds([], 'embedding', query)] };
    },
  );

  parityTest(
    'countOnboardSignal: the six onboarding counts under a per-source entity-type filter',
    { methods: ['putPage', 'sealChunks', 'addLink', 'addTimelineEntry', 'addTakesBatch', 'softDeletePage', 'countOnboardSignal'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const alice = await put(engine, 'people/alice-example');
      await put(engine, 'people/bob-example');
      await put(engine, 'companies/acme-example');
      await put(engine, 'people/gone-example');
      await put(engine, 'notes/memo');
      await put(engine, 'notes/skip', { frontmatter: { embed_skip: true } });
      await put(engine, 'people/carol-example', {}, { sourceId: 'other' });
      await engine.sealChunks('notes/memo', [chunk(0, 'memo text'), chunk(1, 'memo more', { embedding: basisEmbedding(1) })]);
      await engine.sealChunks('notes/skip', [chunk(0, 'skipped text')]);
      await engine.addLink('notes/memo', 'people/alice-example', 'memo mentions alice', 'mentions', 'manual');
      await engine.addTimelineEntry('people/bob-example', { date: '2026-01-02', source: 'cal', summary: 'Met Bob' });
      await engine.addTakesBatch([{ page_id: alice.id, row_num: 1, claim: 'Alice ships', kind: 'take', holder: 'garry' }]);
      await engine.softDeletePage('people/gone-example');
      const filter = { types: ['person', 'company'], per_source: [{ source_id: 'other', types: ['company'] }] };
      const counts: Record<string, number> = {};
      for (const kind of ['stale_chunks', 'entities', 'linked_entities', 'timeline_entities', 'takes', 'pages'] as const) {
        counts[kind] = await engine.countOnboardSignal(kind, filter);
      }
      expect(counts).toEqual({ stale_chunks: 1, entities: 3, linked_entities: 1, timeline_entities: 1, takes: 1, pages: 6 });
      return counts;
    },
  );
  parityTest(
    'supersedingPageSlugs: a policy adds the live filter on both pages and the origin page; the source rule always holds',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'supersedingPageSlugs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'old');
      const pages = [
        await put(engine, 'notes/stale'), await put(engine, 'notes/canon'),
        await put(engine, 'notes/stale-deleted'), await put(engine, 'notes/stale-quarantined'),
        await put(engine, 'notes/canon-quarantined', { frontmatter: { quarantine: { reason: 'test' } } }),
        await put(engine, 'notes/stale-origin'), await put(engine, 'notes/origin-gone'),
        await put(engine, 'notes/stale-cross'),
        await put(engine, 'notes/old-stale', {}, { sourceId: 'old' }), await put(engine, 'notes/old-canon', {}, { sourceId: 'old' }),
      ];
      await put(engine, 'notes/canon', {}, { sourceId: 'other' });
      await engine.addLink('notes/canon', 'notes/stale', '', 'supersedes', 'manual');
      await engine.addLink('notes/canon', 'notes/stale-deleted', '', 'supersedes', 'manual');
      await engine.addLink('notes/canon-quarantined', 'notes/stale-quarantined', '', 'supersedes', 'manual');
      await engine.addLink('notes/canon', 'notes/stale-origin', '', 'supersedes', 'frontmatter', 'notes/origin-gone', 'supersedes');
      await engine.addLink('notes/canon', 'notes/stale-cross', '', 'supersedes', 'manual', undefined, undefined, { fromSourceId: 'other' });
      await engine.addLink('notes/old-canon', 'notes/old-stale', '', 'supersedes', 'manual', undefined, undefined, { fromSourceId: 'old', toSourceId: 'old' });
      await engine.softDeletePage('notes/stale-deleted');
      await engine.softDeletePage('notes/origin-gone');
      await archiveSource(engine, backend, 'old');
      const name = slugsOf(pages);
      const ids = pages.map(p => p.id);
      const view = (m: Map<number, string>) => sorted([...m].map(([id, by]) => `${name([id])[0]}<${by}`));
      const open = view(await engine.supersedingPageSlugs(ids));
      const live = view(await engine.supersedingPageSlugs(ids, {}));
      const scoped = view(await engine.supersedingPageSlugs(ids, { sourceIds: ['old'] }));
      const unread = view(await engine.supersedingPageSlugs(ids, { takesHoldersAllowList: [], requireSafeChunks: true }));
      expect(open).toEqual(['notes/old-stale<notes/old-canon', 'notes/stale-deleted<notes/canon', 'notes/stale-origin<notes/canon',
        'notes/stale-quarantined<notes/canon-quarantined', 'notes/stale<notes/canon']);
      expect(live).toEqual(['notes/stale<notes/canon']);
      expect(scoped).toEqual([]);
      expect(unread).toEqual(live);
      return { open, live, scoped, unread };
    },
  );

  parityTest(
    'pagesLinkingTo: ranking links from the listed pages to the targets, deleted linkers included, amends excluded',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'pagesLinkingTo'] },
    async (engine) => {
      const pages = [
        await put(engine, 'people/alice-example'), await put(engine, 'companies/acme-example'),
        await put(engine, 'notes/linker'), await put(engine, 'notes/gone-linker'), await put(engine, 'notes/amender'),
        await put(engine, 'notes/elsewhere'), await put(engine, 'notes/unlisted'), await put(engine, 'notes/both'),
      ];
      await engine.addLink('notes/linker', 'people/alice-example', '', 'mentions', 'manual');
      await engine.addLink('notes/gone-linker', 'companies/acme-example', '', 'works_at', 'manual');
      await engine.addLink('notes/amender', 'people/alice-example', '', 'amends', 'manual');
      await engine.addLink('notes/elsewhere', 'notes/linker', '', 'mentions', 'manual');
      await engine.addLink('notes/unlisted', 'people/alice-example', '', 'mentions', 'manual');
      await engine.addLink('notes/both', 'people/alice-example', '', 'mentions', 'manual');
      await engine.addLink('notes/both', 'companies/acme-example', '', 'mentions', 'manual');
      await engine.softDeletePage('notes/gone-linker');
      const name = slugsOf(pages);
      const id = (slug: string) => pages.find(p => p.slug === slug)!.id;
      const from = pages.filter(p => p.slug !== 'notes/unlisted').map(p => p.id);
      const targets = [id('people/alice-example'), id('companies/acme-example')];
      const linking = name(await engine.pagesLinkingTo(from, targets));
      const noTargets = await engine.pagesLinkingTo(from, []);
      const noSources = await engine.pagesLinkingTo([], targets);
      const self = name(await engine.pagesLinkingTo([id('notes/linker')], [id('notes/linker'), id('people/alice-example')]));
      expect(linking).toEqual(['notes/both', 'notes/gone-linker', 'notes/linker']);
      return { linking, noTargets, noSources, self };
    },
  );
});
