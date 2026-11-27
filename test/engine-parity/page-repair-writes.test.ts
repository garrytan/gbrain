/**
 * BrainEngine parity — the page writes a repair apply runs on one page row (engine-sql/write-guards.ts): the detach
 * (`detachPageOrigin`), the database-only marker read (`readPageDatabaseOnlyReason`), the revision bump
 * (`bumpPageKnowledgeRevision`), the frontmatter key removal (`removePageFrontmatterKeys`) and the type change
 * (`setPageType`), and how `putPage` and `bindPageOrigin` drop the marker again.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), a detach forgets the
 *    page's file and records why, keeping its revision; a `putPage` that names a file drops the detached and origin twin
 *    markers, and `bindPageOrigin` drops `origin_twin` (never `detached`); a revision bump changes
 *    only the revision; a key removal changes a live page that held a key (frontmatter and revision) and leaves a page
 *    without the keys, another source's page and a tombstone alone; a type change takes a new revision only when the
 *    type changed, a tombstone included.
 *  - Regression: these statements ran through `executeRaw` in origin-twins.ts, twin-merge.ts, file-drift.ts,
 *    secret-spans.ts, atoms-restore.ts and file-repair.ts, which a Rust brain refuses. The Rust store also kept no
 *    `database_only_reason`, so a detached or origin twin page read as an ordinary one there.
 *  - Why existing coverage misses it: the repair tests run on PGLite only, and the write-guard parity cases never
 *    read the marker.
 *  - Seam: none. Typed members only (no executeRaw: D18). Revisions are compared as "changed" or "kept".
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Repair note', compiled_truth: 'A repair example.', timeline: '' };

/** Page `slug` of the default source, a tombstone included. */
async function pageOf(engine: BrainEngine, slug: string) {
  const page = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
  expect(page).not.toBeNull();
  return page!;
}

/** The columns a repair write changes, with the revision compared against `before`. */
async function view(engine: BrainEngine, slug: string, before: string) {
  const page = await pageOf(engine, slug);
  return { type: page.type, source_path: page.source_path ?? null, source_uri: page.source_uri ?? null, frontmatter: page.frontmatter,
    reason: await engine.readPageDatabaseOnlyReason('default', slug), revision: page.knowledge_revision === before ? 'kept' : 'changed' };
}

