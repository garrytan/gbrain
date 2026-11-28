/**
 * BrainEngine parity — versions + raw_files families.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: page version snapshots (create / list / revert), raw sidecar
 *    data and file metadata rows behave identically on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine that snapshots the wrong fields, orders history
 *    differently, reverts the wrong source's row, or drifts on
 *    (source, storage_path) upsert identity — page history, `gbrain
 *    revert`, enrichment sidecars and image assets all read these.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and has no versions/raw/files cases;
 *    per-engine unit tests never compare two engines on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    Version/file ids are sequence-generated, so observables map them to
 *    body text or storage paths and never return the raw id.
 */
import { describe, expect } from 'bun:test';
import type { FileRow } from '../../src/core/engine.ts';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

// FileRow.size_bytes is a JS number on every engine (the files.size_bytes column is BIGINT; Postgres used to
// return it as a BigInt). It is part of the compared view, and `sizeOf` refuses any other type.
const FILE_KEYS = ['source_id', 'page_slug', 'filename', 'storage_path', 'mime_type', 'size_bytes', 'content_hash', 'metadata', 'created_at'] as const;
const fileView = (f: FileRow | null) => (f ? pick(f, FILE_KEYS) : null);
const sizeOf = (f: FileRow | null) => {
  if (f?.size_bytes == null) return null;
  expect(typeof f.size_bytes).toBe('number');
  return f.size_bytes;
};

