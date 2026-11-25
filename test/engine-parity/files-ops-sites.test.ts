/**
 * BrainEngine parity: the files statements the `gbrain files` commands (src/commands/files.ts) and the file operations
 * (src/core/ops/files.ts) ran through `executeRaw`, `executeRawJsonb` and the `sqlQueryForEngine` tag before they were
 * members (src/core/engine-sql/files-ops.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the three command upserts (upsertCliFileRow, upsertRawFileRow, upsertSyncFileRow) write one files row and
 *    on a repeated storage path update the hash, size and type and merge the metadata; listFiles (the engine's
 *    one list member, `files list`) and listFileRowsForVerify read them in page-then-name and path order; hasFileWithHash says whether
 *    the pair is stored; readSourceLocalPathForVerify answers a source's checkout or null; sourceIdExists and
 *    readPageIdInSource say whether a source and a page in it exist; readFileOwner answers the row holding a path;
 *    claimFilePage moves a row to a source and page; upsertOpFileRow keeps an existing row's source and page when the
 *    new one names no page; countFilesRegisteredElsewhere counts the rows at a path whose page, name, source or page id
 *    differ; registerFileRow writes a new row or refreshes the same identity and writes nothing for another; and the
 *    readable reads (listReadableFileRows, readReadableFileForUrl, readReadablePageId, countUnreadableFilesAt,
 *    readReadableFileForVerify, listReadableFilePaths) hide a file attached to a private page when the caller excludes
 *    private pages, by the page's id or by its slug in any source (a soft-deleted private page still hides), and show
 *    every file when it does not. The lists cap at 100 rows (1000 for verify) after the readable filter. A write that
 *    names a source or page that does not exist writes nothing.
 *  - Regression: `gbrain files upload`, `sync`, `verify` and the file_list, file_upload, file_url, file_register and
 *    file_verify operations read and write through these statements; an engine that drops a clause lists a private
 *    page's attachment to a remote caller, lets an upload move another source's file, or writes the wrong merged metadata.
 *  - Why existing coverage misses it: the statements ran through `executeRaw` and the tag, which the parity cases
 *    cannot call (D18), so no case compared them across engines.
 *  - Seam: none. Sources come from the harness fixture, pages from putPage, rows from the typed members. Ids differ
 *    between arms, so a page id is compared only by whether it is the page's own, and a size is read as a number
 *    (Postgres returns a BIGINT as a BigInt). Names that sort differently by byte and by locale (a hyphen, a capital)
 *    are not used: PGLite orders text bytewise and a Postgres database with a locale collation does not.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: 'x', timeline: '', frontmatter });

const row = (storage_path: string, over: Record<string, unknown> = {}) => ({
  page_slug: null as string | null, filename: storage_path.split('/').at(-1)!, storage_path, mime_type: 'image/png' as string | null,
  size_bytes: 10, content_hash: `hash-${storage_path}`, ...over,
});

/** A files row as every engine reports it, without its id or clock. */
const shown = (row: object) => {
  const r = row as Record<string, unknown>;
  return {
    page_slug: r.page_slug, filename: r.filename, storage_path: r.storage_path, mime_type: r.mime_type,
    size_bytes: r.size_bytes == null ? null : Number(r.size_bytes), content_hash: r.content_hash, metadata: r.metadata,
  };
};

