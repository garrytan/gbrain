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
 *    at the live page now at the slug. Same result on PGLite and Postgres. The rebuild's three remaining raw reads
 *    mean an engine without raw SQL (the Rust arm, GBRAIN_TEST_RUST_ARM=1) must refuse every rebuild entry point with
 *    `engine_capability_missing` (reason raw_sql) before it locks, purges or writes anything.
 *  - Regression: a held predicate that drifts lets a rebuild purge a concept a person deleted or one an owner purge is
 *    owed on; a carry that drops a column rewrites a person's link; a rebuild that starts on an engine that cannot
 *    finish it leaves a purged concept with no fresh page.
 *  - Why existing coverage misses it: test/concept-rebuild-*-9653.test.ts run one engine at a time and never the Rust
 *    arm, and these statements ran through `executeRaw`, which the parity cases cannot call (D18).
 *  - Seam: the hold (needs_rederive, op_checkpoints) has no typed writer, so those cases seed it through `executeRaw`
 *    and declare raw_sql.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
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
  await engine.executeRaw(`INSERT INTO needs_rederive (derived_table, derived_id, source_id, reason, marked_at)
    SELECT 'pages', id::text, source_id, 'input_purged', deleted_at FROM pages WHERE id = $1`, [id]);
  return id;
}

describe('engine parity: concept rebuild', () => {
  parityTest('readHeldConcept, isConceptStillHeld and lockHeldConcept see a concept only while it is held for a rebuild', {
    methods: ['executeRaw', 'readHeldConcept', 'isConceptStillHeld', 'lockHeldConcept', 'readTombstoneWindow'], requires: 'raw_sql' }, async (engine) => {
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
    // An owed owner purge ends the hold; so does closing the needs_rederive mark.
    await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint) VALUES ($1, $2)`, [OWED_PURGE_OP, String(id)]);
    const owed = { held: await engine.readHeldConcept(id), still: await engine.isConceptStillHeld(id, us) };
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op = $1', [OWED_PURGE_OP]);
    await engine.executeRaw("DELETE FROM needs_rederive WHERE derived_table = 'pages'");
    const unmarked = { held: await engine.readHeldConcept(id), still: await engine.isConceptStillHeld(id, us) };
    expect(out).toMatchObject({ held: true, live: null, still: true, otherDelete: false, locked: true, lockedOtherSlug: false,
      window: { until: true, past: false }, windowPast: true, windowLive: null });
    expect([owed, unmarked]).toEqual([{ held: null, still: false }, { held: null, still: false }]);
    return { out, owed, unmarked };
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

  parityTest('every rebuild entry point refuses before any write on an engine without raw SQL', {
    methods: ['putPage', 'getPage', 'softDeletePage'], requires: 'raw_sql' }, async (engine) => {
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
    const refusals = Object.entries(runs).filter(([, r]) => 'error' in r && isCapabilityRefusal(r.error, 'raw_sql'));
    if (refusals.length) {
      // The Rust arm: every entry point refused up front, and nothing was locked, purged or written.
      expect({ refused: refusals.map(([name]) => name), wrote, tombstone: after?.deleted_at != null })
        .toEqual({ refused: Object.keys(runs), wrote: false, tombstone: true });
      expect(String((refusals[0]![1] as { error: { message: string } }).error.message)).toContain('rebuildHeldConcept');
      throw (refusals[0]![1] as { error: unknown }).error;
    }
    const message = (r: { value?: unknown; error?: unknown }) => 'error' in r ? `${(r.error as { code?: string }).code}: ${(r.error as Error).message}` : r.value;
    const out: Record<string, unknown> = { ...Object.fromEntries(Object.entries(runs).map(([name, r]) => [name, message(r)])), wrote, tombstone: after?.deleted_at != null };
    expect(out).toMatchObject({ heldConceptRebuild: null, readHeldConcepts: { held: [], kept: [] }, wrote: false, tombstone: true });
    expect(String(out.rebuildHeldConcept)).toContain('revision_conflict: The concept is no longer held for a rebuild');
    return out;
  });
});
