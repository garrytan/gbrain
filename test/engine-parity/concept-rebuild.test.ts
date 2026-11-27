/**
 * BrainEngine parity — the held-concept rebuild's reads and link carry (src/core/engine-sql/concept-rebuild.ts), which
 * src/core/persistence/concept-rebuild.ts ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readHeldConcept returns a synthesized concept tombstone's delete instant only while its needs_rederive
 *    mark is open at that delete and no owner purge is owed on it; isConceptStillHeld and lockHeldConcept answer the
 *    same question for one delete instant (lockHeldConcept also for the page's source and slug); readTombstoneWindow
 *    says when a tombstone's recovery window ends and whether it has; lockLiveConceptMembers counts the members live
 *    at the named revision; listLiveConceptMemberRevisions lists the live ones; listConceptIncomingLinks lists the
 *    links into a page from other live pages, except concept provenance; carryConceptIncomingLinks points those links
 *    at the live page now at the slug. Every rebuild entry point answers the same on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), including the stated-row check, the access
 *    read and the held-concept report.
 *  - Regression: a held predicate that drifts lets a rebuild purge a concept a person deleted or one an owner purge is
 *    owed on; a carry that drops a column rewrites a person's link; an engine that refuses the rebuild's reads leaves
 *    a held concept hidden forever.
 *  - Why existing coverage misses it: test/concept-rebuild-*-9653.test.ts run one engine at a time and never the Rust
 *    arm, and these statements ran through `executeRaw`, which the parity cases cannot call (D18).
 *  - Seam: none. The hold is seeded through typed members: softDeletePage, then markNeedsRederive with the page in
 *    `hiddenNow` (its mark takes the page's delete instant, as the purge's hideDerivedRows marks it), and an owed owner
 *    purge through insertOpCheckpointIfAbsent.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, PageSnapshot } from '../../src/core/engine.ts';
import { OWED_PURGE_OP } from '../../src/core/persistence/derived-origin-hold.ts';
import { conceptPurgeRefusal, heldConceptRebuild, readHeldConcepts, rebuildHeldConcept } from '../../src/core/persistence/concept-rebuild.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const concept = (title: string) => ({ type: 'concept' as const, title, compiled_truth: `${title} narrative.`,
  frontmatter: { synthesized_by: 'synthesize_concepts:v1' } });
const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body.`, frontmatter: {} });

/** A concept tombstone at `slug`, marked needs_rederive at its own delete (held), and its page id. */
async function heldTombstone(engine: BrainEngine, slug: string): Promise<number> {
  await engine.putPage(slug, concept(slug), { sourceId: SRC });
  const id = Number((await engine.getPage(slug, { sourceId: SRC }))!.id);
  await engine.softDeletePage(slug, { sourceId: SRC });
  await engine.markNeedsRederive('pages', [String(id)], SRC, null, 'input_purged', [String(id)]);
  return id;
}

