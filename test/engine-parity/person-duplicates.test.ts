/**
 * BrainEngine parity — the person-duplicate reads doctor's person_title_duplicates check and the entity name-variant
 * arm made through executeRaw (engine-sql/entity-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the unretired title-prefixed person pages by slug, the name-variant candidates in probe-hit order, a
 *    page's retirement and redirect target, the distinct inbound linkers of a page, and the doctor check built on
 *    them return the same observable result on every engine arm.
 *  - Regression: an engine that lists a retired or deleted stub, matches a probe case-sensitively, orders candidates
 *    by slug before probe hits, reads a blank `merged_into` as retired, or counts two links from one page twice
 *    changes which person pages doctor reports as duplicates and which page a titled name resolves to.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18); on a Rust brain the check warned with the typed refusal instead of answering.
 *  - Seam: none. Typed methods only (no executeRaw: D18). Slugs are chosen so byte order and the en_US collation
 *    agree; rows with no defined order are sorted.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { personTitleDuplicatesEntry } from '../../src/commands/doctor/checks/entity-duplicates.ts';
import { resolveNameVariant, VARIANT_ROW_COLUMNS } from '../../src/core/verbs/entity-variants.ts';
import { followRetirement } from '../../src/core/entities/resolve.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
    ({ type, title, compiled_truth: `${title} body.`, frontmatter }) as Parameters<BrainEngine['putPage']>[1];
  const pages: Array<[string, Parameters<BrainEngine['putPage']>[1], string?]> = [
    ['people/alice-example', page('person', 'Alice Example', { role: 'engineer' })],
    ['people/dr-alice-example', page('person', 'Dr Alice Example')],
    ['people/mayor-quill', page('person', 'Mayor Quill')],
    ['people/quill-example', page('person', 'Quill Example')],
    ['people/dr-retired', page('person', 'Dr Retired', { merged_into: 'people/alice-example' })],
    ['people/dr-gone', page('person', 'Dr Gone')],
    ['people/old-alice', page('person', 'Old Alice', { superseded_by: ' [[people/alice-example|Alice]] ' })],
    ['people/alias-page', page('person', 'Alias page', { status: 'Alias of someone' })],
    ['people/blank-merge', page('person', 'Blank merge', { merged_into: '  ', canonical: true })],
    ['companies/example-co', page('company', 'Example Co')],
    ['notes/alice', page('note', 'Alice notes')],
    ['people/mr-zed', page('person', 'Mr Zed'), 'other'],
  ];
  for (const [slug, input, sourceId] of pages) await engine.putPage(slug, input, { sourceId: sourceId ?? 'default' });
  await engine.softDeletePage('people/dr-gone', { sourceId: 'default' });
  await engine.addLink('notes/alice', 'people/alice-example', '', 'mentions', 'manual');
  await engine.addLink('notes/alice', 'people/alice-example', '', 'cites', 'manual');
  await engine.addLink('people/quill-example', 'people/alice-example', '', 'knows', 'manual');
  await engine.addLink('notes/alice', 'people/dr-alice-example', '', 'cites', 'manual');
}

describe('engine parity: person-duplicate reads', () => {
  parityTest('listUnretiredPagesBySlugPattern lists live, unretired pages matching a pattern by slug, capped',
    { methods: ['listUnretiredPagesBySlugPattern'] }, async (engine, backend) => {
      await seed(engine, backend);
      const patterns = ['people/dr-%', 'people/mayor-%', 'people/mr-%'];
      const result = {
        all: await engine.listUnretiredPagesBySlugPattern('default', patterns, 10),
        capped: await engine.listUnretiredPagesBySlugPattern('default', patterns, 1),
        other: await engine.listUnretiredPagesBySlugPattern('other', patterns, 10),
        none: await engine.listUnretiredPagesBySlugPattern('default', ['people/sir-%'], 10),
      };
      expect(result).toEqual({
        all: [{ slug: 'people/dr-alice-example', title: 'Dr Alice Example' }, { slug: 'people/mayor-quill', title: 'Mayor Quill' }],
        capped: [{ slug: 'people/dr-alice-example', title: 'Dr Alice Example' }],
        other: [{ slug: 'people/mr-zed', title: 'Mr Zed' }],
        none: [],
      });
      return result;
    });

  parityTest('listNameVariantCandidates matches probes case-insensitively, most hits first, then the shortest title',
    { methods: ['listNameVariantCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const read = (probes: string[], limit = 10) => engine.listNameVariantCandidates('default',
        { types: ['person', 'company'], slugPatterns: ['people/%', 'companies/%'], probes, limit })
        .then(rows => rows.map(r => ({ slug: r.slug, title: r.title, type: r.type, probe_hits: r.probe_hits })));
      const result = {
        both: await read(['%alice%', '%EXAMPLE%']),
        capped: await read(['%alice%', '%EXAMPLE%'], 2),
        quill: await read(['%quill%']),
        none: await read(['%nobody%']),
        frontmatter: (await engine.listNameVariantCandidates('default',
          { types: ['person'], slugPatterns: [], probes: ['%old%'], limit: 5 })).map(r => r.frontmatter),
      };
      expect(result.both).toEqual([
        { slug: 'people/alice-example', title: 'Alice Example', type: 'person', probe_hits: 2 },
        { slug: 'people/dr-alice-example', title: 'Dr Alice Example', type: 'person', probe_hits: 2 },
        { slug: 'people/old-alice', title: 'Old Alice', type: 'person', probe_hits: 1 },
        { slug: 'companies/example-co', title: 'Example Co', type: 'company', probe_hits: 1 },
        { slug: 'people/quill-example', title: 'Quill Example', type: 'person', probe_hits: 1 },
      ]);
      expect(result.capped.map(r => r.slug)).toEqual(['people/alice-example', 'people/dr-alice-example']);
      expect(result.frontmatter).toEqual([{ superseded_by: ' [[people/alice-example|Alice]] ' }]);
      return result;
    });

  parityTest('readRetirementHop reads whether a live page is retired and its trimmed redirect value',
    { methods: ['readRetirementHop'] }, async (engine, backend) => {
      await seed(engine, backend);
      const out: Record<string, unknown> = {};
      for (const slug of ['people/alice-example', 'people/old-alice', 'people/dr-retired', 'people/alias-page',
        'people/blank-merge', 'people/dr-gone', 'people/missing']) {
        out[slug] = await engine.readRetirementHop('default', slug, 'none');
      }
      out.otherSource = await engine.readRetirementHop('other', 'people/alice-example', 'none');
      expect(out).toEqual({
        'people/alice-example': { slug: 'people/alice-example', type: 'person', retired: false, target: null },
        'people/old-alice': { slug: 'people/old-alice', type: 'person', retired: true, target: '[[people/alice-example|Alice]]' },
        'people/dr-retired': { slug: 'people/dr-retired', type: 'person', retired: true, target: 'people/alice-example' },
        'people/alias-page': { slug: 'people/alias-page', type: 'person', retired: true, target: null },
        'people/blank-merge': { slug: 'people/blank-merge', type: 'person', retired: false, target: null },
        'people/dr-gone': null,
        'people/missing': null,
        otherSource: null,
      });
      return out;
    });

  parityTest('countDistinctInboundLinkers counts each linking page once per target, and omits pages with none',
    { methods: ['countDistinctInboundLinkers'] }, async (engine, backend) => {
      await seed(engine, backend);
      const rows = sorted(await engine.countDistinctInboundLinkers(
        ['default', 'default', 'default', 'other'],
        ['people/alice-example', 'people/dr-alice-example', 'people/mayor-quill', 'people/alice-example']), r => r.slug);
      expect(rows).toEqual([
        { source_id: 'default', slug: 'people/alice-example', n: 2 },
        { source_id: 'default', slug: 'people/dr-alice-example', n: 1 },
      ]);
      return { rows, empty: await engine.countDistinctInboundLinkers([], []) };
    });

  parityTest('a titled name resolves through the typed reads, and doctor reports the title-prefixed pair',
    { methods: ['listUnretiredPagesBySlugPattern', 'listNameVariantCandidates', 'readRetirementHop', 'countDistinctInboundLinkers'] },
    async (engine, backend) => {
      await seed(engine, backend);
      const resolved = await resolveNameVariant(engine, 'default', 'Alice Example', {
        selectColumns: VARIANT_ROW_COLUMNS, privatePredicate: '', retirementPrivacy: 'none', entityTypes: new Set(['person']),
        exclude: ['people/dr-alice-example'],
      });
      const retirement = await followRetirement(engine, 'default', 'people/old-alice');
      const ctx = { engine, progress: { heartbeat: () => undefined } } as unknown as DoctorContext;
      const [check] = await personTitleDuplicatesEntry.run(ctx) as Array<{ name: string; status: string; details?: unknown }>;
      const result = {
        hit: resolved.hit ? { slug: resolved.hit.row.slug, kind: resolved.hit.kind } : null,
        matches: resolved.matches.map(m => m.row.slug),
        retirement,
        check: { name: check?.name, status: check?.status, details: check?.details },
      };
      expect(result.hit?.slug).toBe('people/alice-example');
      expect(retirement).toEqual({ slug: 'people/alice-example', type: 'person' });
      expect(result.check.status).toBe('warn');
      expect(result.check.details).toEqual({
        scanned: 3, capped: false,
        pairs: [{ source_id: 'default', stub: 'people/dr-alice-example', canonical: 'people/alice-example', stub_links: 1, canonical_links: 2 }],
      });
      return result;
    });
});
