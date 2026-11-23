/**
 * BrainEngine parity — `excludePrivate` reads for a remote caller on a brain with no member restriction.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a caller record with `restricted: false` (a brain where no page names readers and no member exists, so
 *    `access.restrictions_present` is unset) renders the short member-access form of the page policy. Under it, each
 *    read below hides the private page and the page derived from it for a plain caller, reads the same for a member
 *    identity (the short form reads no identity), and shows both to a caller with a private-readable grant on the
 *    source, on every engine arm. The provenance forms (unattributed facts, an ontology value sourced from a private
 *    page) read no grant and stay hidden for all three; an ontology row about a private entity opens with the grant.
 *  - Regression: the Rust arm compared the short form with the no-caller text, found them different and refused every
 *    one of these reads, so a stdio MCP caller on a Rust brain got a typed refusal from search, find_orphans, whois,
 *    ontology_get, ontology_conflicts, volunteer_chronicle, extraction_pending, run_doctor and get_recent_salience.
 *  - Why existing coverage misses it: the caller-policy cases in private-page-reads, timeline, links and
 *    retrieval-coverage read only as callers with `restricted` true (the default record), never false.
 *  - Seam: none. Real engines, typed methods only; the fixture writes no `readable_by` page, as the premise of the
 *    short form requires.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const OPEN = 'notes/open';
const PRIVATE = 'notes/private';
const LINEAGE = 'notes/lineage';
const SECOND_OPEN = 'notes/second-open';

/** Three pages: open, private, and one derived from the private page. Each has a timeline row and a loose fact. */
async function fixture(engine: BrainEngine) {
  for (const [slug, frontmatter] of [[OPEN, {}], [PRIVATE, { visibility: 'private' }], [LINEAGE, { derived_from: `${PRIVATE}.md` }]] as const) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });
    await engine.addTimelineEntry(slug, { date: '2026-06-18', summary: `${slug} row` });
  }
  await engine.insertFacts([OPEN, PRIVATE, LINEAGE].map((slug, i) => ({
    fact: `from ${slug}`, entity_slug: null, source_markdown_slug: slug, row_num: i + 1, kind: 'fact', visibility: 'world', source: 'fence',
  })) as never, { source_id: 'default' });
  // Two current roles from the open and the private page: a conflict only a caller who reads both sees.
  await engine.mergeOntologyFact({ entitySlug: 'people/alice-example', dimension: 'role', value: 'newer', source: OPEN, validFrom: '2026-05-01', visibility: 'world' });
  await engine.mergeOntologyFact({ entitySlug: 'people/alice-example', dimension: 'role', value: 'older', source: PRIVATE, validFrom: '2026-01-01', visibility: 'world' });
}

/** Two current roles of the private page itself, both from open pages: the entity page decides who sees them. */
async function privateEntityRoles(engine: BrainEngine) {
  await engine.putPage(SECOND_OPEN, { type: 'note', title: SECOND_OPEN, compiled_truth: 'Open.', timeline: '', frontmatter: {} });
  await engine.mergeOntologyFact({ entitySlug: PRIVATE, dimension: 'role', value: 'newer', source: OPEN, validFrom: '2026-05-01', visibility: 'world' });
  await engine.mergeOntologyFact({ entitySlug: PRIVATE, dimension: 'role', value: 'older', source: SECOND_OPEN, validFrom: '2026-01-01', visibility: 'world' });
}

/** The three unrestricted callers: plain, a member identity, and a private-readable grant on `default`. */
const CALLERS = {
  plain: { restricted: false, hidePrivate: true },
  member: { restricted: false, identity: ['member:alice-example'], hidePrivate: true },
  granted: { restricted: false, privateReadableSources: ['default'], hidePrivate: true },
} as const;

async function asCallers<T>(read: () => Promise<T>): Promise<Record<keyof typeof CALLERS, T>> {
  return {
    plain: await withCallerAccess(CALLERS.plain, read),
    member: await withCallerAccess(CALLERS.member, read),
    granted: await withCallerAccess(CALLERS.granted, read),
  };
}

