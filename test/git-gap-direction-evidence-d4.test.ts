import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { exportBodyLedger, inlineExportMarkdown, readExportPage, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown } from '../src/core/export-snapshot.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { decideDirection } from '../src/core/persistence/git-gap.ts';
import { readConversionDecisions, writeConversionFile } from '../src/core/persistence/git-conversion.ts';
import { censusGitGap, describeGitGap, type GitGapPage } from '../src/commands/sources-git-gap.ts';
import { dbAheadOfGitEntry } from '../src/commands/doctor/checks/db-ahead-of-git.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

// d4 of the convergence plan: a page that differs from its committed file with no import record is decided by content
// evidence (its archived versions against its path's committed blobs), never by a timestamp.

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString();
}
function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
}

describe('decideDirection (d4 classifier)', () => {
  const v = (id: number, digest: string) => ({ id, digest });
  const b = (oid: string, digest: string | null) => ({ oid, digest });
  test('each state from content alone', () => {
    expect(decideDirection('row', 'head', [v(2, 'head')], [b('o1', 'older')])).toMatchObject({ kind: 'adopt_db_moved', version: 2 });
    expect(decideDirection('row', 'head', [v(2, 'older')], [b('o1', 'row')])).toMatchObject({ kind: 'git_wins_file_moved', blob: 'o1' });
    expect(decideDirection('row', 'head', [v(2, 'head')], [b('o1', 'row')])).toMatchObject({ kind: 'both_moved', basis: 'conflicting_history' });
    expect(decideDirection('row', 'head', [v(3, 'x'), v(2, 'shared')], [b('o1', 'shared')])).toMatchObject({ kind: 'both_moved', basis: 'shared_older_state', blob: 'o1', version: 2 });
    expect(decideDirection('row', 'head', [v(2, 'x')], [b('o1', 'y')])).toMatchObject({ kind: 'no_evidence', basis: 'no_shared_state' });
    expect(decideDirection('row', null, [v(2, 'x')], [b('o1', null)])).toMatchObject({ kind: 'no_evidence' });
  });
  test('a revert on one side is a move: the newest shared state decides, not any older match', () => {
    expect(decideDirection('A', 'C', [v(3, 'B'), v(2, 'A')], [b('oB', 'B'), b('oA', 'A')])).toMatchObject({ kind: 'both_moved', basis: 'conflicting_history' });
    expect(decideDirection('C', 'A', [v(3, 'B'), v(2, 'A')], [b('oB', 'B'), b('oA', 'A')])).toMatchObject({ kind: 'both_moved', basis: 'conflicting_history' });
    expect(decideDirection('B', 'C', [v(3, 'B'), v(2, 'A')], [b('oB', 'B'), b('oA', 'A')])).toMatchObject({ kind: 'git_wins_file_moved', blob: 'oB' });
    expect(decideDirection('C', 'B', [v(4, 'C'), v(3, 'B'), v(2, 'A')], [b('oA', 'A')])).toMatchObject({ kind: 'adopt_db_moved', version: 3 });
    // A revert whose middle state the other side never held: the database went A to B and back while Git edited A to C,
    // and the mirror, Git going A to B and back (the tip's blob held again) while the database went A to C.
    expect(decideDirection('A', 'C', [v(3, 'B'), v(2, 'A')], [b('oA', 'A')])).toMatchObject({ kind: 'both_moved', basis: 'conflicting_history' });
    expect(decideDirection('C', 'A', [v(2, 'A')], [b('oB', 'B'), b('oA', 'A')])).toMatchObject({ kind: 'both_moved', basis: 'conflicting_history' });
    // A no-op write that archived the row's own content is no move.
    expect(decideDirection('A', 'C', [v(3, 'A')], [b('oA', 'A')])).toMatchObject({ kind: 'git_wins_file_moved', blob: 'oA' });
  });
  test('a one-sided verdict needs the other side read in full', () => {
    const full = { versions: false, blobs: false };
    expect(decideDirection('row', 'head', [v(2, 'older')], [b('o1', 'row')], { ...full, versions: true })).toMatchObject({ kind: 'no_evidence', basis: 'history_truncated' });
    expect(decideDirection('row', 'head', [v(2, 'head')], [b('o1', 'older')], { ...full, blobs: true })).toMatchObject({ kind: 'no_evidence', basis: 'history_truncated' });
    expect(decideDirection('row', 'head', [v(2, 'older')], [b('o1', 'row')], { ...full, blobs: true })).toMatchObject({ kind: 'git_wins_file_moved' });
  });
});