describe('engine parity: versions', () => {
  parityTest(
    'createVersion snapshots the current page; getVersions lists snapshots newest-first',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      await engine.putPage('notes/ver-a', {
        type: 'note', title: 'Draft one', compiled_truth: 'Body v1.', timeline: '- 2026-01-01: started', frontmatter: { stage: 'draft' },
      });
      const v1 = await engine.createVersion('notes/ver-a');
      await engine.putPage('notes/ver-a', {
        type: 'note', title: 'Draft two', compiled_truth: 'Body v2.', timeline: '- 2026-01-01: started', frontmatter: { stage: 'final' },
      });
      const v2 = await engine.createVersion('notes/ver-a');
      expect(v1.compiled_truth).toBe('Body v1.');
      expect(v2.compiled_truth).toBe('Body v2.');
      expect(v2.id).not.toBe(v1.id);
      const list = await engine.getVersions('notes/ver-a');
      const body = list.map((v) => v.compiled_truth);
      // The two explicit snapshots are in the history, newest first.
      expect(body.indexOf('Body v2.')).toBeLessThan(body.indexOf('Body v1.'));
      const limited = await engine.getVersions('notes/ver-a', { limit: 1 });
      expect(limited).toHaveLength(1);
      const meta = await engine.getVersions('notes/ver-a', { includeBody: false });
      expect('compiled_truth' in meta[0]!).toBe(false);
      const view = (v: (typeof list)[number]) => ({ ...pick(v, ['title', 'type', 'compiled_truth', 'timeline', 'frontmatter', 'tags', 'snapshot_at'] as const) });
      return {
        created: [view(v1), view(v2)],
        list: list.map(view),
        limited: limited.map(view),
        metaTitles: meta.map((m) => m.title),
      };
    },
  );

  parityTest(
    'createVersion on a missing page throws; getVersions of a missing page is empty',
    { methods: ['createVersion', 'getVersions'] },
    async (engine) => {
      let threw = false;
      try {
        await engine.createVersion('notes/no-such-page');
      } catch (error) {
        threw = true;
        expect(String((error as Error).message)).toContain('not found');
      }
      expect(threw).toBe(true);
      return { threw, versions: await engine.getVersions('notes/no-such-page') };
    },
  );

  parityTest(
    'createVersion keeps its reason; getVersions reads it back as replaced_because',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      await engine.putPage('notes/ver-why', { type: 'note', title: 'Why', compiled_truth: 'Dated 2026-01-02.', timeline: '' });
      const created = await engine.createVersion('notes/ver-why', { reason: 'Corrected date' });
      await engine.putPage('notes/ver-why', { type: 'note', title: 'Why', compiled_truth: 'Dated 2026-01-03.', timeline: '' });
      await engine.createVersion('notes/ver-why');
      const reasons = (await engine.getVersions('notes/ver-why')).map((v) => [v.compiled_truth, v.replaced_because ?? null]);
      expect(reasons).toContainEqual(['Dated 2026-01-02.', 'Corrected date']);
      const meta = (await engine.getVersions('notes/ver-why', { includeBody: false })).map((v) => v.replaced_because ?? null);
      return { created: [created.compiled_truth, (created as { change_reason?: string | null }).change_reason ?? null], reasons: sorted(reasons.map((r) => JSON.stringify(r))), meta };
    },
  );

  parityTest(
    'revertToVersion restores body and frontmatter from the snapshot',
    { methods: ['putPage', 'createVersion', 'revertToVersion', 'getPage'] },
    async (engine) => {
      await engine.putPage('notes/rev-a', {
        type: 'note', title: 'Revertable', compiled_truth: 'Original body.', timeline: '', frontmatter: { stage: 'one' },
      });
      const snap = await engine.createVersion('notes/rev-a');
      await engine.putPage('notes/rev-a', {
        type: 'note', title: 'Revertable', compiled_truth: 'Edited body.', timeline: '', frontmatter: { stage: 'two' },
      });
      const edited = await engine.getPage('notes/rev-a');
      expect(edited?.compiled_truth).toBe('Edited body.');
      await engine.revertToVersion('notes/rev-a', snap.id);
      const reverted = await engine.getPage('notes/rev-a');
      expect(reverted?.compiled_truth).toBe('Original body.');
      expect(reverted?.frontmatter.stage).toBe('one');
      return { edited: pick(edited!, ['compiled_truth', 'frontmatter'] as const), reverted: pick(reverted!, ['slug', 'title', 'compiled_truth', 'frontmatter'] as const) };
    },
  );

  parityTest(
    'versions are source-scoped: a same-slug page in another source keeps its own history and revert target',
    { methods: ['putPage', 'createVersion', 'getVersions', 'revertToVersion', 'getPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'ver-other');
      await engine.putPage('notes/shared', { type: 'note', title: 'Default', compiled_truth: 'Default v1.', timeline: '' });
      await engine.putPage('notes/shared', { type: 'note', title: 'Other', compiled_truth: 'Other v1.', timeline: '' }, { sourceId: 'ver-other' });
      await engine.createVersion('notes/shared', { sourceId: 'default' });
      const otherSnap = await engine.createVersion('notes/shared', { sourceId: 'ver-other' });
      await engine.putPage('notes/shared', { type: 'note', title: 'Default', compiled_truth: 'Default v2.', timeline: '' });
      await engine.putPage('notes/shared', { type: 'note', title: 'Other', compiled_truth: 'Other v2.', timeline: '' }, { sourceId: 'ver-other' });
      const defaultBodies = (await engine.getVersions('notes/shared', { sourceId: 'default' })).map((v) => v.compiled_truth);
      const otherBodies = (await engine.getVersions('notes/shared', { sourceId: 'ver-other' })).map((v) => v.compiled_truth);
      expect(defaultBodies).toContain('Default v1.');
      expect(defaultBodies).not.toContain('Other v1.');
      expect(otherBodies).toContain('Other v1.');
      expect(otherBodies).not.toContain('Default v1.');
      await engine.revertToVersion('notes/shared', otherSnap.id, { sourceId: 'ver-other' });
      const defaultPage = await engine.getPage('notes/shared', { sourceId: 'default' });
      const otherPage = await engine.getPage('notes/shared', { sourceId: 'ver-other' });
      expect(defaultPage?.compiled_truth).toBe('Default v2.');
      expect(otherPage?.compiled_truth).toBe('Other v1.');
      return {
        defaultBodies: sorted(defaultBodies),
        otherBodies: sorted(otherBodies),
        defaultPage: defaultPage?.compiled_truth,
        otherPage: otherPage?.compiled_truth,
      };
    },
  );
});