describe('engine parity: excludePrivate reads for a remote caller on a brain with no member restriction', () => {
  parityTest(
    'the page reads hide the private and derived pages from a plain or member caller and show them with a grant',
    { methods: ['putPage', 'addTimelineEntry', 'insertFacts', 'mergeOntologyFact', 'getRecentSalience', 'findOrphanPages', 'getSince', 'readProjectionReadiness'] },
    async (engine) => {
      await fixture(engine);
      const kept = await asCallers(async () => ({
        salience: sorted((await engine.getRecentSalience({ days: 7, limit: 100, excludePrivate: true })).map((r) => r.slug)),
        // The top-ranked slug alone: rank order must not move for a hidden page.
        salienceTop: (await engine.getRecentSalience({ days: 7, limit: 1, excludePrivate: true })).map((r) => r.slug),
        orphans: sorted((await engine.findOrphanPages({ excludePrivate: true })).map((r) => r.slug)),
        since: sorted((await engine.getSince('2026-06-18', { excludePrivate: true })).map((r) => `${r.page_slug}:${r.summary}`)),
        readiness: await engine.readProjectionReadiness({ excludePrivate: true }),
      }));
      expect(kept.plain.salience).toEqual([OPEN]);
      expect(kept.plain.orphans).toEqual([OPEN]);
      expect(kept.plain.since).toEqual([`${OPEN}:${OPEN} row`]);
      expect(JSON.stringify(kept.plain)).not.toContain(PRIVATE);
      expect(kept.member).toEqual(kept.plain);
      expect(kept.granted.salience).toEqual(sorted([OPEN, PRIVATE, LINEAGE]));
      expect(kept.granted.orphans).toEqual(sorted([OPEN, PRIVATE, LINEAGE]));
      expect(kept.granted.since).toHaveLength(3);
      return kept;
    },
  );

  parityTest(
    'the fact and ontology reads hide private provenance from every caller and a private entity from all but a granted caller',
    { methods: ['putPage', 'addTimelineEntry', 'insertFacts', 'mergeOntologyFact', 'listUnattributedFacts', 'getOntology', 'findOntologyConflicts'] },
    async (engine) => {
      await fixture(engine);
      await privateEntityRoles(engine);
      const read = async () => ({
        facts: (await engine.listUnattributedFacts({ sourceIds: ['default'], worldOnly: false, excludePrivateProvenance: true, limit: 10, offset: 0 }))
          .map((r) => r.fact),
        ontology: sorted((await engine.getOntology('people/alice-example', { excludePrivate: true })).map((r) => `${r.dimension}=${r.value}`)),
        entityOntology: sorted((await engine.getOntology(PRIVATE, { excludePrivate: true })).map((r) => `${r.dimension}=${r.value}`)),
        conflicts: (await engine.findOntologyConflicts({ excludePrivate: true })).map((c) => `${c.entity_slug}:${c.dimension}:${c.values.length}`),
      });
      const kept = await asCallers(read);
      expect(kept.plain.facts).toEqual([`from ${OPEN}`]);
      expect(kept.plain.ontology).toEqual(['role=newer']);
      expect(kept.plain.entityOntology).toEqual([]);
      // A hidden value or entity leaves no conflict behind: the count of conflicting values would confirm it.
      expect(kept.plain.conflicts).toEqual([]);
      expect(JSON.stringify(kept.plain)).not.toContain(PRIVATE);
      expect(kept.member).toEqual(kept.plain);
      // The provenance forms read no caller grant (listUnattributedFacts, the private-page role); the entity page does.
      expect(kept.granted.facts).toEqual(kept.plain.facts);
      expect(kept.granted.ontology).toEqual(kept.plain.ontology);
      expect(kept.granted.entityOntology).toEqual(['role=newer']);
      expect(kept.granted.conflicts).toEqual([`${PRIVATE}:role:2`]);
      return kept;
    },
  );
});