for (const backend of testBackends()) describe(`git-gap direction evidence (d4): ${backend}`, () => {
  let engine: BrainEngine;
  const dirs: string[] = [];
  const tempDir = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op IN ('sync-hold','sync-import-provenance')");
    await engine.executeRaw("UPDATE sources SET local_path=NULL, config='{}'::jsonb WHERE id='default'");
  });
  const rendered = (slug: string) => engine.transaction(async tx => {
    const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text, source_id, slug FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    return inlineExportMarkdown(await readExportPage(tx, key!, await readExportWithdrawals(tx, 'default')));
  });
  const body = (slug: string, text: string) => engine.putPage(slug, { type: 'note', title: slug.split('/').pop()!, compiled_truth: text, timeline: '' });

  /** One page in each evidence state, none with an import record. */
  async function fixture(): Promise<string> {
    const root = tempDir('git-gap-evidence-');
    git(root, 'init', '-q');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    for (const slug of ['notes/db-moved', 'notes/file-moved', 'notes/both-moved', 'notes/equal']) {
      await body(slug, `First body of ${slug}.`);
      put(root, `${slug}.md`, await rendered(slug));
    }
    await body('notes/no-history', 'A body the file never held.');
    put(root, 'notes/no-history.md', (await rendered('notes/no-history')).replace('A body the file never held.', 'A body only the file holds.'));
    commitAll(root, 'first');
    // Every real writer archives the preimage (createVersion) before it rewrites a page.
    for (const slug of ['notes/db-moved', 'notes/both-moved']) { await engine.createVersion(slug); await body(slug, 'Edited in the database.'); }
    for (const slug of ['notes/file-moved', 'notes/both-moved']) put(root, `${slug}.md`, (await rendered(slug)).replace(/First body of [^.]+\.|Edited in the database\./, 'Edited in Git by a plain commit.'));
    commitAll(root, 'plain git edit');
    return root;
  }

  test('the census splits pages with no import record by the side that moved', async () => {
    await fixture();
    const pages: GitGapPage[] = [];
    const census = await censusGitGap(engine, 'default', { sample: 50, evidence: true, collect: page => { pages.push(page); } });
    expect(census).toMatchObject({ complete: true, pages: 5, live_pages: 5, database_ahead_without_import_record: 4,
      direction_evidence: { adopt_db_moved: 1, git_wins_file_moved: 1, both_moved: 1, no_evidence: 1 },
      states: { equal: 1, database_ahead: 2, git_ahead: 2 }, git_ahead_database_also_moved: 1 });
    const bySlug = Object.fromEntries(pages.map(page => [page.slug, page]));
    expect(bySlug['notes/db-moved']).toMatchObject({ state: 'database_ahead', evidence: { kind: 'adopt_db_moved', basis: 'older_version_matches_file' } });
    expect(bySlug['notes/file-moved']).toMatchObject({ state: 'git_ahead', evidence: { kind: 'git_wins_file_moved', basis: 'row_matches_older_file' } });
    expect(bySlug['notes/both-moved']).toMatchObject({ state: 'git_ahead', databaseAlsoMoved: true, evidence: { kind: 'both_moved' } });
    expect(bySlug['notes/no-history']).toMatchObject({ state: 'database_ahead', evidence: { kind: 'no_evidence' } });
    expect(describeGitGap(census)).toContain('5 live page(s)');
    // Without evidence the old rule stands: every unrecorded difference reads database_ahead.
    expect(await censusGitGap(engine, 'default', { sample: 0 })).toMatchObject({ direction_evidence: null, states: { database_ahead: 4, git_ahead: 0 } });
  }, 120000);

  test('the timestamp trap: a non-content updated_at bump after a file edit still goes to Git', async () => {
    const root = await fixture();
    // A file name that starts with two dots is still inside the checkout.
    await expect(writeConversionFile(engine, join(root, '..review.json'), '--list-out', {})).rejects.toMatchObject({ code: 'conversion_file_in_source_root' });
    await engine.executeRaw("UPDATE pages SET updated_at = now() + interval '30 days' WHERE slug IN ('notes/file-moved','notes/both-moved')");
    const pages: GitGapPage[] = [];
    await censusGitGap(engine, 'default', { sample: 0, evidence: true, collect: page => { pages.push(page); } });
    expect(pages.find(page => page.slug === 'notes/file-moved')).toMatchObject({ state: 'git_ahead', evidence: { kind: 'git_wins_file_moved' } });
    expect(pages.find(page => page.slug === 'notes/both-moved')).toMatchObject({ state: 'git_ahead', evidence: { kind: 'both_moved' } });
  }, 120000);

  test('#14: a doctor budget labels its partial count against the live pages, and the full census counts the same live pages', async () => {
    const root = tempDir('git-gap-partial-');
    git(root, 'init', '-q');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    for (let i = 0; i < 7; i++) { await body(`notes/p${i}`, `Body ${i}.`); put(root, `notes/p${i}.md`, await rendered(`notes/p${i}`)); }
    commitAll(root, 'init');
    const full = await censusGitGap(engine, 'default', { sample: 0 });
    expect(full).toMatchObject({ complete: true, pages: 7, live_pages: 7 });
    const stopped = await censusGitGap(engine, 'default', { sample: 0, deadlineAt: Date.now() - 1 });
    expect(stopped).toMatchObject({ complete: false, pages: 0, live_pages: 7 });
    expect(describeGitGap(stopped)).toContain('PARTIAL, 0 of 7 live page(s) read');
    const [late] = await withEnv({ GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS: '1' }, () =>
      dbAheadOfGitEntry.run({ engine, progress: { heartbeat: () => {} }, entryDeadlineAt: Date.now() + 1 } as never)) as Array<{ message: string; details: any }>;
    const source = late!.details.sources.find((s: { source_id: string }) => s.source_id === 'default');
    if (source) {
      expect(source).toMatchObject({ live_pages: 7 });
      expect(late!.message).toContain(source.complete ? 'default: 7 live page(s)' : `default: PARTIAL, ${source.pages} of 7 live page(s) read`);
    } else expect(late!.details.partial_sources).toContain('default');
    const [done] = await dbAheadOfGitEntry.run({ engine, progress: { heartbeat: () => {} } } as never) as Array<{ message: string }>;
    expect(done!.message).toContain('default: 7 live page(s), 7 equal');
  }, 120000);

  test('a source nested in a larger repository reads its history, and a database revert under a Git edit is both_moved', async () => {
    const top = tempDir('git-gap-nested-'), root = join(top, 'brain');
    git(top, 'init', '-q');
    put(top, 'README.md', 'outside the source\n');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    const write = async (slug: string, text: string) => { put(root, `${slug}.md`, (await rendered(slug)).replace(/Body [ABC]\./, text)); };
    for (const slug of ['notes/file-moved', 'notes/reverted']) { await body(slug, 'Body A.'); await write(slug, 'Body A.'); }
    commitAll(top, 'first');
    await engine.createVersion('notes/reverted'); await body('notes/reverted', 'Body B.'); await write('notes/reverted', 'Body B.');
    commitAll(top, 'both sides to B');
    await engine.createVersion('notes/reverted'); await body('notes/reverted', 'Body A.');
    await write('notes/reverted', 'Body C.'); await write('notes/file-moved', 'Body C.');
    commitAll(top, 'git edits after the database revert');
    const pages: GitGapPage[] = [];
    await censusGitGap(engine, 'default', { sample: 0, evidence: true, collect: page => { pages.push(page); } });
    const bySlug = Object.fromEntries(pages.map(page => [page.slug, page]));
    expect(bySlug['notes/file-moved']).toMatchObject({ state: 'git_ahead', evidence: { kind: 'git_wins_file_moved', basis: 'row_matches_older_file' } });
    expect(bySlug['notes/reverted']).toMatchObject({ evidence: { kind: 'both_moved', basis: 'conflicting_history' } });

    // A review or decisions file is refused anywhere in the Git working tree that holds the source, and through a symlink into it.
    await expect(writeConversionFile(engine, join(top, 'review.json'), '--list-out', {})).rejects.toMatchObject({ code: 'conversion_file_in_source_root' });
    const outside = tempDir('git-gap-files-');
    put(root, 'decisions.json', '{}');
    symlinkSync(join(root, 'decisions.json'), join(outside, 'decisions.json'));
    await expect(readConversionDecisions(engine, join(outside, 'decisions.json'), 'default')).rejects.toMatchObject({ code: 'conversion_file_in_source_root' });
    expect(await writeConversionFile(engine, join(outside, 'review.json'), '--list-out', {})).toBe(join(outside, 'review.json'));
  }, 120000);

  test('a segmented page: an older blob equal to its export lets Git win only while the page has no archived version', async () => {
    const root = tempDir('git-gap-segmented-');
    git(root, 'init', '-q');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    const { id } = await createSegmentedPage(engine, { slug: 'seg/page', truth: 'Segmented filler line.\n'.repeat(50) });
    const exported = await engine.transaction(async tx => {
      const withdrawals = await readExportWithdrawals(tx, 'default');
      const snapshot = await readExportPage(tx, { id: String(id), source_id: 'default', slug: 'seg/page' }, withdrawals);
      const chunks: Buffer[] = [];
      for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(snapshot.page.slug, withdrawals), segmentedExportHead(snapshot))) chunks.push(Buffer.from(piece));
      return Buffer.concat(chunks);
    });
    mkdirSync(join(root, 'seg'), { recursive: true });
    writeFileSync(join(root, 'seg/page.md'), exported);
    commitAll(root, 'first');
    writeFileSync(join(root, 'seg/page.md'), Buffer.concat([exported, Buffer.from('A line Git added.\n')]));
    commitAll(root, 'git edit');
    const evidence = async () => {
      const pages: GitGapPage[] = [];
      await censusGitGap(engine, 'default', { sample: 0, evidence: true, collect: page => { pages.push(page); } });
      return pages.find(page => page.slug === 'seg/page')?.evidence;
    };
    expect(await evidence()).toMatchObject({ kind: 'git_wins_file_moved', basis: 'row_matches_older_file' });
    // Its archived versions cannot be compared by content, so any one of them may be a revert: not a one-sided move.
    await engine.executeRaw("INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at) VALUES ($1, 'An archived state.', '{}', now() - interval '1 day')", [id]);
    expect(await evidence()).toMatchObject({ kind: 'no_evidence', basis: 'segmented' });
  }, 120000);

  test('a Git revert under a database edit is both_moved: the path\'s history keeps a blob it held again', async () => {
    const root = tempDir('git-gap-git-revert-');
    git(root, 'init', '-q');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await body('notes/g', 'Body A.');
    const a = await rendered('notes/g');
    put(root, 'notes/g.md', a);
    commitAll(root, 'A');
    put(root, 'notes/g.md', a.replace('Body A.', 'Body B.'));
    commitAll(root, 'B');
    put(root, 'notes/g.md', a);
    commitAll(root, 'back to A');
    await engine.createVersion('notes/g'); await body('notes/g', 'Body C.');
    const pages: GitGapPage[] = [];
    await censusGitGap(engine, 'default', { sample: 0, evidence: true, collect: page => { pages.push(page); } });
    expect(pages.find(page => page.slug === 'notes/g')).toMatchObject({ evidence: { kind: 'both_moved', basis: 'conflicting_history' } });
  }, 120000);

  test('a version with no comparable content (a deletion, a segmented snapshot) counts as unread: no one-sided Git verdict', async () => {
    const root = await fixture();
    const [page] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM pages WHERE slug='notes/file-moved'");
    await engine.createVersion('notes/file-moved');
    await engine.executeRaw("INSERT INTO page_versions (page_id, compiled_truth, frontmatter, is_deleted) VALUES ($1, 'A deleted state.', '{}', true)", [page!.id]);
    const pages: GitGapPage[] = [];
    await censusGitGap(engine, 'default', { sample: 0, evidence: true, collect: entry => { pages.push(entry); } });
    expect(pages.find(entry => entry.slug === 'notes/file-moved')).toMatchObject({ evidence: { kind: 'no_evidence', basis: 'history_truncated' } });
    expect(root).not.toBe('');
  }, 120000);

  test('a pruned version history counts as unread: an inline page with a history gap gets no one-sided Git verdict', async () => {
    await fixture();
    await engine.executeRaw("UPDATE pages SET version_history_gap_at = now() WHERE slug = 'notes/file-moved'");
    const pages: GitGapPage[] = [];
    await censusGitGap(engine, 'default', { sample: 0, evidence: true, collect: page => { pages.push(page); } });
    expect(pages.find(page => page.slug === 'notes/file-moved')).toMatchObject({ evidence: { kind: 'no_evidence', basis: 'history_truncated' } });
    expect(pages.find(page => page.slug === 'notes/db-moved')).toMatchObject({ evidence: { kind: 'adopt_db_moved' } });
  }, 120000);

  test('repo-less: a source without a checkout reads no evidence (not_applicable) and counts its live pages', async () => {
    await body('notes/a', 'Only in the database.');
    const census = await censusGitGap(engine, 'default', { sample: 0, evidence: true });
    expect(census).toMatchObject({ complete: true, pages: 1, live_pages: 1, direction_evidence: null, database_ahead_without_import_record: 0 });
  });
});