describe('engine parity: concept rebuild', () => {
  parityTest('readHeldConcept, isConceptStillHeld and lockHeldConcept see a concept only while it is held for a rebuild', {
    methods: ['markNeedsRederive', 'insertOpCheckpointIfAbsent', 'deleteOpCheckpoint', 'restorePage', 'readHeldConcept', 'isConceptStillHeld', 'lockHeldConcept',
      'readTombstoneWindow'] }, async (engine) => {
    const id = await heldTombstone(engine, 'concepts/held');
    await engine.putPage('concepts/live', concept('concepts/live'), { sourceId: SRC });
    const live = Number((await engine.getPage('concepts/live', { sourceId: SRC }))!.id);
    const held = await engine.readHeldConcept(id);
    expect(held?.deleted_us).toMatch(/^\d+$/);
    const us = held!.deleted_us;
    const out = {
      held: held !== null, live: await engine.readHeldConcept(live), missing: await engine.readHeldConcept(-1),
      still: await engine.isConceptStillHeld(id, us), otherDelete: await engine.isConceptStillHeld(id, String(BigInt(us) - 1n)),
      locked: await engine.transaction(tx => tx.lockHeldConcept(id, SRC, 'concepts/held', us)),
      lockedOtherSlug: await engine.transaction(tx => tx.lockHeldConcept(id, SRC, 'concepts/other', us)),
      lockedOtherSource: await engine.transaction(tx => tx.lockHeldConcept(id, 'other-src', 'concepts/held', us)),
      window: await engine.readTombstoneWindow(id, 72).then(w => w && { until: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(w.until), past: w.past }),
      windowPast: await engine.readTombstoneWindow(id, 0).then(w => w && w.past),
      windowLive: await engine.readTombstoneWindow(live, 72),
    };
    // An owed owner purge ends the hold; so does a later delete (a person restores the page and deletes it again: the
    // mark is no longer at the page's delete instant).
    await engine.insertOpCheckpointIfAbsent(OWED_PURGE_OP, String(id), []);
    const owed = { held: await engine.readHeldConcept(id), still: await engine.isConceptStillHeld(id, us) };
    await engine.deleteOpCheckpoint(OWED_PURGE_OP, String(id));
    const released = { held: (await engine.readHeldConcept(id))?.deleted_us === us };
    await engine.restorePage('concepts/held', { sourceId: SRC });
    await new Promise(resolve => setTimeout(resolve, 5));
    await engine.softDeletePage('concepts/held', { sourceId: SRC });
    const unmarked = { held: await engine.readHeldConcept(id), still: await engine.isConceptStillHeld(id, us) };
    expect(out).toMatchObject({ held: true, live: null, still: true, otherDelete: false, locked: true, lockedOtherSlug: false,
      window: { until: true, past: false }, windowPast: true, windowLive: null });
    expect([owed, released, unmarked]).toEqual([{ held: null, still: false }, { held: true }, { held: null, still: false }]);
    // The delete instant differs per arm's clock; it is checked above as digits and compared here by whether it matched.
    return { out: { ...out, held: out.held }, owed, released, unmarked };
  });

  parityTest('member reads and the incoming-link carry', {
    methods: ['lockLiveConceptMembers', 'listLiveConceptMemberRevisions', 'listConceptIncomingLinks', 'carryConceptIncomingLinks'] }, async (engine) => {
    for (const slug of ['notes/a', 'notes/b', 'notes/gone', 'notes/from']) await engine.putPage(slug, note(slug), { sourceId: SRC });
    await engine.softDeletePage('notes/gone', { sourceId: SRC });
    const revisions = await engine.listLiveConceptMemberRevisions(SRC, ['notes/a', 'notes/b', 'notes/gone', 'notes/missing', 'notes/a']);
    const at = Object.fromEntries(revisions.map(r => [r.slug, r.revision]));
    const counts = {
      both: await engine.transaction(tx => tx.lockLiveConceptMembers(SRC, [{ slug: 'notes/a', revision: at['notes/a']! }, { slug: 'notes/b', revision: at['notes/b']! }])),
      moved: await engine.lockLiveConceptMembers(SRC, [{ slug: 'notes/a', revision: at['notes/a']! }, { slug: 'notes/b', revision: `${at['notes/b']}9` }]),
      gone: await engine.lockLiveConceptMembers(SRC, [{ slug: 'notes/gone', revision: '1' }]),
      none: await engine.lockLiveConceptMembers(SRC, []),
      otherSource: await engine.lockLiveConceptMembers('other-src', [{ slug: 'notes/a', revision: at['notes/a']! }]),
    };
    await engine.putPage('concepts/old', concept('concepts/old'), { sourceId: SRC });
    const oldId = Number((await engine.getPage('concepts/old', { sourceId: SRC }))!.id);
    await engine.addLink('notes/from', 'concepts/old', 'see it', 'mentions', 'manual');
    await engine.addLink('notes/a', 'concepts/old', 'provenance', 'derived_from', 'concept-provenance');
    await engine.addLink('concepts/old', 'concepts/old', 'self', 'mentions', 'manual');
    const incoming = await engine.listConceptIncomingLinks(oldId);
    await engine.putPage('concepts/new', concept('concepts/new'), { sourceId: SRC });
    const carried = await engine.carryConceptIncomingLinks(SRC, 'concepts/new', incoming, oldId);
    const again = await engine.carryConceptIncomingLinks(SRC, 'concepts/new', incoming, oldId);
    const nowhere = await engine.carryConceptIncomingLinks(SRC, 'concepts/absent', incoming, oldId);
    const backlinks = (await engine.getBacklinks('concepts/new', { sourceId: SRC }))
      .map(l => `${l.from_slug}|${l.link_type}|${l.context}|${l.link_source ?? ''}`).sort();
    const out = {
      revisions: revisions.map(r => r.slug).sort(), counts,
      incoming: incoming.map(l => { const r = l as Record<string, unknown>; return `${r.link_type}|${r.context}|${r.link_source}`; }).sort(),
      carried: carried && { fresh: carried.id === Number((await engine.getPage('concepts/new', { sourceId: SRC }))!.id), carried: carried.carried },
      again: again?.carried, nowhere, backlinks,
    };
    expect(out).toMatchObject({ revisions: ['notes/a', 'notes/b'], counts: { both: 2, moved: 1, gone: 0, none: 0, otherSource: 0 },
      incoming: ['mentions|see it|manual'], carried: { fresh: true, carried: 1 }, again: 0, nowhere: null, backlinks: ['notes/from|mentions|see it|manual'] });
    return out;
  });

  parityTest('every rebuild entry point answers for a concept that is not held, and nothing is locked, purged or written', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'lockHeldConcept', 'readHeldConcept', 'readHeldConceptRows', 'isConceptStillHeld'] }, async (engine) => {
    await engine.putPage('concepts/held', concept('concepts/held'), { sourceId: SRC });
    const page = (await engine.getPage('concepts/held', { sourceId: SRC }))!;
    await engine.softDeletePage('concepts/held', { sourceId: SRC });
    const rebuild = { page_id: Number(page.id), deleted_us: '1', revision: 'r', members: [{ slug: 'notes/a', revision: '1' }] };
    const snapshot = { page: { ...page, id: page.id }, revision: 'r' } as unknown as PageSnapshot;
    let wrote = false;
    const settle = (p: Promise<unknown>) => p.then(value => ({ value }), (error: unknown) => ({ error }));
    const runs = {
      rebuildHeldConcept: await settle(rebuildHeldConcept(engine, SRC, 'concepts/held', rebuild, async () => { wrote = true; })),
      heldConceptRebuild: await settle(heldConceptRebuild(engine, SRC, snapshot, ['notes/a'], ['1'], 'world')),
      readHeldConcepts: await settle(readHeldConcepts(engine, true)),
      conceptPurgeRefusal: await settle(conceptPurgeRefusal(engine, SRC, 'concepts/held', { page_id: Number(page.id), deleted_us: '1' })),
    };
    const after = await engine.getPage('concepts/held', { sourceId: SRC, includeDeleted: true } as never);
    const message = (r: { value?: unknown; error?: unknown }) => 'error' in r ? `${(r.error as { code?: string }).code}: ${(r.error as Error).message}` : r.value;
    const out: Record<string, unknown> = { ...Object.fromEntries(Object.entries(runs).map(([name, r]) => [name, message(r)])), wrote, tombstone: after?.deleted_at != null };
    expect(out).toEqual({
      rebuildHeldConcept: 'revision_conflict: The concept is no longer held for a rebuild (a person or sync deleted, restored or purged it), so the rebuild wrote nothing.',
      heldConceptRebuild: null, readHeldConcepts: { held: [], kept: [] },
      conceptPurgeRefusal: 'the concept is no longer held for a rebuild (a person or sync deleted, restored or purged it)',
      wrote: false, tombstone: true,
    });
    return out;
  });

  /**
   * Held concepts that carry what synthesis did not write, one per stated kind a typed write can leave, plus a private
   * concept whose members are world-readable and a world concept with nothing stated. The report keeps each, with its
   * reason; the stated check and the access read answer the same on every arm.
   */
  parityTest('the stated-row check, the access read and the held-concept report keep each concept for its reason', {
    methods: ['readConceptStatedKinds', 'readRebuildAccess', 'readHeldConceptRows', 'listLiveConceptMemberRevisions', 'readHeldConcept', 'readPageSnapshot',
      'markNeedsRederive', 'recordDerivationEdges', 'addTag', 'addLink', 'addTimelineEntry', 'putRawData'] }, async (engine) => {
    const tail = (slug: string) => slug.split('/').pop()!.replace(/-/g, ' ');
    const held = async (slug: string, frontmatter: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
      await engine.putPage(slug, { type: 'concept', title: tail(slug), compiled_truth: `${tail(slug)} narrative.`, timeline: '',
        frontmatter: { synthesized_by: 'synthesize_concepts:v1', ...frontmatter }, ...extra } as never, { sourceId: SRC });
      return Number((await engine.getPage(slug, { sourceId: SRC }))!.id);
    };
    const hide = async (slug: string, id: number) => {
      await engine.softDeletePage(slug, { sourceId: SRC });
      await engine.markNeedsRederive('pages', [String(id)], SRC, null, 'input_purged', [String(id)]);
    };
    await engine.putPage('notes/world-member', note('notes/world-member'), { sourceId: SRC });
    await engine.putPage('notes/private-member', { ...note('notes/private-member'), frontmatter: { visibility: 'private' } }, { sourceId: SRC });
    const ids: Record<string, number> = {};
    const plan: Array<[string, Record<string, unknown>, Record<string, unknown>, (id: number, slug: string) => Promise<void>]> = [
      ['concepts/plain', { visibility: 'world' }, {}, async () => {}],
      ['concepts/private', {}, {}, async (id) => { await engine.recordDerivationEdges({ table: 'pages', id: String(id) }, SRC, [{ table: 'pages', id: String(ids['notes/world-member']) }]); }],
      ['concepts/private-members', {}, {}, async (id) => { await engine.recordDerivationEdges({ table: 'pages', id: String(id) }, SRC, [{ table: 'pages', id: String(ids['notes/private-member']) }]); }],
      ['concepts/tagged', { visibility: 'world' }, {}, async (_id, slug) => { await engine.addTag(slug, 'kept', { sourceId: SRC }); }],
      ['concepts/linked', { visibility: 'world' }, {}, async (_id, slug) => { await engine.addLink('notes/world-member', slug, 'see', 'mentions', 'manual'); }],
      ['concepts/derived-link', { visibility: 'world' }, {}, async (_id, slug) => { await engine.addLink('notes/world-member', slug, 'see', 'mentions', 'markdown'); }],
      ['concepts/dated', { visibility: 'world' }, {}, async (_id, slug) => { await engine.addTimelineEntry(slug, { date: '2026-01-02', summary: 'Met.' }, { sourceId: SRC }); }],
      ['concepts/raw', { visibility: 'world' }, {}, async (_id, slug) => { await engine.putRawData(slug, 'parity', { a: 1 }, { sourceId: SRC }); }],
      ['concepts/renamed-title', { visibility: 'world' }, { title: 'Another Title' }, async () => {}],
      ['concepts/extra-key', { visibility: 'world', owner_note: 'kept' }, {}, async () => {}],
      ['concepts/empty-tags', { visibility: 'world', tags: [] }, {}, async () => {}],
      ['concepts/labelled', { visibility: 'world', readable_by: ['member:alice-example'] }, {}, async () => {}],
      ['concepts/timeline-text', { visibility: 'world' }, { timeline: '2026-01-01: a line.' }, async () => {}],
    ];
    ids['notes/world-member'] = Number((await engine.getPage('notes/world-member', { sourceId: SRC }))!.id);
    ids['notes/private-member'] = Number((await engine.getPage('notes/private-member', { sourceId: SRC }))!.id);
    for (const [slug, frontmatter, extra, after] of plan) {
      const id = await held(slug, frontmatter, extra);
      ids[slug] = id;
      await after(id, slug);
      await hide(slug, id);
    }
    const lists = { derivedLinkSources: ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved', 'concept-provenance'],
      statedLabelKeys: ['access', 'confidentiality', 'readable_by', 'pinned_question', 'derived_from'],
      synthesisKeys: ['type', 'title', 'trust_tier', 'tier', 'mention_count', 'composite_score', 'synthesis_mode', 'member_hash',
        'synthesized_at', 'synthesized_by', 'visibility', 'unverified_claims'] };
    const kinds = Object.fromEntries(await Promise.all(plan.map(async ([slug]) => {
      const row = await engine.readConceptStatedKinds(ids[slug]!, SRC, slug, lists);
      return [slug, { kinds: row.kinds, lead: row.lead, segmented: row.segmented }] as const;
    })));
    const access = Object.fromEntries(await Promise.all(['concepts/plain', 'concepts/private', 'concepts/labelled', 'notes/world-member', 'notes/private-member']
      .map(async slug => [slug, await engine.readRebuildAccess(ids[slug]!)] as const)));
    const report = await readHeldConcepts(engine, false);
    const rows = (await engine.readHeldConceptRows()).map(({ id: _, ...row }) => row);
    const missing = { kinds: await engine.readConceptStatedKinds(2_000_000_000, SRC, 'concepts/none', lists), access: await engine.readRebuildAccess(2_000_000_000) };
    // The world concept with nothing stated is rebuilt from its live members; a private one with world members is kept.
    const rebuildOf = async (slug: string, visibility: 'private' | 'world') => {
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true }))!;
      const out = await heldConceptRebuild(engine, SRC, snapshot, ['notes/world-member'], [undefined], visibility);
      return out && ('kept' in out ? out : { rebuild: { held: out.rebuild.page_id === ids[slug], deleted: /^\d+$/.test(out.rebuild.deleted_us), members: out.rebuild.members.map(m => m.slug) } });
    };
    const rebuilds = { plain: await rebuildOf('concepts/plain', 'world'), private: await rebuildOf('concepts/private', 'world') };
    const answer = { kinds, access, report, rows, missing, rebuilds };
    expect(rebuilds).toEqual({ plain: { rebuild: { held: true, deleted: true, members: ['notes/world-member'] } },
      private: { kept: { source_id: SRC, slug: 'concepts/private', reason: 'access', why: 'its current members are all world-readable and the hidden concept was not' } } });
    expect(Object.fromEntries(Object.entries(kinds).map(([slug, k]) => [slug, k.kinds]))).toEqual({
      'concepts/plain': [], 'concepts/private': [], 'concepts/private-members': [], 'concepts/tagged': ['tags'], 'concepts/linked': ['links'],
      'concepts/derived-link': [], 'concepts/dated': ['timeline_entries'], 'concepts/raw': ['raw_data'], 'concepts/renamed-title': ['title'],
      'concepts/extra-key': ['frontmatter'], 'concepts/empty-tags': [], 'concepts/labelled': ['labels'], 'concepts/timeline-text': ['timeline'],
    });
    expect(report.held.length).toBe(plan.length);
    expect(missing).toEqual({ kinds: { kinds: [], lead: null, segmented: null }, access: null });
    return answer;
  });
});
