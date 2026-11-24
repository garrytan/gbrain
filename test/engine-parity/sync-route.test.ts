/**
 * BrainEngine parity — the git-sync route members (`advanceSourceCommit`, `listSourcePathPages`,
 * `readRenameIdentityRows`, `readLiveIdentityHolders`, `readPageSizeRows`, `holdPageEmbedding`) that `src/core/sync-anchor.ts`,
 * `src/commands/sync/full.ts`, `src/core/sync-rename-identity.ts` and `src/core/page-embedding-budget.ts` call instead
 * of raw SQL, so a git sync runs on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: advancing a source's commit stores it, so `getSource`, `readPlainSyncSource` and `listSourceRecords` read
 *    it back; a newest-content time is stored when given, cleared when given null and kept when not given; an unknown
 *    source is a no-op. The path-page list holds the live pages of one source that have a source path. The rename
 *    read returns the live pages of one source whose path or slug is listed, with their title. The live-identity read
 *    returns the live pages of one source whose frontmatter id or title is listed, with the id as text. The size read
 *    returns the live pages of one source (only the listed slugs when given) that carry embed_skip, a body over the
 *    limit or an embedding hold, with the body bytes and the hold's state and reason.
 *  - Regression: an engine that never stores the commit (every sync then runs as a first sync and rewrites the whole
 *    checkout), clears the newest-content time on a plain advance, lists soft-deleted pages or pages of another source
 *    (a full sync then deletes or keeps the wrong pages), or matches a rename against a deleted page.
 *  - Why existing coverage misses it: the sync tests run on PGLite and Postgres only, and the Rust engine refused
 *    these reads as raw SQL.
 *  - Seam: none. Real engines, typed members only.
 */
import { describe, expect } from 'bun:test';
import type { PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, sourcePath: string | null, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type: 'note', title, compiled_truth: `The ${title} note.`, source_path: sourcePath, frontmatter });

const iso = (value: unknown): string | null => (value == null ? null : new Date(value as string | Date).toISOString());

