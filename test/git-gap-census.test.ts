import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { inlineExportMarkdown, readExportPage, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown, exportBodyLedger, type ExportSnapshot } from '../src/core/export-snapshot.ts';
import { parseFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';
import { gitBlobOid } from '../src/core/persistence/digest.ts';
import { recordSyncImportProvenance } from '../src/core/persistence/sync-holds.ts';
import { compareInlineExportFile, compareSegmentedExportBlob, declaredDatabaseOnly, ignoredPaths } from '../src/core/persistence/git-gap.ts';
import { censusGitGap, describeGitGap, parseGitGapArgs } from '../src/commands/sources-git-gap.ts';
import { dbAheadOfGitEntry } from '../src/commands/doctor/checks/db-ahead-of-git.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const policy = { mirror: false, dbOnly: () => false, ignored: new Set<string>() };
const fact = (claim: string) => ({ rowNum: 1, claim, kind: 'fact' as const, confidence: 1, visibility: 'world' as const, notability: 'medium' as const, active: true, context: '' });

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString();
}

function put(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
}

for (const backend of testBackends()) describe(`git-gap census (git-canonical G1): ${backend}`, () => {
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
    await engine.executeRaw("DELETE FROM facts WHERE source_id='default'");
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'");
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op IN ('sync-hold','sync-import-provenance')");
    await engine.executeRaw("UPDATE sources SET local_path=NULL, config='{}'::jsonb WHERE id='default'");
  });

  const snapshotOf = (slug: string) => engine.transaction(async tx => {
    const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text, source_id, slug FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    return readExportPage(tx, key!, await readExportWithdrawals(tx, 'default'));
  });
  const rendered = async (slug: string) => inlineExportMarkdown(await snapshotOf(slug));
  const pageId = async (slug: string) => Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.id);
  const useCheckout = async (root: string) => { await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]); };

  test('the export rendering of every page shape compares equal to its export view (the equality contract)', async () => {
    const shapes: Array<[string, Parameters<BrainEngine['putPage']>[1], string[]]> = [
      ['eq/empty', { type: 'note', title: 'Empty fields', compiled_truth: '', timeline: '' }, []],
      ['eq/body-and-timeline', { type: 'concept', title: 'Synthetic concept', compiled_truth: 'Body line one.\n\nBody line two.', timeline: '- 2026-01-02: an event' }, ['alpha', 'beta']],
      ['eq/rich-frontmatter', { type: 'person', title: 'Alice Example', compiled_truth: 'Notes.', timeline: '',
        frontmatter: { aliases: ['A. Example'], score: 3, nested: { a: [1, 'two', { three: true }] }, empty: '', validate: false } }, ['people']],
      ['eq/double--hyphen', { type: 'note', title: 'Stamped slug', compiled_truth: 'Needs a slug stamp.', timeline: '' }, []],
      ['eq/facts', { type: 'note', title: 'Facts', compiled_truth: renderFactsTable([fact('A synthetic claim')]), timeline: '' }, []],
    ];
    for (const [slug, page, tags] of shapes) {
      await engine.putPage(slug, page);
      for (const tag of tags) await engine.addTag(slug, tag);
      const snapshot = await snapshotOf(slug);
      expect([slug, compareInlineExportFile(Buffer.from(inlineExportMarkdown(snapshot)), `${slug}.md`, snapshot)]).toEqual([slug, { state: 'equal' }]);
    }
  });

  test('an edited, a broken, a non-UTF-8 and a stamp-less file compare as the contract says', async () => {
    await engine.putPage('cmp/page', { type: 'note', title: 'Compared', compiled_truth: 'Original body.', timeline: '', frontmatter: { validate: false } });
    const snapshot = await snapshotOf('cmp/page');
    const text = inlineExportMarkdown(snapshot);
    expect(compareInlineExportFile(Buffer.from(text.replace('Original body.', 'Edited body.')), 'cmp/page.md', snapshot)).toEqual({ state: 'differs', paths: ['/compiled_truth'] });
    expect(compareInlineExportFile(Buffer.from('---\ntitle: [unclosed\n---\nBody\n'), 'cmp/page.md', snapshot)).toEqual({ state: 'unparseable', reason: 'frontmatter' });
    expect(compareInlineExportFile(Buffer.from([0xff, 0xfe, 0x00]), 'cmp/page.md', snapshot)).toEqual({ state: 'unparseable', reason: 'not_utf8' });
    expect(compareInlineExportFile(Buffer.from(text.replace('validate: false\n', '')), 'cmp/page.md', snapshot)).toEqual({ state: 'equal' });
  });

  test('a forgotten fact renders withdrawn, and a file still showing it active differs', async () => {
    await engine.putPage('forget/inline', { type: 'note', title: 'Inline', compiled_truth: renderFactsTable([fact('Forgotten synthetic claim')]), timeline: '' });
    const before = await rendered('forget/inline');
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))", ['Forgotten synthetic claim']);
    const after = await snapshotOf('forget/inline');
    expect(parseFactsFence(before).facts[0]!.active).toBe(true);
    expect(parseFactsFence(inlineExportMarkdown(after)).facts[0]!.active).toBe(false);
    expect(compareInlineExportFile(Buffer.from(inlineExportMarkdown(after)), 'forget/inline.md', after)).toEqual({ state: 'equal' });
    expect(compareInlineExportFile(Buffer.from(before), 'forget/inline.md', after).state).toBe('differs');
  });

  test('a segmented page compares by the Git blob id of its streamed export, withdrawals included', async () => {
    await createSegmentedPage(engine, { slug: 'seg/page', truth: renderFactsTable([fact('Segmented synthetic claim')]) + '\n' + 'Segmented filler line.\n'.repeat(50),
      timeline: '- 2026-01-02: segmented event\n' });
    const exported = async (snapshot: ExportSnapshot) => engine.transaction(async tx => {
      const chunks: Buffer[] = [];
      for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(snapshot.page.slug, await readExportWithdrawals(tx, 'default')), segmentedExportHead(snapshot))) chunks.push(Buffer.from(piece));
      return Buffer.concat(chunks);
    });
    const blobOf = (bytes: Buffer) => ({ oid: gitBlobOid(bytes, 'sha1'), size: bytes.length, mode: '100644' });
    const compare = (bytes: Buffer, snapshot: ExportSnapshot) => engine.transaction(async tx => compareSegmentedExportBlob(tx, snapshot, await readExportWithdrawals(tx, 'default'), blobOf(bytes), 'sha1'));
    const before = await exported(await snapshotOf('seg/page'));
    expect(await compare(before, await snapshotOf('seg/page'))).toEqual({ state: 'equal' });
    expect(await compare(Buffer.concat([before, Buffer.from('x')]), await snapshotOf('seg/page'))).toEqual({ state: 'differs', paths: ['/body'] });
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))", ['Segmented synthetic claim']);
    const after = await snapshotOf('seg/page');
    expect(await compare(before, after)).toEqual({ state: 'differs', paths: ['/body'] });
    expect(await compare(await exported(after), after)).toEqual({ state: 'equal' });
  });

  test('declared classes: mirrors, private, alias-private, lineage-private, database-only, db_only prefixes, derive folders and ignored paths', () => {
    const page = (frontmatter: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ slug: 'notes/x', type: 'note', frontmatter, ...extra });
    expect(declaredDatabaseOnly(page(), 'notes/x.md', policy)).toBeNull();
    expect(declaredDatabaseOnly(page(), 'notes/x.md', { ...policy, mirror: true })).toBe('mirror_source');
    expect(declaredDatabaseOnly(page({ visibility: 'private' }), 'notes/x.md', policy)).toBe('private');
    expect(declaredDatabaseOnly(page({}, { lineage_private: true }), 'notes/x.md', policy)).toBe('lineage_private');
    expect(declaredDatabaseOnly(page({}, { database_only_reason: 'detached' }), 'notes/x.md', policy)).toBe('database_only');
    expect(declaredDatabaseOnly(page(), 'notes/x.md', { ...policy, dbOnly: slug => slug.startsWith('notes/') })).toBe('db_only_prefix');
    expect(declaredDatabaseOnly({ slug: 'atoms/a1', type: 'note', frontmatter: {} }, 'atoms/a1.md', policy)).toBe('derive_folder');
    expect(declaredDatabaseOnly({ slug: 'atoms/a1', type: 'note', frontmatter: {}, source_path: 'atoms/a1.md' }, 'atoms/a1.md', policy)).toBeNull();
    expect(declaredDatabaseOnly({ slug: 'concepts/c1', type: 'note', frontmatter: {}, source_uri: 'x://y' }, 'concepts/c1.md', policy)).toBeNull();
    expect(declaredDatabaseOnly(page(), 'notes/x.md', { ...policy, ignored: new Set(['notes/x.md']) })).toBe('git_ignored');
  });

  test('ignoredPaths reads the ignore rules with filter-free plumbing and never reports a tracked file', async () => {
    const root = tempDir('git-gap-ignore-');
    git(root, 'init', '-q');
    put(root, '.gitignore', 'images/\n');
    put(root, 'images/tracked.md', 'x');
    git(root, 'add', '-f', '.gitignore', 'images/tracked.md');
    git(root, 'commit', '-qm', 'init');
    expect(await ignoredPaths(root, ['images/a.md', 'images/tracked.md', 'notes/b.md'])).toEqual({ ignored: new Set(['images/a.md']), unknown: new Map() });
    expect(await ignoredPaths(root, ['notes/b.md'])).toEqual({ ignored: new Set(), unknown: new Map() });
  });

  test('#7618: a path Git refuses to check is unknown on its own, and every other path in the input is still answered', async () => {
    const root = tempDir('git-gap-ignore-poison-');
    git(root, 'init', '-q');
    put(root, '.gitignore', 'images/\n');
    mkdirSync(join(root, 'real'));
    symlinkSync('real', join(root, 'link'));
    const paths = Array.from({ length: 2_500 }, (_, i) => i % 100 ? `notes/n${i}.md` : `images/i${i}.md`);
    paths.splice(1_500, 0, 'link/x.md');
    paths.splice(10, 0, '../outside.md');
    const status = await ignoredPaths(root, paths);
    expect(status?.ignored).toEqual(new Set(Array.from({ length: 25 }, (_, i) => `images/i${i * 100}.md`)));
    expect(status?.unknown).toEqual(new Map([['../outside.md', 'outside_repo'], ['link/x.md', 'symlink']]));
    expect(await ignoredPaths(tempDir('git-gap-not-a-checkout-'), ['notes/a.md'])).toBeNull();
  });

  test('the census puts every page in one state, compares with HEAD and reports the working tree separately', async () => {
    const root = tempDir('git-gap-census-');
    git(root, 'init', '-q');
    await useCheckout(root);
    const body = (slug: string, text: string) => engine.putPage(slug, { type: 'note', title: slug.split('/').pop()!, compiled_truth: text, timeline: '' });
    for (const slug of ['notes/equal', 'notes/edited-later', 'notes/deleted-later', 'notes/db-edited', 'notes/git-edited', 'notes/db-with-record', 'notes/missing', 'notes/untracked', 'notes/broken']) {
      await body(slug, `Body of ${slug}.`);
    }
    await engine.putPage('notes/turned-private', { type: 'note', title: 'Turned private', compiled_truth: 'Was public.', timeline: '' });
    await engine.putPage('images/scan', { type: 'note', title: 'Ignored', compiled_truth: 'Image note.', timeline: '' });
    await engine.putPage('atoms/a1', { type: 'note', title: 'Atom', compiled_truth: 'Derived.', timeline: '' });
    await engine.putPage('notes/detached', { type: 'note', title: 'Detached', compiled_truth: 'Kept in the database.', timeline: '' });
    await engine.executeRaw("UPDATE pages SET database_only_reason='detached' WHERE slug='notes/detached'");
    put(root, '.gitignore', 'images/\n');
    for (const slug of ['notes/equal', 'notes/edited-later', 'notes/deleted-later', 'notes/db-edited', 'notes/git-edited', 'notes/db-with-record', 'notes/turned-private']) put(root, `${slug}.md`, await rendered(slug));
    put(root, 'notes/broken.md', '---\ntitle: [unclosed\n---\nBody\n');
    put(root, 'images/scan.md', await rendered('images/scan'));
    commitAll(root, 'init');
    const original = (slug: string) => gitBlobOid(Buffer.from(git(root, 'cat-file', 'blob', `HEAD:${slug}.md`)), 'sha1');
    const revisionOf = async (slug: string) => (await engine.executeRaw<{ r: string }>("SELECT knowledge_revision::text AS r FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.r;
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const record = async (slug: string, blob: string, revision: string) => {
      const id = await pageId(slug);
      await engine.transaction(async tx => recordSyncImportProvenance(tx, { source_id: 'default', incarnation,
      page_id: id, origin: `${slug}.md`, raw_sha256: 'x', blob_oid: blob, disk_blob_oid: blob, gbrain_version: 'test', revision }));
    };
    const imported = original('notes/git-edited');
    await record('notes/git-edited', imported, await revisionOf('notes/git-edited'));
    await record('notes/db-with-record', original('notes/db-with-record'), 'an-older-revision');
    put(root, 'notes/git-edited.md', (await rendered('notes/git-edited')).replace('Body of notes/git-edited.', 'Edited in Git.'));
    commitAll(root, 'edit in git');
    await body('notes/db-edited', 'Edited in the database.');
    await body('notes/db-with-record', 'Edited in the database too.');
    await engine.putPage('notes/turned-private', { type: 'note', title: 'Turned private', compiled_truth: 'Was public.', timeline: '', frontmatter: { visibility: 'private' } });
    put(root, 'notes/edited-later.md', 'uncommitted edit\n');
    unlinkSync(join(root, 'notes/deleted-later.md'));
    put(root, 'notes/untracked.md', await rendered('notes/untracked'));

    const census = await censusGitGap(engine, 'default', { sample: 50 });
    expect(census).toMatchObject({ status: 'census', checkout: root, head: git(root, 'rev-parse', 'HEAD').trim(), complete: true, pages: 13,
      states: { equal: 3, database_ahead: 2, git_ahead: 1, declared_database_only: 4, undeclared_database_only: 1, worktree_only: 1, unparseable: 1, unsafe_path: 0 },
      declared: { private: 1, git_ignored: 1, derive_folder: 1, database_only: 1, mirror_source: 0, alias_private: 0, lineage_private: 0, db_only_prefix: 0 },
      declared_with_head_blob: 1, database_ahead_without_import_record: 1, git_ahead_database_also_moved: 0, not_compared: 0,
      worktree: { clean: 5, modified: 1, deleted: 1, untracked: 1, absent: 1 } });
    const bySlug = Object.fromEntries(census.sample.map(item => [item.slug, item]));
    expect(bySlug['notes/db-edited']).toEqual({ slug: 'notes/db-edited', path: 'notes/db-edited.md', state: 'database_ahead', fields: ['/compiled_truth'], basis: 'no_import_record', worktree: 'clean' });
    expect(bySlug['notes/db-with-record']).toMatchObject({ state: 'database_ahead', basis: 'import_record' });
    expect(bySlug['notes/git-edited']).toMatchObject({ state: 'git_ahead', basis: 'import_record', fields: ['/compiled_truth'] });
    expect(bySlug['notes/turned-private']).toEqual({ slug: 'notes/turned-private', path: 'notes/turned-private.md', state: 'declared_database_only', declared: 'private' });
    expect(bySlug['notes/missing']).toMatchObject({ state: 'undeclared_database_only', worktree: 'absent' });
    expect(bySlug['notes/untracked']).toMatchObject({ state: 'worktree_only', worktree: 'untracked' });
    expect(bySlug['notes/broken']).toMatchObject({ state: 'unparseable' });
    expect(bySlug['notes/equal']).toBeUndefined();
    expect(describeGitGap(census)).toContain('Working tree against HEAD: clean 5, modified 1, deleted 1, untracked 1, absent 1.');

    await record('notes/git-edited', imported, 'an-older-revision');
    expect((await censusGitGap(engine, 'default', { sample: 0 })).git_ahead_database_also_moved).toBe(1);
    await engine.executeRaw("UPDATE sources SET config=jsonb_build_object('mirror_read_only',true) WHERE id='default'");
    expect((await censusGitGap(engine, 'default', { sample: 0 })).declared.mirror_source).toBe(13);
  }, 120000);

  test('#7618: in the conversion plan, a batch with a page beyond a symlink is classified, not refused', async () => {
    const root = tempDir('git-gap-census-symlink-');
    git(root, 'init', '-q');
    await useCheckout(root);
    for (const slug of ['notes/equal', 'notes/missing', 'link/beyond']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.`, timeline: '' });
    put(root, 'notes/equal.md', await rendered('notes/equal'));
    commitAll(root, 'init');
    mkdirSync(join(root, 'real'));
    symlinkSync('real', join(root, 'link'));
    const collected: Array<{ slug: string; state: string }> = [];
    const census = await censusGitGap(engine, 'default', { sample: 10, collect: page => collected.push(page) });
    expect(census).toMatchObject({ complete: true, pages: 3, states: { equal: 1, undeclared_database_only: 2 } });
    expect(census.sample.find(item => item.slug === 'link/beyond')).toMatchObject({ path: 'link/beyond.md', state: 'undeclared_database_only' });
    expect(collected.find(page => page.slug === 'link/beyond')).toMatchObject({ state: 'undeclared_database_only' });
  });

  /**
   * Value: protects=a page whose ignore status Git cannot read is never counted as a plain undeclared page by git-gap or doctor;
   * the report refuses as the pre-#7617 census did; fails_when=the report path classifies it as if not ignored;
   * seam=none (a real check-ignore refusal beyond a symlink); no_claim=timeout and outside-repo reasons.
   */
  test('#7618: git-gap and doctor refuse a source with a page whose ignore status Git cannot read', async () => {
    const root = tempDir('git-gap-census-unknown-');
    git(root, 'init', '-q');
    await useCheckout(root);
    for (const slug of ['notes/equal', 'link/beyond']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.`, timeline: '' });
    put(root, 'notes/equal.md', await rendered('notes/equal'));
    commitAll(root, 'init');
    mkdirSync(join(root, 'real'));
    symlinkSync('real', join(root, 'link'));
    const refusal = 'Git could not say whether link/beyond.md in the checkout at';
    await expect(censusGitGap(engine, 'default', { sample: 0 })).rejects.toMatchObject({ code: 'storage_error', message: expect.stringContaining(refusal) });
    const [check] = await dbAheadOfGitEntry.run({ engine, progress: { heartbeat: () => {} } } as never) as Array<{ message: string; details: any }>;
    expect(check!.details.sources.find((s: { source_id: string }) => s.source_id === 'default')).toBeUndefined();
    expect(check!.details.errors).toEqual([expect.objectContaining({ source_id: 'default', message: expect.stringContaining('(symlink)') })]);
    expect(check!.message).toContain(`Could not compare: default (${refusal}`);
  });

  test('a repository filter, textconv or fsmonitor never runs: HEAD and the working tree are read without them', async () => {
    const root = tempDir('git-gap-filter-');
    git(root, 'init', '-q');
    await useCheckout(root);
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Body A.', timeline: '' });
    put(root, 'notes/a.md', await rendered('notes/a'));
    commitAll(root, 'init');
    const marker = join(root, '..', `${root.split('/').pop()}-driver-ran`);
    dirs.push(marker);
    put(root, '.gitattributes', '*.md filter=trap diff=trap\n');
    for (const [key, value] of [['filter.trap.clean', `sh -c 'touch ${marker}; cat'`], ['filter.trap.smudge', `sh -c 'touch ${marker}; cat'`],
      ['filter.trap.process', `sh -c 'touch ${marker}'`], ['filter.trap.required', 'true'], ['diff.trap.textconv', `sh -c 'touch ${marker}; cat'`],
      ['core.fsmonitor', `sh -c 'touch ${marker}'`]]) git(root, 'config', key!, value!);
    put(root, 'notes/a.md', (await rendered('notes/a')) + 'worktree edit\n');
    put(root, 'notes/b.md', 'untracked\n');
    const census = await censusGitGap(engine, 'default', { sample: 0 });
    expect(census.states.equal).toBe(1);
    expect(census.worktree).toMatchObject({ modified: 1 });
    expect(existsSync(marker)).toBe(false);
  });

  test('an unborn branch has no committed file, so a written file is worktree_only', async () => {
    const root = tempDir('git-gap-unborn-');
    git(root, 'init', '-q');
    await useCheckout(root);
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Body A.', timeline: '' });
    await engine.putPage('notes/b', { type: 'note', title: 'B', compiled_truth: 'Body B.', timeline: '' });
    put(root, 'notes/a.md', await rendered('notes/a'));
    expect(await censusGitGap(engine, 'default', { sample: 0 })).toMatchObject({ head: null, states: { worktree_only: 1, undeclared_database_only: 1 } });
  });

  test('rows with no Git home: unfenced and stranded facts, links no file derives, timeline rows, holds and parked targets', async () => {
    const root = tempDir('git-gap-rows-');
    git(root, 'init', '-q');
    await useCheckout(root);
    for (const slug of ['notes/filed', 'notes/unfiled', 'atoms/a1']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Body.', timeline: '' });
    put(root, 'notes/filed.md', await rendered('notes/filed'));
    commitAll(root, 'init');
    const insertFact = (claim: string, rowNum: number | null, slug: string | null, expired = false) => engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source, row_num, source_markdown_slug, entity_slug, expired_at) VALUES ('default', $1, 'test', $2, $3, $3, ${expired ? 'now()' : 'NULL'})`, [claim, rowNum, slug]);
    await insertFact('unfenced active', null, null);
    await insertFact('unfenced expired', null, null, true);
    await insertFact('fenced on a gone page', 1, 'notes/gone');
    await insertFact('fenced on an unfiled page', 1, 'notes/unfiled');
    await insertFact('fenced on a derived page', 1, 'atoms/a1');
    await insertFact('fenced on a filed page', 1, 'notes/filed');
    const ids = Object.fromEntries(await Promise.all(['notes/filed', 'notes/unfiled', 'atoms/a1'].map(async slug => [slug, await pageId(slug)] as const)));
    const link = (from: string, to: string, source: string | null) => engine.executeRaw('INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, $3, $4)',
      [ids[from], ids[to], `t-${source ?? 'none'}`, source]);
    for (const source of ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved', 'manual', 'citation-graph', 'concept-provenance', null]) await link('notes/filed', 'notes/unfiled', source);
    const timeline = (slug: string, summary: string) => engine.executeRaw("INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-01-02', $2)", [ids[slug], summary]);
    await timeline('notes/filed', 'on a filed page');
    await timeline('notes/unfiled', 'on an unfiled page');
    await timeline('atoms/a1', 'on a derived page');
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    for (const [path, code] of [['notes/x.md', 'file_drift'], ['notes/y.md', 'file_drift'], ['notes/z.md', 'invalid_fence']]) {
      await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES ('sync-hold',$1,$2::text::jsonb)",
        [`default:${incarnation}:${path}`, JSON.stringify([{ source_id: 'default', incarnation, path, code, page_id: null, meta: {} }])]);
    }
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
      const [request] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
          intent_bytes,terminal_reservation) VALUES ('local_cli','test',$1::uuid,'put_page','default',$2::uuid,'notes/filed','x','{}'::jsonb,0,0) RETURNING id::text`, [randomUUID(), incarnation]);
      await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,state,source_id,source_incarnation) VALUES ($1::uuid,'git',$2::text::jsonb,'failed','default',$3::uuid)`,
        [request!.id, JSON.stringify({ parked: [{ slug: 'notes/filed', error_code: 'git_target_ignored' }, { slug: 'notes/unfiled', error_code: 'git_target_ignored' }] }), incarnation]);
    });
    const census = await censusGitGap(engine, 'default', { sample: 0 });
    expect(census.rows_without_git_home).toEqual({ facts_unfenced: 1, facts_fence_page_missing: 1, facts_on_pages_without_file: { undeclared: 1, declared: 1 },
      links: { total: 4, by_link_source: { '(none)': 1, 'citation-graph': 1, 'concept-provenance': 1, manual: 1 } }, timeline_on_pages_without_file: { undeclared: 1, declared: 1 } });
    expect(census.holds).toEqual({ file_drift: 2, invalid_fence: 1 });
    expect(census.parked_effects).toEqual([{ kind: 'git', code: 'git_target_ignored', targets: 2 }]);
    await engine.executeRaw("DELETE FROM persistence_effects WHERE source_id='default'");
    await engine.executeRaw("DELETE FROM persistence_requests WHERE source_id='default'");
    await engine.executeRaw("DELETE FROM links");
    await engine.executeRaw("DELETE FROM timeline_entries");
  });

  test('a source without a checkout counts declared pages and compares nothing, across batches whatever the ids sort like as text', async () => {
    await engine.executeRaw("SELECT setval(pg_get_serial_sequence('pages','id'), 1, false)");
    for (let i = 0; i < 300; i++) await engine.putPage(`notes/n${i}`, { type: 'note', title: `N${i}`, compiled_truth: 'Body.', timeline: '' });
    await engine.putPage('notes/secret', { type: 'note', title: 'Secret', compiled_truth: 'Secret.', timeline: '', frontmatter: { visibility: 'private' } });
    const [{ min, max }] = await engine.executeRaw<{ min: string; max: string }>('SELECT min(id)::text AS min, max(id)::text AS max FROM pages');
    expect(min.length).toBeLessThan(max.length);
    expect(await censusGitGap(engine, 'default', { sample: 0 })).toMatchObject({ checkout: null, head: null, pages: 301, not_compared: 0, worktree: null,
      states: { declared_database_only: 301, equal: 0 }, declared: { database_only_source: 301, private: 0 } });
    expect((await censusGitGap(engine, 'default', { sample: 0, deadlineAt: Date.now() - 1 })).complete).toBe(false);
  }, 120000);

  test('the census fails closed: a directory that is not a checkout or an unresolvable db_only refuses; lineage and db_only prefixes are declared', async () => {
    await engine.putPage('notes/x', { type: 'note', title: 'X', compiled_truth: 'Body.', timeline: '' });
    const plain = tempDir('git-gap-plain-');
    await useCheckout(plain);
    await expect(censusGitGap(engine, 'default', { sample: 0 })).rejects.toMatchObject({ code: 'storage_error' });
    const root = tempDir('git-gap-policy-');
    git(root, 'init', '-q');
    await useCheckout(root);
    put(root, 'gbrain.yml', 'storage:\n  db_only: [notes/,\n    archive/]\n');
    await expect(censusGitGap(engine, 'default', { sample: 0 })).rejects.toMatchObject({ code: 'storage_error' });
    put(root, 'gbrain.yml', 'storage:\n  db_only: [notes/]\n');
    expect((await censusGitGap(engine, 'default', { sample: 0 })).declared.db_only_prefix).toBe(1);
    put(root, 'gbrain.yml', 'storage:\n  db_only:\n    - Notes/\n');
    expect((await censusGitGap(engine, 'default', { sample: 0 })).declared.db_only_prefix).toBe(1);
    rmSync(join(root, 'gbrain.yml'));
    await engine.putPage('private/origin', { type: 'note', title: 'Origin', compiled_truth: 'Secret.', timeline: '', frontmatter: { visibility: 'private' } });
    await engine.putPage('notes/summary', { type: 'note', title: 'Summary', compiled_truth: 'Digest.', timeline: '', frontmatter: { derived_from: ['private/origin'] } });
    expect(await censusGitGap(engine, 'default', { sample: 0 })).toMatchObject({ pages: 3, declared: { private: 1, lineage_private: 1 }, states: { undeclared_database_only: 1 } });
  });

  test('doctor db_ahead_of_git is informational: always ok, totals per source with a checkout, partial past its budget', async () => {
    const ctx = { engine, progress: { heartbeat: () => {} } } as never;
    expect(await dbAheadOfGitEntry.run(ctx)).toMatchObject([{ name: 'db_ahead_of_git', status: 'ok', details: { sources: [] } }]);
    await useCheckout(tempDir('git-gap-doctor-plain-'));
    const [plain] = await dbAheadOfGitEntry.run(ctx) as Array<{ status: string; details: any }>;
    expect(plain).toMatchObject({ status: 'ok', details: { sources: [], errors: [] } });
    expect(plain!.details.sources_without_git_checkout).toBeGreaterThanOrEqual(1);
    const root = tempDir('git-gap-doctor-');
    git(root, 'init', '-q');
    await useCheckout(root);
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Body A.', timeline: '' });
    await engine.putPage('notes/b', { type: 'note', title: 'B', compiled_truth: 'Body B.', timeline: '' });
    put(root, 'notes/a.md', await rendered('notes/a'));
    commitAll(root, 'init');
    const [check] = await dbAheadOfGitEntry.run(ctx) as Array<{ status: string; message: string; details: any }>;
    expect(check!.status).toBe('ok');
    expect(check!.details.sources.find((s: { source_id: string }) => s.source_id === 'default')).toMatchObject({ pages: 2, complete: true,
      states: { equal: 1, undeclared_database_only: 1 } });
    expect(check!.message).toContain('default: 1 equal, 1 undeclared_database_only');
    expect(check!.message).not.toContain('notes/');
    const [late] = await withEnv({ GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS: '1' }, () =>
      dbAheadOfGitEntry.run({ engine, progress: { heartbeat: () => {} }, entryDeadlineAt: Date.now() } as never)) as Array<{ status: string; details: any }>;
    expect(late).toMatchObject({ status: 'ok', details: { partial_sources: ['default'] } });
  });
});

describe('sources git-gap arguments', () => {
  test('one source id, --json and a bounded --sample', () => {
    expect(parseGitGapArgs(['default', '--json', '--sample', '5'])).toEqual({ sourceId: 'default', json: true, sample: 5 });
    expect(parseGitGapArgs(['default'])).toEqual({ sourceId: 'default', json: false, sample: 20 });
    for (const args of [[], ['a', 'b'], ['default', '--apply'], ['default', '--sample', '-1'], ['default', '--sample']]) expect(() => parseGitGapArgs(args)).toThrow(OperationError);
  });
});