describe('engine parity: raw data + files', () => {
  parityTest(
    'putRawData upserts per (page, source); getRawData filters by source',
    { methods: ['putPage', 'putRawData', 'getRawData'] },
    async (engine) => {
      await engine.putPage('people/raw-alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.', timeline: '' });
      await engine.putRawData('people/raw-alice', 'crustdata', { headline: 'CEO', followers: 10 });
      await engine.putRawData('people/raw-alice', 'linkedin', { title: 'Founder', skills: ['a', 'b'] });
      await engine.putRawData('people/raw-alice', 'crustdata', { headline: 'CEO at Acme', followers: 11 });
      const all = await engine.getRawData('people/raw-alice');
      const one = await engine.getRawData('people/raw-alice', 'crustdata');
      const none = await engine.getRawData('people/raw-alice', 'unknown-source');
      const noPage = await engine.getRawData('people/raw-nobody');
      expect(all).toHaveLength(2);
      expect(one).toHaveLength(1);
      expect(one[0]!.data).toEqual({ headline: 'CEO at Acme', followers: 11 });
      expect(none).toEqual([]);
      expect(noPage).toEqual([]);
      const view = (r: (typeof all)[number]) => pick(r, ['source', 'data', 'fetched_at'] as const);
      return { all: sorted(all.map(view), (r) => r.source), one: one.map(view), none, noPage };
    },
  );

  parityTest(
    'raw data follows the page soft-delete; includeDeleted opts in; sources scope same-slug pages',
    { methods: ['putPage', 'putRawData', 'getRawData', 'softDeletePage', 'restorePage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'raw-other');
      await engine.putPage('notes/raw-shared', { type: 'note', title: 'D', compiled_truth: 'D.', timeline: '' });
      await engine.putPage('notes/raw-shared', { type: 'note', title: 'O', compiled_truth: 'O.', timeline: '' }, { sourceId: 'raw-other' });
      await engine.putRawData('notes/raw-shared', 'feed', { who: 'default' }, { sourceId: 'default' });
      await engine.putRawData('notes/raw-shared', 'feed', { who: 'other' }, { sourceId: 'raw-other' });
      const defaultRows = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default' });
      const otherRows = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'raw-other' });
      await engine.softDeletePage('notes/raw-shared', { sourceId: 'default' });
      const hidden = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default' });
      const shown = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default', includeDeleted: true });
      const otherStill = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'raw-other' });
      await engine.restorePage('notes/raw-shared', { sourceId: 'default' });
      const restored = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default' });
      expect(defaultRows.map((r) => r.data)).toEqual([{ who: 'default' }]);
      expect(otherRows.map((r) => r.data)).toEqual([{ who: 'other' }]);
      expect(hidden).toEqual([]);
      expect(shown.map((r) => r.data)).toEqual([{ who: 'default' }]);
      expect(restored.map((r) => r.data)).toEqual([{ who: 'default' }]);
      return {
        defaultRows: defaultRows.map((r) => r.data),
        otherRows: otherRows.map((r) => r.data),
        hidden: hidden.map((r) => r.data),
        shown: shown.map((r) => r.data),
        otherStill: otherStill.map((r) => r.data),
        restored: restored.map((r) => r.data),
      };
    },
  );

  parityTest(
    'upsertFile creates then no-ops on same hash, updates in place on a new hash; getFile reads by identity',
    { methods: ['upsertFile', 'getFile'] },
    async (engine) => {
      const spec = {
        filename: 'photo.png', storage_path: 'assets/photo.png', mime_type: 'image/png', size_bytes: 1234,
        content_hash: 'hash-1', metadata: { width: 10, height: 20 },
      };
      const created = await engine.upsertFile(spec);
      const same = await engine.upsertFile(spec);
      const replaced = await engine.upsertFile({ ...spec, content_hash: 'hash-2', size_bytes: 4321, metadata: { width: 11, height: 21 } });
      const read = await engine.getFile('default', 'assets/photo.png');
      const missing = await engine.getFile('default', 'assets/missing.png');
      const wrongSource = await engine.getFile('other-source', 'assets/photo.png');
      expect(created.created).toBe(true);
      expect(same.created).toBe(false);
      expect(replaced.created).toBe(false);
      expect(same.id).toBe(created.id);
      expect(replaced.id).toBe(created.id);
      expect(read?.content_hash).toBe('hash-2');
      expect(Number(read?.size_bytes)).toBe(4321);
      return { created: created.created, same: same.created, replaced: replaced.created, read: fileView(read), size: sizeOf(read), missing, wrongSource };
    },
  );

  parityTest(
    'listFilesForPage returns the files attached to that page only',
    { methods: ['putPage', 'upsertFile', 'listFilesForPage', 'getFile'] },
    async (engine) => {
      const alice = await engine.putPage('people/file-alice', { type: 'person', title: 'Alice', compiled_truth: 'A.', timeline: '' });
      const bob = await engine.putPage('people/file-bob', { type: 'person', title: 'Bob', compiled_truth: 'B.', timeline: '' });
      await engine.upsertFile({ page_slug: 'people/file-alice', page_id: alice.id, filename: 'b.png', storage_path: 'a/b.png', content_hash: 'h-b', mime_type: 'image/png', size_bytes: 2 });
      await engine.upsertFile({ page_slug: 'people/file-alice', page_id: alice.id, filename: 'a.png', storage_path: 'a/a.png', content_hash: 'h-a', mime_type: 'image/png', size_bytes: 1 });
      await engine.upsertFile({ page_slug: 'people/file-bob', page_id: bob.id, filename: 'c.png', storage_path: 'a/c.png', content_hash: 'h-c' });
      await engine.upsertFile({ filename: 'orphan.png', storage_path: 'a/orphan.png', content_hash: 'h-o' });
      const forAlice = await engine.listFilesForPage(alice.id);
      const forBob = await engine.listFilesForPage(bob.id);
      const orphan = await engine.getFile('default', 'a/orphan.png');
      expect(forAlice).toHaveLength(2);
      expect(forBob).toHaveLength(1);
      expect(orphan?.page_id).toBeNull();
      expect(forAlice.map(sizeOf).sort()).toEqual([1, 2]);
      return {
        alice: sorted(forAlice.map(fileView), (f) => f!.storage_path),
        aliceSizes: forAlice.map((f) => `${f.storage_path}:${sizeOf(f)}`).sort(),
        bob: forBob.map(fileView),
        orphan: fileView(orphan),
        empty: await engine.listFilesForPage(-1),
      };
    },
  );
});