describe('engine parity: git-sync route members', () => {
  parityTest('advanceSourceCommit stores the commit and sets, clears or keeps the newest-content time', { methods: ['advanceSourceCommit', 'getSource', 'readPlainSyncSource', 'listSourceRecords'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    const before = (await engine.getSource('repo'))?.last_commit ?? null;
    const record = async () => {
      const row = (await engine.listSourceRecords()).find(r => r.id === 'repo');
      return { last_commit: row?.last_commit ?? null, newest: iso(row?.newest_content_at), synced: row?.last_sync_at != null };
    };
    await engine.advanceSourceCommit('repo', 'aaaa111', '2026-01-02T03:04:05.000Z');
    const set = { detail: (await engine.getSource('repo'))?.last_commit ?? null, plain: (await engine.readPlainSyncSource('repo'))?.last_commit ?? null, record: await record() };
    await engine.advanceSourceCommit('repo', 'bbbb222');
    const kept = await record();
    await engine.advanceSourceCommit('repo', 'cccc333', null);
    const cleared = await record();
    await engine.advanceSourceCommit('missing', 'dddd444', null);
    const missing = await engine.getSource('missing');
    const result = { before, set, kept, cleared, missing };
    expect(result).toEqual({
      before: null,
      set: { detail: 'aaaa111', plain: 'aaaa111', record: { last_commit: 'aaaa111', newest: '2026-01-02T03:04:05.000Z', synced: true } },
      kept: { last_commit: 'bbbb222', newest: '2026-01-02T03:04:05.000Z', synced: true },
      cleared: { last_commit: 'cccc333', newest: null, synced: true },
      missing: null,
    });
    return result;
  });

  parityTest('listSourcePathPages lists the live pages of one source that have a source path', { methods: ['listSourcePathPages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    await engine.putPage('notes/a', page('A', 'notes/a.md'), { sourceId: 'repo' });
    await engine.putPage('notes/b', page('B', 'notes/b.md'), { sourceId: 'repo' });
    await engine.putPage('notes/no-path', page('No path', null), { sourceId: 'repo' });
    await engine.putPage('notes/gone', page('Gone', 'notes/gone.md'), { sourceId: 'repo' });
    await engine.softDeletePage('notes/gone', { sourceId: 'repo' });
    await engine.putPage('notes/other', page('Other', 'notes/other.md'), { sourceId: 'repo-2' });
    const rows = sorted(await engine.listSourcePathPages('repo'), r => r.slug);
    const empty = await engine.listSourcePathPages('missing');
    expect(rows).toEqual([{ slug: 'notes/a', source_path: 'notes/a.md' }, { slug: 'notes/b', source_path: 'notes/b.md' }]);
    expect(empty).toEqual([]);
    return { rows, empty };
  });

  parityTest('readRenameIdentityRows matches live pages of one source by path or slug', { methods: ['readRenameIdentityRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    await engine.putPage('notes/by-path', page('By path', 'notes/by-path.md'), { sourceId: 'repo' });
    await engine.putPage('notes/by-slug', page('By slug', 'elsewhere/by-slug.md'), { sourceId: 'repo' });
    await engine.putPage('notes/unlisted', page('Unlisted', 'notes/unlisted.md'), { sourceId: 'repo' });
    await engine.putPage('notes/gone', page('Gone', 'notes/gone.md'), { sourceId: 'repo' });
    await engine.softDeletePage('notes/gone', { sourceId: 'repo' });
    await engine.putPage('notes/by-path', page('Other source', 'notes/by-path.md'), { sourceId: 'repo-2' });
    const rows = sorted(await engine.readRenameIdentityRows('repo', ['notes/by-path.md', 'notes/gone.md'], ['notes/by-slug', 'notes/gone']), r => r.slug);
    const none = await engine.readRenameIdentityRows('repo', [], []);
    expect(rows).toEqual([
      { slug: 'notes/by-path', source_path: 'notes/by-path.md', title: 'By path' },
      { slug: 'notes/by-slug', source_path: 'elsewhere/by-slug.md', title: 'By slug' },
    ]);
    expect(none).toEqual([]);
    return { rows, none };
  });

  parityTest('readLiveIdentityHolders matches live pages of one source by frontmatter id or title', { methods: ['readLiveIdentityHolders'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    await engine.putPage('notes/by-id', page('Some title', 'notes/by-id.md', { id: 'doc-1' }), { sourceId: 'repo' });
    await engine.putPage('notes/by-title', page('Shared title', 'notes/by-title.md'), { sourceId: 'repo' });
    await engine.putPage('notes/numeric-id', page('Numeric', 'notes/numeric-id.md', { id: 42 }), { sourceId: 'repo' });
    await engine.putPage('notes/unlisted', page('Unlisted', 'notes/unlisted.md', { id: 'doc-9' }), { sourceId: 'repo' });
    await engine.putPage('notes/gone', page('Shared title', 'notes/gone.md', { id: 'doc-1' }), { sourceId: 'repo' });
    await engine.softDeletePage('notes/gone', { sourceId: 'repo' });
    await engine.putPage('notes/other', page('Shared title', 'notes/other.md', { id: 'doc-1' }), { sourceId: 'repo-2' });
    const rows = sorted(await engine.readLiveIdentityHolders('repo', ['doc-1', '42'], ['Shared title']), r => r.slug);
    expect(rows).toEqual([
      { slug: 'notes/by-id', source_path: 'notes/by-id.md', fm_id: 'doc-1', title: 'Some title' },
      { slug: 'notes/by-title', source_path: 'notes/by-title.md', fm_id: null, title: 'Shared title' },
      { slug: 'notes/numeric-id', source_path: 'notes/numeric-id.md', fm_id: '42', title: 'Numeric' },
    ]);
    return { rows };
  });

  parityTest('readPageSizeRows lists the live embed_skip or over-limit pages of one source, only the listed slugs when given', { methods: ['readPageSizeRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    const big = (title: string): PageInput => ({ type: 'note', title, compiled_truth: 'x'.repeat(120), timeline: 'y'.repeat(10), source_path: null, frontmatter: {} });
    await engine.putPage('notes/big', big('Big'), { sourceId: 'repo' });
    await engine.putPage('notes/skip', page('Skip', 'notes/skip.md', { embed_skip: true }), { sourceId: 'repo' });
    await engine.putPage('notes/small', page('Small', 'notes/small.md'), { sourceId: 'repo' });
    await engine.putPage('notes/gone', big('Gone'), { sourceId: 'repo' });
    await engine.softDeletePage('notes/gone', { sourceId: 'repo' });
    await engine.putPage('notes/other', big('Other'), { sourceId: 'repo-2' });
    const shape = (rows: Awaited<ReturnType<typeof engine.readPageSizeRows>>) =>
      sorted(rows, r => r.slug).map(r => ({ slug: r.slug, bytes: Number(r.bytes), segmented: r.segmented === true, embed_skip: r.frontmatter?.embed_skip ?? null, state: r.state ?? null, reason: r.reason ?? null }));
    const all = shape(await engine.readPageSizeRows('repo', 64, null));
    const listed = shape(await engine.readPageSizeRows('repo', 64, ['notes/skip', 'notes/small', 'notes/gone']));
    const none = await engine.readPageSizeRows('repo', 64, []);
    expect(all).toEqual([
      { slug: 'notes/big', bytes: 130, segmented: false, embed_skip: null, state: null, reason: null },
      { slug: 'notes/skip', bytes: 'The Skip note.'.length, segmented: false, embed_skip: true, state: null, reason: null },
    ]);
    expect(listed).toEqual([all[1]]);
    expect(none).toEqual([]);
    return { all, listed, none };
  });

  parityTest('readPageSizeRows reports a held page with its hold state and reason, a small held page included', { methods: ['readPageSizeRows', 'holdPageEmbedding'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    await engine.putPage('notes/big', { type: 'note', title: 'Big', compiled_truth: 'x'.repeat(120), source_path: null, frontmatter: {} }, { sourceId: 'repo' });
    await engine.putPage('notes/small', page('Small', 'notes/small.md'), { sourceId: 'repo' });
    await engine.putPage('notes/plain', page('Plain', 'notes/plain.md'), { sourceId: 'repo' });
    const id = async (slug: string) => (await engine.getPage(slug, { sourceId: 'repo' }))!.id;
    await engine.holdPageEmbedding(await id('notes/big'), 'awaiting_approval');
    await engine.holdPageEmbedding(await id('notes/small'), 'archive_backfill');
    await engine.holdPageEmbedding(await id('notes/small'), 'archive_open_day');
    const shape = (rows: Awaited<ReturnType<typeof engine.readPageSizeRows>>) =>
      sorted(rows, r => r.slug).map(r => ({ slug: r.slug, bytes: Number(r.bytes), state: r.state ?? null, reason: r.reason ?? null }));
    const all = shape(await engine.readPageSizeRows('repo', 64, null));
    const listed = shape(await engine.readPageSizeRows('repo', 64, ['notes/small', 'notes/plain']));
    expect(all).toEqual([
      { slug: 'notes/big', bytes: 120, state: 'held', reason: 'awaiting_approval' },
      { slug: 'notes/small', bytes: 'The Small note.'.length, state: 'held', reason: 'archive_open_day' },
    ]);
    expect(listed).toEqual([all[1]]);
    return { all, listed };
  });
});