describe('engine parity: repair page writes', () => {
  parityTest('a detach forgets the file and records why, and putPage or bindPageOrigin drop the marker again', {
    methods: ['putPage', 'getPage', 'detachPageOrigin', 'readPageDatabaseOnlyReason', 'bindPageOrigin'],
  }, async (engine) => {
    await engine.putPage('notes/detach-a', { ...NOTE, source_path: 'notes/detach-a.md', source_uri: 'file:notes/detach-a.md' });
    await engine.putPage('notes/detach-b', { ...NOTE, source_path: 'notes/detach-b.md' });
    const a = await pageOf(engine, 'notes/detach-a');
    const b = await pageOf(engine, 'notes/detach-b');
    const steps: Record<string, unknown> = {};
    steps.fresh = await engine.readPageDatabaseOnlyReason('default', 'notes/detach-a');
    steps.missing = await engine.readPageDatabaseOnlyReason('default', 'notes/never-written');
    await engine.detachPageOrigin(Number(a.id), 'detached');
    await engine.detachPageOrigin(Number(b.id), 'origin_twin');
    steps.detached = await view(engine, 'notes/detach-a', a.knowledge_revision!);
    steps.twin = await view(engine, 'notes/detach-b', b.knowledge_revision!);
    // A put without a file keeps the marker; a put naming the file drops it.
    await engine.putPage('notes/detach-a', { ...NOTE, compiled_truth: 'Rewritten without a file.' });
    steps.putWithoutFile = await engine.readPageDatabaseOnlyReason('default', 'notes/detach-a');
    await engine.putPage('notes/detach-a', { ...NOTE, source_path: 'notes/detach-a.md' });
    steps.putWithFile = await engine.readPageDatabaseOnlyReason('default', 'notes/detach-a');
    // The bind records the origin and drops origin_twin; a second bind of the same origin changes nothing.
    steps.bound = await engine.bindPageOrigin({ sourceId: 'default', pageId: Number(b.id), sourcePath: 'notes/detach-b.md' });
    steps.boundReason = await engine.readPageDatabaseOnlyReason('default', 'notes/detach-b');
    await engine.detachPageOrigin(Number(b.id), 'origin_twin');
    await engine.bindPageOrigin({ sourceId: 'default', pageId: Number(b.id), sourcePath: 'notes/detach-b.md' });
    await engine.detachPageOrigin(Number(b.id), 'origin_twin');
    await engine.putPage('notes/detach-b', { ...NOTE, source_path: 'notes/detach-b.md' });
    steps.rebound = await engine.readPageDatabaseOnlyReason('default', 'notes/detach-b');
    expect(steps).toEqual({
      fresh: null, missing: null,
      detached: { type: 'note', source_path: null, source_uri: null, frontmatter: {}, reason: 'detached', revision: 'kept' },
      twin: { type: 'note', source_path: null, source_uri: null, frontmatter: {}, reason: 'origin_twin', revision: 'kept' },
      putWithoutFile: 'detached', putWithFile: null, bound: 1, boundReason: null, rebound: null,
    });
    return steps;
  });

  parityTest('bindPageOrigin drops origin_twin only, and a second bind of the same origin changes nothing', {
    methods: ['putPage', 'getPage', 'detachPageOrigin', 'readPageDatabaseOnlyReason', 'bindPageOrigin'],
  }, async (engine) => {
    await engine.putPage('notes/bind-twin', NOTE);
    const page = await pageOf(engine, 'notes/bind-twin');
    await engine.detachPageOrigin(Number(page.id), 'origin_twin');
    const first = await engine.bindPageOrigin({ sourceId: 'default', pageId: Number(page.id), sourcePath: 'notes/bind-twin.md', onlyIfUnset: true });
    // A detached page keeps its marker when it takes an origin back through the bind.
    await engine.putPage('notes/bind-plain', NOTE);
    const plain = await pageOf(engine, 'notes/bind-plain');
    await engine.detachPageOrigin(Number(plain.id), 'detached');
    const steps = {
      first, afterFirst: await engine.readPageDatabaseOnlyReason('default', 'notes/bind-twin'),
      again: await engine.bindPageOrigin({ sourceId: 'default', pageId: Number(page.id), sourcePath: 'notes/bind-twin.md' }),
      plainBind: await engine.bindPageOrigin({ sourceId: 'default', pageId: Number(plain.id), sourcePath: 'notes/bind-plain.md' }),
      plainReason: await engine.readPageDatabaseOnlyReason('default', 'notes/bind-plain'),
    };
    expect(steps).toEqual({ first: 1, afterFirst: null, again: 0, plainBind: 1, plainReason: 'detached' });
    return steps;
  });

  parityTest('a revision bump changes the revision of a page, a tombstone included, and nothing else', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'bumpPageKnowledgeRevision', 'readPageDatabaseOnlyReason'],
  }, async (engine) => {
    await engine.putPage('notes/bump-live', { ...NOTE, frontmatter: { kept: 'yes' } });
    await engine.putPage('notes/bump-gone', NOTE);
    const live = await pageOf(engine, 'notes/bump-live');
    const gone = await pageOf(engine, 'notes/bump-gone');
    await engine.softDeletePage('notes/bump-gone');
    const goneBefore = (await pageOf(engine, 'notes/bump-gone')).knowledge_revision!;
    await engine.bumpPageKnowledgeRevision(Number(live.id));
    await engine.bumpPageKnowledgeRevision(Number(gone.id));
    await engine.bumpPageKnowledgeRevision(999_999_999);
    const steps = { live: await view(engine, 'notes/bump-live', live.knowledge_revision!), gone: await view(engine, 'notes/bump-gone', goneBefore) };
    expect(steps).toEqual({
      live: { type: 'note', source_path: null, source_uri: null, frontmatter: { kept: 'yes' }, reason: null, revision: 'changed' },
      gone: { type: 'note', source_path: null, source_uri: null, frontmatter: {}, reason: null, revision: 'changed' },
    });
    return steps;
  });

  parityTest('a key removal changes only a live page of the source that held a key', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'insertSource', 'removePageFrontmatterKeys', 'readPageDatabaseOnlyReason'],
  }, async (engine) => {
    const fm = { retired_by: 'notes/new', retired_at: '2026-01-02', kept: 'yes' };
    await engine.putPage('notes/keys-live', { ...NOTE, frontmatter: fm });
    await engine.putPage('notes/keys-none', { ...NOTE, frontmatter: { kept: 'yes' } });
    await engine.putPage('notes/keys-gone', { ...NOTE, frontmatter: fm });
    await engine.softDeletePage('notes/keys-gone');
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
    const [live, none, gone] = await Promise.all(['notes/keys-live', 'notes/keys-none', 'notes/keys-gone'].map(slug => pageOf(engine, slug)));
    const keys = ['retired_by', 'retired_at'];
    await engine.removePageFrontmatterKeys('other-example', Number(live.id), keys);
    const otherSource = await view(engine, 'notes/keys-live', live.knowledge_revision!);
    await engine.removePageFrontmatterKeys('default', Number(live.id), keys);
    await engine.removePageFrontmatterKeys('default', Number(none.id), keys);
    await engine.removePageFrontmatterKeys('default', Number(gone.id), keys);
    const steps = {
      otherSource,
      live: await view(engine, 'notes/keys-live', live.knowledge_revision!),
      none: await view(engine, 'notes/keys-none', none.knowledge_revision!),
      gone: await view(engine, 'notes/keys-gone', gone.knowledge_revision!),
    };
    const row = (frontmatter: Record<string, unknown>, revision: string) => ({ type: 'note', source_path: null, source_uri: null, frontmatter, reason: null, revision });
    expect(steps).toEqual({ otherSource: row(fm, 'kept'), live: row({ kept: 'yes' }, 'changed'), none: row({ kept: 'yes' }, 'kept'), gone: row(fm, 'kept') });
    return steps;
  });

  parityTest('a type change takes a new revision only when the type changed, a tombstone included', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'setPageType', 'readPageDatabaseOnlyReason'],
  }, async (engine) => {
    await engine.putPage('notes/type-live', NOTE);
    await engine.putPage('notes/type-gone', NOTE);
    await engine.softDeletePage('notes/type-gone');
    const live = await pageOf(engine, 'notes/type-live');
    const gone = await pageOf(engine, 'notes/type-gone');
    await engine.setPageType('default', 'notes/type-live', 'note');
    const same = await view(engine, 'notes/type-live', live.knowledge_revision!);
    await engine.setPageType('default', 'notes/type-live', 'concept');
    await engine.setPageType('default', 'notes/type-gone', 'concept');
    await engine.setPageType('default', 'notes/never-written', 'concept');
    const steps = { same, live: await view(engine, 'notes/type-live', live.knowledge_revision!), gone: await view(engine, 'notes/type-gone', gone.knowledge_revision!) };
    const row = (type: string, revision: string) => ({ type, source_path: null, source_uri: null, frontmatter: {}, reason: null, revision });
    expect(steps).toEqual({ same: row('note', 'kept'), live: row('concept', 'changed'), gone: row('concept', 'changed') });
    return steps;
  });
});