describe('engine parity: attachments follow a renamed page', () => {
  parityTest(
    'updateSlug moves the page\'s attachments by page id; a slug-only one and another page\'s stay',
    { methods: ['putPage', 'upsertFile', 'updateSlug', 'getFile', 'getPage'] },
    async (engine) => {
      await engine.putPage('notes/move-me', { type: 'note', title: 'Move me', compiled_truth: 'x', timeline: '' });
      await engine.putPage('notes/other', { type: 'note', title: 'Other', compiled_truth: 'y', timeline: '' });
      const moved = (await engine.getPage('notes/move-me'))!.id;
      const other = (await engine.getPage('notes/other'))!.id;
      const file = (storage_path: string, page_id: number | null) => engine.upsertFile({
        source_id: 'default', page_slug: 'notes/move-me', page_id, filename: storage_path.split('/').pop()!, storage_path,
        mime_type: 'image/png', size_bytes: 1, content_hash: 'h', metadata: {},
      });
      await file('a/bound.png', moved);
      await file('a/loose.png', null);
      await file('a/foreign.png', other);
      expect(await engine.updateSlug('notes/move-me', 'notes/moved', { sourceId: 'default' })).toBe(1);
      const slugOf = async (path: string) => (await engine.getFile('default', path))?.page_slug ?? null;
      const out = { bound: await slugOf('a/bound.png'), loose: await slugOf('a/loose.png'), foreign: await slugOf('a/foreign.png') };
      expect(out).toEqual({ bound: 'notes/moved', loose: 'notes/move-me', foreign: 'notes/move-me' });
      return out;
    },
  );

  parityTest(
    'updateSlug leaves a slug-only attachment an earlier rename left behind when an unrelated page reused the name',
    { methods: ['putPage', 'upsertFile', 'updateSlug', 'getFile'] },
    async (engine) => {
      await engine.putPage('notes/reused', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '' });
      expect(await engine.updateSlug('notes/reused', 'notes/first-owner', { sourceId: 'default' })).toBe(1);
      await engine.upsertFile({ source_id: 'default', page_slug: 'notes/reused', page_id: null, filename: 'left.png', storage_path: 'b/left.png', mime_type: 'image/png', size_bytes: 1, content_hash: 'h', metadata: {} });
      await engine.putPage('notes/reused', { type: 'note', title: 'C', compiled_truth: 'y', timeline: '' });
      expect(await engine.updateSlug('notes/reused', 'notes/second-owner', { sourceId: 'default' })).toBe(1);
      const left = (await engine.getFile('default', 'b/left.png'))?.page_slug ?? null;
      expect(left).toBe('notes/reused');
      return { left };
    },
  );

  parityTest(
    'updateSlug leaves a slug-only attachment when a later page reuses the name after the earlier page was deleted',
    { methods: ['putPage', 'upsertFile', 'updateSlug', 'deletePages', 'getFile'] },
    async (engine) => {
      await engine.putPage('notes/scrubbed', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '' });
      expect(await engine.updateSlug('notes/scrubbed', 'notes/gone-owner', { sourceId: 'default' })).toBe(1);
      await engine.upsertFile({ source_id: 'default', page_slug: 'notes/scrubbed', page_id: null, filename: 'kept.png', storage_path: 'c/kept.png', mime_type: 'image/png', size_bytes: 1, content_hash: 'h', metadata: {} });
      await engine.deletePages(['notes/gone-owner'], { sourceId: 'default' });
      await engine.putPage('notes/scrubbed', { type: 'note', title: 'C', compiled_truth: 'y', timeline: '' });
      expect(await engine.updateSlug('notes/scrubbed', 'notes/new-owner', { sourceId: 'default' })).toBe(1);
      const kept = (await engine.getFile('default', 'c/kept.png'))?.page_slug ?? null;
      expect(kept).toBe('notes/scrubbed');
      return { kept };
    },
  );
});
