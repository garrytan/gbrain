/**
 * BrainEngine parity — the page-write reads and upkeep that belong to no other family (engine-sql/write-misc.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readSourceState, readAdmissionSource, listLinkEndpointPages, sharedSkillPackTablePresent,
 *    listSharedSkillPackRoots, hasExtractedEvents, listActiveAccessMembers, expireMemoryProposals,
 *    listAwaitingMemoryProposals and purgeMemoryProposals return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a source-state read that differs changes whether page admission, the mirror read-only guard, the
 *    origin guard and link policy accept a write; an endpoint read that differs changes which links a page write
 *    resolves; the rest decide the shared-skillpack screen, chronicle retirement, `access serves` and proposal upkeep.
 *  - Why existing coverage misses it: the call sites ran these statements through `executeRaw`, which the parity cases
 *    cannot call (D18), so no case compared them across engines (docs/research/rust-put-write-path.md).
 *  - Seam: none. Generated values (incarnation uuids, knowledge revisions) are compared by shape, never by value. The
 *    Rust store keeps no skillpacks, chronicle state, access members or memory proposals, so those cases
 *    compare the empty answer every arm gives on a fresh brain (rust/docs/store/write_misc.md).
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SourceStateRow } from '../../src/core/engine-sql/write-misc.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A source state with its generated incarnation replaced by its shape. */
function stateView(row: SourceStateRow | null) {
  if (!row) return row;
  expect(row.incarnation).toMatch(UUID);
  return { ...row, incarnation: 'uuid' };
}

async function note(engine: BrainEngine, slug: string, sourceId = 'default', type = 'note'): Promise<number> {
  const page = await engine.putPage(slug, { type: type as 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId });
  return Number(page.id);
}

describe('engine parity: write misc', () => {
  parityTest('readSourceState reads incarnation, archived, local path and config; null for an unknown id', { methods: ['readSourceState'] }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', { mirror_read_only: 'true', slug_root_mode: 'subdir', n: 2 }, '/var/tmp/alpha-root');
    await createSource(engine, backend, 'beta');
    await archiveSource(engine, backend, 'beta');
    const alpha = await engine.readSourceState('alpha');
    const locked = await engine.readSourceState('alpha', { lock: 'share' });
    expect(locked).toEqual(alpha);
    const beta = await engine.readSourceState('beta');
    const missing = await engine.readSourceState('no-such-source');
    expect(missing).toBeNull();
    return { alpha: stateView(alpha), beta: stateView(beta), missing };
  });

  parityTest('readAdmissionSource reads config kind and role as text; no guest row joins an ordinary source', { methods: ['readAdmissionSource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', { kind: 'notes', role: 7 }, '/var/tmp/alpha-root');
    const alpha = await engine.readAdmissionSource('alpha');
    const plain = await engine.readAdmissionSource('default');
    const missing = await engine.readAdmissionSource('no-such-source');
    expect(alpha?.kind).toBe('notes');
    expect(alpha?.role).toBe('7');
    expect(missing).toBeNull();
    const view = (row: typeof alpha) => row && (expect(row.incarnation).toMatch(UUID), { ...row, incarnation: 'uuid' });
    return { alpha: view(alpha), plain: view(plain), missing };
  });

  parityTest('listLinkEndpointPages returns own live pages, then other sources\' pages for missing and cross-source slugs', { methods: ['listLinkEndpointPages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha');
    await note(engine, 'people/a');
    await note(engine, 'people/b', 'default', 'person');
    await note(engine, 'people/b', 'alpha');
    await note(engine, 'people/c', 'alpha', 'person');
    await note(engine, 'people/d');
    await engine.softDeletePage('people/d', { sourceId: 'default' });
    const rows = await engine.listLinkEndpointPages('default', ['people/a', 'people/b', 'people/c', 'people/d', 'people/none'], ['people/b']);
    const empty = await engine.listLinkEndpointPages('default', [], []);
    expect(empty).toEqual([]);
    for (const row of rows) expect(row.knowledge_revision).toMatch(UUID);
    const sorted = rows.map(r => ({ slug: r.slug, source_id: r.source_id, type: r.type }))
      .sort((x, y) => x.source_id.localeCompare(y.source_id) || x.slug.localeCompare(y.slug));
    expect(sorted).toEqual([
      { slug: 'people/b', source_id: 'alpha', type: 'note' },
      { slug: 'people/c', source_id: 'alpha', type: 'person' },
      { slug: 'people/a', source_id: 'default', type: 'note' },
      { slug: 'people/b', source_id: 'default', type: 'person' },
    ]);
    return { sorted, empty };
  });

  parityTest('sharedSkillPackTablePresent answers for a current schema', { methods: ['sharedSkillPackTablePresent'] }, async (engine) => {
    const present = await engine.sharedSkillPackTablePresent();
    expect(present).toBe(true);
    return { present };
  });

  parityTest('listSharedSkillPackRoots lists no pack on a fresh brain', { methods: ['listSharedSkillPackRoots'] }, async (engine) => {
    const roots = await engine.listSharedSkillPackRoots('00000000-0000-4000-8000-000000000001');
    expect(roots).toEqual([]);
    return { roots };
  });

  parityTest('hasExtractedEvents is false for a page with no chronicle extraction', { methods: ['hasExtractedEvents'] }, async (engine) => {
    const pageId = await note(engine, 'notes/a');
    const events = await engine.hasExtractedEvents('default', pageId);
    expect(events).toBe(false);
    return { events };
  });

  parityTest('listActiveAccessMembers lists no member on a fresh brain', { methods: ['listActiveAccessMembers'] }, async (engine) => {
    const members = await engine.listActiveAccessMembers();
    expect(members).toEqual([]);
    return { members };
  });

  parityTest('expireMemoryProposals expires nothing on a fresh brain', { methods: ['expireMemoryProposals'] }, async (engine) => {
    const expired = await engine.expireMemoryProposals('expired after 7 days');
    expect(expired).toBe(0);
    return { expired };
  });

  parityTest('listAwaitingMemoryProposals lists nothing on a fresh brain', { methods: ['listAwaitingMemoryProposals'] }, async (engine) => {
    const awaiting = await engine.listAwaitingMemoryProposals(10);
    expect(awaiting).toEqual([]);
    return { awaiting };
  });

  parityTest('purgeMemoryProposals purges nothing on a fresh brain', { methods: ['purgeMemoryProposals'] }, async (engine) => {
    const purged = await engine.purgeMemoryProposals(30);
    expect(purged).toBe(0);
    return { purged };
  });
});