async function pageId(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<number> {
  const id = await engine.readPageIdInSource(slug, sourceId);
  expect(id).not.toBeNull();
  return id!;
}

describe('engine parity: files commands and file operations statements', () => {
  parityTest('the command upserts write a row, merge the metadata on a repeat, and the list reads see it', {
    methods: ['upsertCliFileRow', 'upsertRawFileRow', 'upsertSyncFileRow', 'listFiles', 'listFileRowsForVerify', 'hasFileWithHash'],
  }, async (engine) => {
    await engine.upsertCliFileRow(row('plan/a.png', { page_slug: 'plan' }), { storage: 'local' });
    await engine.upsertRawFileRow({ ...row('plan/b.pdf', { page_slug: 'plan', mime_type: 'application/pdf', content_hash: 'sha256:bbb' }), source_id: 'default' }, { storage: 'git', type: 'pdf' });
    await engine.upsertSyncFileRow(row('loose.txt', { mime_type: 'text/plain', size_bytes: 3 }), { storage: 's3' });
    // A repeat of a stored path takes the new hash, size and type, and keeps what the old metadata held beside the new keys.
    await engine.upsertCliFileRow(row('plan/a.png', { page_slug: 'plan', size_bytes: 20, content_hash: 'hash-new', mime_type: 'image/jpeg' }), { storage: 's3', upload_method: 'standard' });
    const out = {
      all: (await engine.listFiles({ limit: 100 })).map(shown),
      plan: (await engine.listFiles({ pageSlug: 'plan', limit: 100 })).map(shown),
      none: (await engine.listFiles({ pageSlug: 'nowhere', limit: 100 })).map(shown),
      verify: (await engine.listFileRowsForVerify()).map(shown),
      sourceOfRaw: (await engine.listFiles({ limit: 100 })).find(r => r.storage_path === 'plan/b.pdf')!.source_id,
      hashed: await engine.hasFileWithHash('hash-new', 'plan/a.png'),
      oldHash: await engine.hasFileWithHash('hash-plan/a.png', 'plan/a.png'),
      otherPath: await engine.hasFileWithHash('hash-new', 'plan/b.pdf'),
    };
    expect(out.all.map(r => r.storage_path)).toEqual(['plan/a.png', 'plan/b.pdf', 'loose.txt']);
    expect(out.verify.map(r => r.storage_path)).toEqual(['loose.txt', 'plan/a.png', 'plan/b.pdf']);
    expect(out.plan[0]).toMatchObject({ size_bytes: 20, mime_type: 'image/jpeg', content_hash: 'hash-new', metadata: { storage: 's3', upload_method: 'standard' } });
    expect(out.plan[1]).toMatchObject({ content_hash: 'sha256:bbb', metadata: { storage: 'git', type: 'pdf' } });
    expect(out).toMatchObject({ none: [], sourceOfRaw: 'default', hashed: true, oldHash: false, otherPath: false });
    return out;
  });

  parityTest('readSourceLocalPathForVerify, sourceIdExists and readPageIdInSource read the source and page a file attaches to', {
    methods: ['readSourceLocalPathForVerify', 'sourceIdExists', 'readPageIdInSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'checked-out', {}, '/var/brain/checked-out');
    await createSource(engine, backend, 'no-checkout');
    await engine.putPage('notes/plan', note('Plan'));
    await engine.putPage('notes/elsewhere', note('Elsewhere'), { sourceId: 'no-checkout' });
    const found = await engine.readPageIdInSource('notes/plan', 'default');
    const out = {
      checkedOut: await engine.readSourceLocalPathForVerify('checked-out'),
      noCheckout: await engine.readSourceLocalPathForVerify('no-checkout'),
      unknown: await engine.readSourceLocalPathForVerify('never-made'),
      exists: [await engine.sourceIdExists('default'), await engine.sourceIdExists('checked-out'), await engine.sourceIdExists('never-made')],
      page: { found: found !== null && found > 0, inOther: await engine.readPageIdInSource('notes/plan', 'no-checkout'),
        onlyElsewhere: await engine.readPageIdInSource('notes/elsewhere', 'default'), there: (await engine.readPageIdInSource('notes/elsewhere', 'no-checkout')) !== null },
    };
    expect(out).toEqual({
      checkedOut: '/var/brain/checked-out', noCheckout: null, unknown: null,
      exists: [true, true, false], page: { found: true, inOther: null, onlyElsewhere: null, there: true },
    });
    return out;
  });

  parityTest('the file operations read the owner of a path, claim it for a page, keep it on a page-less upsert and register once', {
    methods: ['upsertOpFileRow', 'readFileOwner', 'claimFilePage', 'countFilesRegisteredElsewhere', 'registerFileRow', 'listFiles', 'readPageIdInSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/plan', note('Plan'));
    await engine.putPage('notes/plan', note('Plan'), { sourceId: 'other' });
    const here = await pageId(engine, 'notes/plan');
    const there = await pageId(engine, 'notes/plan', 'other');
    const path = 'notes/plan/report.pdf';
    const owner = async () => {
      const o = await engine.readFileOwner(path);
      return o === null ? null : { source_id: o.source_id, page: o.page_id === null ? null : o.page_id === here ? 'here' : o.page_id === there ? 'there' : 'unknown', content_hash: o.content_hash };
    };
    const base = { page_slug: 'notes/plan', filename: 'report.pdf', storage_path: path, mime_type: 'application/pdf', size_bytes: 12, content_hash: 'h1' };
    const out: Record<string, unknown> = { before: await owner() };
    await engine.upsertOpFileRow({ ...base, source_id: 'default', page_id: here }, { storage: 'local' });
    out.uploaded = await owner();
    // An upload under another source with no page of its own keeps the row's source and page.
    await engine.upsertOpFileRow({ ...base, content_hash: 'h2', source_id: 'other', page_id: null }, { storage: 'local' });
    out.pageless = await owner();
    await engine.claimFilePage(path, 'other', there);
    out.claimed = await owner();
    out.countMatching = await engine.countFilesRegisteredElsewhere({ storage_path: path, page_slug: 'notes/plan', filename: 'report.pdf', source_id: 'other', page_id: there });
    out.countOtherSource = await engine.countFilesRegisteredElsewhere({ storage_path: path, page_slug: 'notes/plan', filename: 'report.pdf', source_id: 'default', page_id: there });
    out.countOtherName = await engine.countFilesRegisteredElsewhere({ storage_path: path, page_slug: 'notes/plan', filename: 'other.pdf', source_id: 'other', page_id: there });
    out.countOtherPage = await engine.countFilesRegisteredElsewhere({ storage_path: path, page_slug: null, filename: 'report.pdf', source_id: 'other', page_id: null });
    out.countNoRow = await engine.countFilesRegisteredElsewhere({ storage_path: 'nothing.pdf', page_slug: null, filename: 'nothing.pdf', source_id: 'other', page_id: null });
    out.refreshed = await engine.registerFileRow({ ...base, content_hash: 'h3', size_bytes: 15, source_id: 'other', page_id: there }, { storage: 'local', prefix: 'p' });
    out.refusedElsewhere = await engine.registerFileRow({ ...base, filename: 'moved.pdf', source_id: 'other', page_id: there }, { storage: 'local' });
    out.registeredNew = await engine.registerFileRow({ ...base, storage_path: 'notes/plan/new.pdf', filename: 'new.pdf', source_id: 'default', page_id: here }, { storage: 'local' });
    out.rows = (await engine.listFiles({ limit: 100 })).map(shown);
    expect(out).toMatchObject({
      before: null,
      uploaded: { source_id: 'default', page: 'here', content_hash: 'h1' },
      pageless: { source_id: 'default', page: 'here', content_hash: 'h2' },
      claimed: { source_id: 'other', page: 'there', content_hash: 'h2' },
      countMatching: 0, countOtherSource: 1, countOtherName: 1, countOtherPage: 1, countNoRow: 0,
      refreshed: true, refusedElsewhere: false, registeredNew: true,
    });
    return out;
  });

  parityTest('the readable file reads hide a private page\'s attachment from a caller that excludes private pages', {
    methods: ['listReadableFileRows', 'readReadableFileForUrl', 'readReadablePageId', 'countUnreadableFilesAt', 'readReadableFileForVerify', 'listReadableFilePaths', 'upsertFile', 'readPageIdInSource'],
  }, async (engine) => {
    await engine.putPage('notes/open', note('Open'));
    await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
    const privateId = await pageId(engine, 'notes/private');
    const openId = await pageId(engine, 'notes/open');
    await engine.upsertFile({ page_slug: 'notes/open', page_id: openId, filename: 'a.png', storage_path: 'open/a.png', content_hash: 'ha', size_bytes: 1 });
    await engine.upsertFile({ page_slug: 'notes/private', page_id: privateId, filename: 'b.png', storage_path: 'private/b.png', content_hash: 'hb', size_bytes: 2 });
    // A row that names its private page only by slug, as a loosely attached file does.
    await engine.upsertFile({ page_slug: 'notes/private', page_id: null, filename: 'c.png', storage_path: 'loose/c.png', content_hash: 'hc', size_bytes: 3 });
    await engine.upsertFile({ page_slug: null, page_id: null, filename: 'd.png', storage_path: 'unlinked/d.png', content_hash: 'hd', size_bytes: 4 });
    const names = (rows: Array<Record<string, unknown>>) => rows.map(r => r.storage_path);
    const out: Record<string, unknown> = {};
    for (const exclude of [false, true]) {
      const key = exclude ? 'excluded' : 'shown';
      out[key] = {
        list: names(await engine.listReadableFileRows(undefined, exclude)),
        listPage: names(await engine.listReadableFileRows('notes/private', exclude)),
        url: [await engine.readReadableFileForUrl('private/b.png', exclude), await engine.readReadableFileForUrl('open/a.png', exclude)].map(r => r === null ? null : { storage_path: r.storage_path, mime_type: r.mime_type, size_bytes: Number(r.size_bytes) }),
        pageIds: [await engine.readReadablePageId('notes/private', 'default', exclude), await engine.readReadablePageId('notes/open', 'default', exclude)].map(id => id === undefined ? 'hidden' : 'readable'),
        unreadable: [await engine.countUnreadableFilesAt('private/b.png', exclude), await engine.countUnreadableFilesAt('loose/c.png', exclude), await engine.countUnreadableFilesAt('open/a.png', exclude)],
        verify: [await engine.readReadableFileForVerify('private/b.png', exclude), await engine.readReadableFileForVerify('open/a.png', exclude)].map(r => r === null ? null : { size: Number(r.size_bytes), hash: r.content_hash }),
        paths: (await engine.listReadableFilePaths(undefined, exclude)).map(r => ({ ...r })),
        pathsPage: (await engine.listReadableFilePaths('notes/private', exclude)).map(r => ({ ...r })),
      };
    }
    expect(out).toMatchObject({
      shown: {
        list: ['open/a.png', 'private/b.png', 'loose/c.png', 'unlinked/d.png'], listPage: ['private/b.png', 'loose/c.png'],
        pageIds: ['readable', 'readable'], unreadable: [0, 0, 0],
      },
      excluded: {
        list: ['open/a.png', 'unlinked/d.png'], listPage: [],
        url: [null, { storage_path: 'open/a.png', mime_type: null, size_bytes: 1 }], pageIds: ['hidden', 'readable'],
        unreadable: [1, 1, 0], verify: [null, { size: 1, hash: 'ha' }],
        paths: [{ storage_path: 'open/a.png', page_slug: 'notes/open' }, { storage_path: 'unlinked/d.png', page_slug: null }], pathsPage: [],
      },
    });
    // A caller with unrestricted member access still has the privacy part applied, as the operations pass it.
    out.unrestrictedExcluded = await withCallerAccess({ restricted: false }, async () => names(await engine.listReadableFileRows(undefined, true)));
    return out;
  });

  parityTest('a file names its page loosely, so a private page in any source hides it, a deleted one too, and a page id is read per source', {
    methods: ['readReadablePageId', 'countUnreadableFilesAt', 'listReadableFileRows', 'listReadableFilePaths', 'readReadableFileForUrl', 'readReadableFileForVerify', 'readPageIdInSource', 'softDeletePage', 'upsertFile'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/shared', note('Shared'));
    await engine.putPage('notes/shared', note('Shared private', { visibility: 'private' }), { sourceId: 'other' });
    await engine.putPage('notes/solo', note('Solo', { visibility: 'private' }));
    await engine.softDeletePage('notes/solo');
    await engine.putPage('notes/open', note('Open'));
    const sharedHere = await pageId(engine, 'notes/shared');
    const sharedThere = await pageId(engine, 'notes/shared', 'other');
    const open = await pageId(engine, 'notes/open');
    // Named by slug only: a private page at that slug in another source hides it, though the page id is the open one.
    await engine.upsertFile({ page_slug: 'notes/shared', page_id: sharedHere, filename: 'a.png', storage_path: 'x/by-slug.png', content_hash: 'h1', size_bytes: 1 });
    // Named by the private page's id alone, in the other source.
    await engine.upsertFile({ source_id: 'other', page_slug: null, page_id: sharedThere, filename: 'b.png', storage_path: 'x/by-id.png', content_hash: 'h2', size_bytes: 2 });
    // The private page is soft-deleted; the statement does not look at deleted_at.
    await engine.upsertFile({ page_slug: 'notes/solo', page_id: null, filename: 'c.png', storage_path: 'x/deleted.png', content_hash: 'h3', size_bytes: 3 });
    await engine.upsertFile({ page_slug: 'notes/open', page_id: open, filename: 'd.png', storage_path: 'x/open.png', content_hash: 'h4', size_bytes: 4 });
    const out: Record<string, unknown> = {};
    for (const exclude of [false, true]) {
      const readable = async (slug: string, source: string) => (await engine.readReadablePageId(slug, source, exclude)) === undefined ? 'hidden' : 'readable';
      out[exclude ? 'excluded' : 'shown'] = {
        pageIds: [await readable('notes/shared', 'default'), await readable('notes/shared', 'other'), await readable('notes/solo', 'default'),
          await readable('notes/open', 'default'), await readable('notes/open', 'other'), await readable('notes/missing', 'default')],
        unreadable: [await engine.countUnreadableFilesAt('x/by-slug.png', exclude), await engine.countUnreadableFilesAt('x/by-id.png', exclude),
          await engine.countUnreadableFilesAt('x/deleted.png', exclude), await engine.countUnreadableFilesAt('x/open.png', exclude), await engine.countUnreadableFilesAt('x/nothing.png', exclude)],
        rows: (await engine.listReadableFileRows(undefined, exclude)).map(r => r.storage_path),
        rowsOfPage: (await engine.listReadableFileRows('notes/shared', exclude)).map(r => r.storage_path),
        paths: (await engine.listReadableFilePaths(undefined, exclude)).map(r => r.storage_path),
        url: [await engine.readReadableFileForUrl('x/by-slug.png', exclude), await engine.readReadableFileForUrl('x/open.png', exclude), await engine.readReadableFileForUrl('x/nothing.png', exclude)].map(r => r?.storage_path ?? null),
        verify: [await engine.readReadableFileForVerify('x/deleted.png', exclude), await engine.readReadableFileForVerify('x/by-id.png', exclude)].map(r => r === null ? null : r.content_hash),
      };
    }
    out.deletedPageStillFound = (await engine.readPageIdInSource('notes/solo', 'default')) !== null;
    expect(out).toMatchObject({
      shown: {
        pageIds: ['readable', 'readable', 'readable', 'readable', 'hidden', 'hidden'], unreadable: [0, 0, 0, 0, 0],
        rows: ['x/open.png', 'x/by-slug.png', 'x/deleted.png', 'x/by-id.png'], rowsOfPage: ['x/by-slug.png'], verify: ['h3', 'h2'],
      },
      excluded: {
        pageIds: ['readable', 'hidden', 'hidden', 'readable', 'hidden', 'hidden'], unreadable: [1, 1, 1, 0, 0],
        rows: ['x/open.png'], rowsOfPage: [], paths: ['x/open.png'], url: [null, 'x/open.png', null], verify: [null, null],
      },
      deletedPageStillFound: true,
    });
    return out;
  });

  parityTest('the lists stop at 100 rows after the readable filter, and the verify list at 1000', {
    methods: ['upsertCliFileRow', 'listFiles', 'listFileRowsForVerify', 'listReadableFileRows', 'listReadableFilePaths'],
  }, async (engine) => {
    await engine.putPage('apriv', note('Private', { visibility: 'private' }));
    await engine.upsertCliFileRow(row('apriv/file', { page_slug: 'apriv' }), { storage: 'local' });
    for (let n = 0; n < 101; n++) {
      await engine.upsertCliFileRow(row(`bulk/f${String(n).padStart(3, '0')}`, { page_slug: 'bulk' }), { storage: 'local' });
    }
    const paths = (rows: ReadonlyArray<{ storage_path?: unknown }>) => ({ count: rows.length, first: rows[0]?.storage_path, last: rows.at(-1)?.storage_path });
    const out = {
      all: paths(await engine.listFiles({ pageSlug: null, limit: 100 })),
      verify: paths(await engine.listFileRowsForVerify()),
      slug: paths(await engine.listFiles({ pageSlug: 'bulk', limit: 100 })),
      shown: paths(await engine.listReadableFileRows(undefined, false)),
      excluded: paths(await engine.listReadableFileRows(undefined, true)),
      pathsShown: paths(await engine.listReadableFilePaths(undefined, false)),
      pathsExcluded: paths(await engine.listReadableFilePaths(undefined, true)),
    };
    expect(out).toEqual({
      all: { count: 100, first: 'apriv/file', last: 'bulk/f098' },
      verify: { count: 102, first: 'apriv/file', last: 'bulk/f100' },
      slug: { count: 100, first: 'bulk/f000', last: 'bulk/f099' },
      shown: { count: 100, first: 'apriv/file', last: 'bulk/f098' },
      excluded: { count: 100, first: 'bulk/f000', last: 'bulk/f099' },
      pathsShown: { count: 100, first: 'apriv/file', last: 'bulk/f098' },
      pathsExcluded: { count: 100, first: 'bulk/f000', last: 'bulk/f099' },
    });
    return out;
  });

  parityTest('an upload binds the live page at its slug, a rename moves the file with the page, and an upload racing a rename takes the new slug (#10235, #10294)', {
    methods: ['upsertCliFileRow', 'upsertRawFileRow', 'upsertOpFileRow', 'updateSlug', 'softDeletePage', 'listFiles', 'readFileOwner', 'readPageIdInSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/old', note('Old'));
    await engine.putPage('people/old', note('Old'), { sourceId: 'other' });
    await engine.putPage('people/gone', note('Gone'));
    await engine.softDeletePage('people/gone');
    const here = await pageId(engine, 'people/old');
    const there = await pageId(engine, 'people/old', 'other');
    const bound = async (path: string) => {
      const o = await engine.readFileOwner(path);
      const f = (await engine.listFiles({ limit: 100 })).find(r => r.storage_path === path);
      return o === null ? null : { page: o.page_id === null ? null : o.page_id === here ? 'here' : o.page_id === there ? 'there' : 'unknown', slug: f?.page_slug ?? null, source_id: o.source_id };
    };
    // A command upload binds the live page at its slug in its source: none when the page is deleted or absent.
    await engine.upsertCliFileRow(row('c/cli.png', { page_slug: 'people/old' }), { storage: 'local' });
    await engine.upsertRawFileRow({ ...row('c/raw.png', { page_slug: 'people/old' }), source_id: 'other' }, { storage: 'git' });
    await engine.upsertCliFileRow(row('c/gone.png', { page_slug: 'people/gone' }), { storage: 'local' });
    await engine.upsertCliFileRow(row('c/none.png', { page_slug: 'people/nobody' }), { storage: 'local' });
    const out: Record<string, unknown> = {
      cli: await bound('c/cli.png'), raw: await bound('c/raw.png'), deleted: await bound('c/gone.png'), absent: await bound('c/none.png'),
    };
    // The rename moves the files bound to the page by id and named by the old slug; another source's file stays.
    out.renamed = await engine.updateSlug('people/old', 'people/new', { sourceId: 'default' });
    out.afterRename = { cli: await bound('c/cli.png'), raw: await bound('c/raw.png') };
    // An operation upload that still carries the old slug is recorded under the page's slug as it is now, new row or repeat.
    const op = { ...row('o/op.png', { page_slug: 'people/old' }), source_id: 'default', page_id: here };
    await engine.upsertOpFileRow(op, { storage: 'local' });
    out.opNew = await bound('o/op.png');
    await engine.upsertCliFileRow(row('o/op.png', { page_slug: 'people/old', content_hash: 'h2' }), { storage: 'local' });
    await engine.upsertOpFileRow({ ...op, content_hash: 'h3' }, { storage: 'local' });
    out.opRepeat = await bound('o/op.png');
    // A repeat that binds the page takes its id and slug together; one that binds no page keeps the row's pair.
    await engine.upsertCliFileRow(row('c/none.png', { page_slug: 'people/new', content_hash: 'h4' }), { storage: 'local' });
    out.bindsOnRepeat = await bound('c/none.png');
    await engine.upsertCliFileRow(row('c/none.png', { page_slug: 'people/nobody', content_hash: 'h5' }), { storage: 'local' });
    out.keepsPair = await bound('c/none.png');
    expect(out).toEqual({
      cli: { page: 'here', slug: 'people/old', source_id: 'default' }, raw: { page: 'there', slug: 'people/old', source_id: 'other' },
      deleted: { page: null, slug: 'people/gone', source_id: 'default' }, absent: { page: null, slug: 'people/nobody', source_id: 'default' },
      renamed: 1,
      afterRename: { cli: { page: 'here', slug: 'people/new', source_id: 'default' }, raw: { page: 'there', slug: 'people/old', source_id: 'other' } },
      opNew: { page: 'here', slug: 'people/new', source_id: 'default' }, opRepeat: { page: 'here', slug: 'people/new', source_id: 'default' },
      bindsOnRepeat: { page: 'here', slug: 'people/new', source_id: 'default' }, keepsPair: { page: 'here', slug: 'people/new', source_id: 'default' },
    });
    return out;
  });

  parityTest('a write that names a source or page that does not exist writes nothing, and a claim on a missing path is a no-op', {
    methods: ['upsertRawFileRow', 'upsertOpFileRow', 'registerFileRow', 'claimFilePage', 'readFileOwner', 'upsertCliFileRow', 'listFiles'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/plan', note('Plan'));
    const here = await pageId(engine, 'notes/plan');
    const base = { page_slug: 'notes/plan', filename: 'r.pdf', storage_path: 'notes/plan/r.pdf', mime_type: 'application/pdf', size_bytes: 12, content_hash: 'h1' };
    const outcome = (run: () => Promise<unknown>) => run().then(() => 'wrote', () => 'refused');
    const out: Record<string, unknown> = {
      unknownSource: await outcome(() => engine.upsertRawFileRow({ ...base, source_id: 'never-made' }, { storage: 'git' })),
      unknownPage: await outcome(() => engine.upsertOpFileRow({ ...base, source_id: 'default', page_id: 999_999 }, { storage: 'local' })),
      registerUnknownPage: await outcome(() => engine.registerFileRow({ ...base, source_id: 'default', page_id: 999_999 }, { storage: 'local' })),
      afterRefused: (await engine.listFiles({ pageSlug: null, limit: 100 })).length,
    };
    await engine.upsertCliFileRow({ ...base, page_slug: null }, { storage: 'local' });
    out.claimUnknownSource = await outcome(() => engine.claimFilePage(base.storage_path, 'never-made', here));
    out.claimUnknownPage = await outcome(() => engine.claimFilePage(base.storage_path, 'other', 999_999));
    out.claimMissingPath = await outcome(() => engine.claimFilePage('nothing.pdf', 'other', here));
    out.ownerAfter = await engine.readFileOwner(base.storage_path).then(o => o === null ? null : { source_id: o.source_id, page_id: o.page_id });
    out.missingPathOwner = await engine.readFileOwner('nothing.pdf');
    expect(out).toEqual({
      unknownSource: 'refused', unknownPage: 'refused', registerUnknownPage: 'refused', afterRefused: 0,
      claimUnknownSource: 'refused', claimUnknownPage: 'refused', claimMissingPath: 'wrote',
      ownerAfter: { source_id: 'default', page_id: null }, missingPathOwner: null,
    });
    return out;
  });

  parityTest('a repeat upsert merges the new metadata keys into the stored object, in key order, and an operation upsert keeps the other keys', {
    methods: ['upsertFile', 'upsertSyncFileRow', 'upsertOpFileRow', 'listFiles'],
  }, async (engine) => {
    await engine.putPage('notes/plan', note('Plan'));
    const here = await pageId(engine, 'notes/plan');
    await engine.upsertFile({ filename: 'o.bin', storage_path: 'object.bin', content_hash: 'h0', size_bytes: 1, metadata: { keep: 1, over: 'old' } });
    await engine.upsertSyncFileRow(row('object.bin', { filename: 'o.bin' }), { over: 'new', extra: { n: 1 } });
    await engine.upsertOpFileRow({ ...row('op.bin', { filename: 'op.bin', page_slug: 'notes/plan' }), source_id: 'default', page_id: here }, { b: 1, a: 2, ab: 3 });
    await engine.upsertOpFileRow({ ...row('op.bin', { filename: 'op.bin', page_slug: 'notes/plan' }), source_id: 'default', page_id: here }, { b: 9 });
    const out = (await engine.listFiles({ pageSlug: null, limit: 100 })).map(shown);
    expect(out.map(r => [r.storage_path, r.metadata])).toEqual([
      ['op.bin', { b: 9, a: 2, ab: 3 }], ['object.bin', { keep: 1, over: 'new', extra: { n: 1 } }],
    ]);
    return out;
  });
});
