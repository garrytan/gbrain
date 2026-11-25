/**
 * Ghost pages whose file moved (data loss): `gbrain repair ghost-pages` approved a page whose file a commit deleted for
 * soft-delete even when Git shows the file moved to another live page, so the old page's links, facts and timeline were
 * purged 72 h later instead of carried to the moved page. And `gbrain repair moved-pages` folded only a move that kept
 * the file byte for byte, so a file renamed and edited in one commit was never folded. Now:
 *   - ghost-pages lists a ghost a proven move pairs with a live page apart (`moved_to`), names the moved-pages fold
 *     (preview first, `--apply --expect <hash> --yes`) and never approves it; a ghost Git renamed or copied without a
 *     proven fold is kept (`move_unproven`);
 *   - a `database_ahead_of_file` ghost carries move evidence: matched when a moved page holds every line of it, else
 *     unmatched;
 *   - moved-pages folds a file renamed and edited in one commit when the moved page holds every line of the old page
 *     (`renamed_contained`), and keeps one whose lines changed.
 * Synthetic fixtures only. Real PGLite (and Postgres when DATABASE_URL is set), real managed sync and real Git.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';

const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ALPHA = '---\ntitle: Alpha\n---\n\nThe alpha body, kept word for word through the move.\n\nA second paragraph of the alpha note.\n';
const BETA = '---\ntitle: Beta\n---\n\nBeta points at [[notes/alpha]].\n';
const setupWith = (extra: Record<string, string>) => ({ root }: { root: string }) => {
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes/alpha.md'), ALPHA); writeFileSync(join(root, 'notes/beta.md'), BETA);
  for (const [path, content] of Object.entries(extra)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'first');
};
const opts = (backend: string, extra: Record<string, string> = {}) => ({ ...(backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {}), setup: setupWith(extra) });
const cli = async <T>(engine: BrainEngine, run: () => Promise<T>) => withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), run);
const runner = async (engine: BrainEngine, kind: 'moved-pages' | 'ghost-pages' | 'file-drift', options: Record<string, unknown> = {}) => cli(engine, async () =>
  (await repairRunner(engine, { apply: options.expect !== undefined, logger })).run(kind, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...options }));
const raw = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const live = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ live: boolean }>("SELECT deleted_at IS NULL AS live FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]?.live;
const listed = (plan: { listing?: Array<{ item: string; class: string; detail?: string }> }, slug: string) => plan.listing!.find(entry => entry.item === `default:${slug}`);
const commit = (root: string, files: Record<string, string>, message: string, remove: string[] = []) => {
  for (const path of remove) git(root, 'rm', '-q', path);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); git(root, 'add', path); }
  git(root, 'commit', '-qm', message);
};

/** The managed sync holds the old page's deletion (file_gone) because the database edited it first; with `revert` the edit is taken back. */
async function movedAway(engine: BrainEngine, move: () => void, revert = true): Promise<void> {
  await registerLocalWriter(engine, 'cli');
  expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
  const [before] = await engine.executeRaw<{ timeline: string }>("SELECT timeline FROM pages WHERE source_id='default' AND slug='notes/alpha'");
  await raw(engine, "UPDATE pages SET timeline='An edit only the database holds.', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'");
  move();
  await performManagedSync(engine, SYNC);
  if (revert) await raw(engine, "UPDATE pages SET timeline=$1, knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'", [before!.timeline]);
}
const OLDER = '---\ntitle: Older\n---\n\nAn older note that the move overwrote.\n';
/** One commit rewrites archive/older.md to the alpha content and deletes notes/alpha.md; a later commit edits archive/older.md. */
const rewriteOlder = (root: string) => {
  writeFileSync(join(root, 'archive/older.md'), ALPHA); git(root, 'add', 'archive/older.md'); git(root, 'rm', '-q', 'notes/alpha.md'); git(root, 'commit', '-qm', 'rewrite older with the alpha content, drop alpha');
  commit(root, { 'archive/older.md': `${ALPHA}\nA line added after the move.\n` }, 'edit the rewritten file');
};
const renameEdited = (root: string, content: string) => () => {
  mkdirSync(join(root, 'notes/archive'), { recursive: true });
  git(root, 'mv', 'notes/alpha.md', 'notes/archive/alpha.md');
  writeFileSync(join(root, 'notes/archive/alpha.md'), content); git(root, 'add', 'notes/archive/alpha.md'); git(root, 'commit', '-qm', 'move and edit');
};

for (const backend of testBackends()) {
  test(`${backend}: a file renamed and edited in one commit folds when the moved page holds every line of the old page`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, renameEdited(root, `${ALPHA}\nA line added at the move.\n`));
    const moveCommit = git(root, 'rev-parse', 'HEAD');
    const preview = await runner(engine, 'moved-pages');
    expect(preview.affected).toBe(1);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'moved_to', detail: expect.stringContaining(`renamed by commit ${moveCommit.slice(0, 12)}`) });
    expect((preview.details as { pairs: unknown[] }).pairs[0]).toMatchObject({ survivor: { slug: 'notes/archive/alpha' }, evidence: 'renamed_contained', move_commit: moveCommit });
    const applied = await runner(engine, 'moved-pages', { expect: preview.preview_hash, yes: true });
    expect(applied.outcomes).toEqual({ folded: 1 });
    expect(await live(engine, 'notes/alpha')).toBe(false);
    expect(await live(engine, 'notes/archive/alpha')).toBe(true);
    expect(readFileSync(join(root, 'notes/archive/alpha.md'), 'utf8')).toContain('A line added at the move.');
  }, opts(backend)));

  test(`${backend}: a file renamed with a line changed stays held, because the fold would drop that line`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, renameEdited(root, ALPHA.replace('word for word', 'nearly word for word')));
    const preview = await runner(engine, 'moved-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'held:first_blob_differs' });
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend)));

  test(`${backend}: ghost-pages lists a ghost whose file moved to a live page apart (moved_to) with the fold, and never soft-deletes it`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, { 'archive/alpha.md': ALPHA }, 'copy');
    await performManagedSync(engine, SYNC);
    expect(await live(engine, 'archive/alpha')).toBe(true);
    commit(root, {}, 'remove the old copy', ['notes/alpha.md']);

    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ ghosts: 0, moved_to: 1 });
    const entry = listed(preview, 'notes/alpha')!;
    expect(entry.class).toBe('moved_to');
    expect(entry.detail).toContain('moved to archive/alpha');
    expect(entry.detail).toContain('gbrain repair moved-pages --source default --slug notes/alpha');
    expect(preview.warnings!.some(line => line.includes('(moved_to)'))).toBe(true);
    expect((await runner(engine, 'ghost-pages', { expect: preview.preview_hash, yes: true })).outcomes ?? {}).not.toHaveProperty('soft_deleted');
    expect(await live(engine, 'notes/alpha')).toBe(true);

    const fold = await runner(engine, 'moved-pages', { slugs: ['notes/alpha'] });
    expect(fold.affected).toBe(1);
    expect(listed(fold, 'notes/alpha')).toMatchObject({ class: 'moved_to' });
  }, opts(backend)));

  test(`${backend}: ghost-pages keeps a ghost whose content two live files took (move_unproven) instead of soft-deleting it`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, { 'archive/alpha.md': ALPHA, 'other/alpha-copy.md': ALPHA }, 'two copies');
    await performManagedSync(engine, SYNC);
    commit(root, {}, 'remove the old copy', ['notes/alpha.md']);

    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ ghosts: 0, move_unproven: 1 });
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'move_unproven', detail: expect.stringContaining('several_candidates') });
  }, opts(backend)));

  test(`${backend}: a database_ahead_of_file ghost whose moved page holds every line carries move evidence matched, with the fold`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, () => { mkdirSync(join(root, 'notes/archive'), { recursive: true }); git(root, 'mv', 'notes/alpha.md', 'notes/archive/alpha.md'); git(root, 'commit', '-qm', 'move'); });
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ database_ahead: 1, database_ahead_matched: 1, database_ahead_unmatched: 0 });
    const entry = listed(preview, 'notes/alpha')!;
    expect(entry.class).toBe('database_ahead_of_file');
    expect(entry.detail).toContain('Move evidence: matched');
    expect(entry.detail).toContain('gbrain repair moved-pages --source default --slug notes/alpha');
  }, opts(backend)));

  test(`${backend}: a database_ahead_of_file ghost whose database edit the moved page lacks carries move evidence unmatched`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, () => { mkdirSync(join(root, 'notes/archive'), { recursive: true }); git(root, 'mv', 'notes/alpha.md', 'notes/archive/alpha.md'); git(root, 'commit', '-qm', 'move'); }, false);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.residuals).toMatchObject({ database_ahead: 1, database_ahead_matched: 0, database_ahead_unmatched: 1 });
    const entry = listed(preview, 'notes/alpha')!;
    expect(entry.class).toBe('database_ahead_of_file');
    expect(entry.detail).toContain('Move evidence: unmatched');
    expect(entry.detail).toContain('notes/archive/alpha');
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend)));
  test(`${backend}: ghost-pages lists moved_to a ghost whose file was copied under another name, edited there, and deleted later`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, { 'archive/renamed.md': ALPHA }, 'copy under another name');
    await performManagedSync(engine, SYNC);
    commit(root, { 'archive/renamed.md': `${ALPHA}\nA line added later.\n` }, 'edit the copy');
    await performManagedSync(engine, SYNC);
    commit(root, {}, 'remove the old copy', ['notes/alpha.md']);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ ghosts: 0, moved_to: 1 });
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'moved_to', detail: expect.stringContaining('archive/renamed') });
  }, opts(backend)));

  test(`${backend}: an approval saved before the file's copy landed is refused by the soft-delete itself`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, {}, 'remove', ['notes/alpha.md']);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(1);
    commit(root, { 'archive/alpha.md': ALPHA }, 'the same content lands elsewhere, not imported yet');
    const applied = await runner(engine, 'ghost-pages', { expect: preview.preview_hash, yes: true });
    expect(applied).toMatchObject({ applied: 0, outcomes: { refused: 1 } });
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend)));

  test(`${backend}: a same-name file Git added between the old file's add and its deletion folds when it holds every line (named_contained)`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, () => {
      commit(root, { 'notes/other/alpha.md': `${ALPHA}\nMore written in the new place.\n` }, 'new copy with more');
      commit(root, {}, 'remove the old copy', ['notes/alpha.md']);
    });
    const preview = await runner(engine, 'moved-pages');
    expect(preview.affected).toBe(1);
    expect((preview.details as { pairs: unknown[] }).pairs[0]).toMatchObject({ survivor: { slug: 'notes/other/alpha' }, evidence: 'named_contained' });
    expect((await runner(engine, 'moved-pages', { expect: preview.preview_hash, yes: true })).outcomes).toEqual({ folded: 1 });
  }, opts(backend)));

  test(`${backend}: a same-name file created after the old file was deleted never folds, even holding every line`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, () => {
      commit(root, {}, 'remove the old copy', ['notes/alpha.md']);
      commit(root, { 'notes/other/alpha.md': `${ALPHA}\nMore written in the new place.\n` }, 'an unrelated note with that name');
    });
    const preview = await runner(engine, 'moved-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')!.class).toStartWith('held:');
  }, opts(backend)));

  test(`${backend}: a renamed file whose lines were reordered stays held: every line in order is the bar`, () => managedBrain(async ({ engine, root }) => {
    const [first, second] = ['The alpha body, kept word for word through the move.', 'A second paragraph of the alpha note.'];
    await movedAway(engine, renameEdited(root, ALPHA.replace(first, 'PLACEHOLDER').replace(second, first).replace('PLACEHOLDER', second)));
    const preview = await runner(engine, 'moved-pages');
    expect(preview.affected).toBe(0);
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend)));

  test(`${backend}: a strict move whose old page was edited in the database folds when the moved page holds that edit`, () => managedBrain(async ({ engine, root }) => {
    const EDIT = 'A paragraph written in the database after the import.';
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await raw(engine, "UPDATE pages SET compiled_truth=compiled_truth || $1, knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'", [`\n\n${EDIT}`]);
    mkdirSync(join(root, 'notes/archive'), { recursive: true });
    git(root, 'mv', 'notes/alpha.md', 'notes/archive/alpha.md'); git(root, 'commit', '-qm', 'move');
    commit(root, { 'notes/archive/alpha.md': `${ALPHA}\n${EDIT}\n` }, 'carry the edit');
    await performManagedSync(engine, SYNC);
    const ghosts = await runner(engine, 'ghost-pages');
    expect(listed(ghosts, 'notes/alpha')).toMatchObject({ class: 'database_ahead_of_file', detail: expect.stringContaining('Move evidence: matched') });
    const preview = await runner(engine, 'moved-pages');
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'moved_to' });
    expect((preview.details as { pairs: unknown[] }).pairs[0]).toMatchObject({ survivor: { slug: 'notes/archive/alpha' }, evidence: 'same_commit' });
    expect((await runner(engine, 'moved-pages', { expect: preview.preview_hash, yes: true })).outcomes).toEqual({ folded: 1 });
    expect(await live(engine, 'notes/alpha')).toBe(false);
  }, opts(backend)));

  test(`${backend}: a ghost whose same-name copy, added before its deletion, reordered its paragraphs is kept (move_unproven), never soft-deleted`, () => managedBrain(async ({ engine, root }) => {
    const [first, second] = ['The alpha body, kept word for word through the move.', 'A second paragraph of the alpha note.'];
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, { 'notes/other/alpha.md': ALPHA.replace(first, 'PLACEHOLDER').replace(second, first).replace('PLACEHOLDER', second) }, 'copy with paragraphs reordered');
    await performManagedSync(engine, SYNC);
    commit(root, {}, 'remove the old copy', ['notes/alpha.md']);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'move_unproven', detail: expect.stringContaining('same_file_name') });
  }, opts(backend)));

  test(`${backend}: a same-name file added in the same commit as the old file is not where it moved`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, () => commit(root, {}, 'remove the old copy', ['notes/alpha.md']));
    const preview = await runner(engine, 'moved-pages');
    expect(preview.affected).toBe(0);
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend, { 'notes/twin/alpha.md': `${ALPHA}
A sibling written alongside it.
` })));

  test(`${backend}: a moved file whose old page carries a tag the moved page lacks stays held`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await raw(engine, "INSERT INTO tags (page_id, tag) SELECT id, 'kept-example' FROM pages WHERE source_id='default' AND slug='notes/alpha'");
    await raw(engine, "UPDATE pages SET timeline='An edit only the database holds.', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'");
    renameEdited(root, `${ALPHA}
A line added at the move.
`)();
    await performManagedSync(engine, SYNC);
    await raw(engine, "UPDATE pages SET timeline='', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'");
    const preview = await runner(engine, 'moved-pages');
    expect(preview.affected).toBe(0);
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend)));

  test(`${backend}: two ghosts with the same content and one live copy are both kept, never soft-deleted`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, { 'archive/alpha.md': ALPHA }, 'one copy');
    await performManagedSync(engine, SYNC);
    commit(root, {}, 'remove both', ['notes/alpha.md', 'notes/alpha-copy.md']);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')!.class).toBe('move_unproven');
    expect(listed(preview, 'notes/alpha-copy')!.class).toBe('move_unproven');
  }, opts(backend, { 'notes/alpha-copy.md': ALPHA })));

  test(`${backend}: file-drift --prefer file lists a ghost whose move is unproven apart instead of planning a soft-delete the apply refuses`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    mkdirSync(join(root, 'archive'), { recursive: true });
    git(root, 'mv', 'notes/alpha.md', 'archive/alpha.md'); git(root, 'commit', '-qm', 'move, not synced yet');
    const drift = await runner(engine, 'file-drift', { slugs: ['notes/alpha'], prefer: 'file' });
    expect(drift.affected).toBe(0);
    expect(listed(drift, 'notes/alpha')).toMatchObject({ class: 'move_unproven', detail: expect.stringContaining('archive/alpha.md') });
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend)));

  test(`${backend}: a ghost whose deleting commit rewrote another, differently named file to its content, edited later, is kept while that file's page lacks the content, never soft-deleted`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    rewriteOlder(root);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'move_unproven', detail: expect.stringMatching(/archive\/older\.md, commit_copy.*survivor_differs/) });
    expect((await runner(engine, 'ghost-pages', { expect: preview.preview_hash, yes: true })).outcomes ?? {}).not.toHaveProperty('soft_deleted');
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend, { 'archive/older.md': OLDER })));

  test(`${backend}: a ghost whose content an earlier commit rewrote another file to, deleted later and that file edited after, is kept, never soft-deleted`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, { 'archive/older.md': ALPHA }, 'rewrite older with the alpha content');
    commit(root, {}, 'drop alpha', ['notes/alpha.md']);
    commit(root, { 'archive/older.md': ALPHA + '\nA line added after the move.\n' }, 'edit the rewritten file');
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'move_unproven', detail: expect.stringContaining('archive/older.md, commit_copy') });
    expect((await runner(engine, 'ghost-pages', { expect: preview.preview_hash, yes: true })).outcomes ?? {}).not.toHaveProperty('soft_deleted');
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend, { 'archive/older.md': OLDER })));

  test(`${backend}: a page edited in the database after its deleting commit rewrote another file to its content folds into that file's page`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, () => rewriteOlder(root));
    const preview = await runner(engine, 'ghost-pages');
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'database_ahead_of_file', detail: expect.stringContaining('Move evidence: matched') });
    const fold = await runner(engine, 'moved-pages', { slugs: ['notes/alpha'] });
    expect(fold.affected).toBe(1);
    expect((fold.details as { pairs: unknown[] }).pairs[0]).toMatchObject({ survivor: { slug: 'archive/older' }, evidence: 'same_commit' });
    expect((await runner(engine, 'moved-pages', { slugs: ['notes/alpha'], expect: fold.preview_hash, yes: true })).outcomes).toEqual({ folded: 1 });
  }, opts(backend, { 'archive/older.md': OLDER })));

  test(`${backend}: a ghost whose deleting commit replaced a symlink under another name with its content, edited later, is kept, never soft-deleted`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    rmSync(join(root, 'archive/link.md')); writeFileSync(join(root, 'archive/link.md'), ALPHA);
    git(root, 'add', 'archive/link.md'); git(root, 'rm', '-q', 'notes/alpha.md'); git(root, 'commit', '-qm', 'replace the link with the alpha content, drop alpha');
    commit(root, { 'archive/link.md': `${ALPHA}\nA line added after the move.\n` }, 'edit the former link');
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'move_unproven', detail: expect.stringContaining('archive/link.md, commit_copy') });
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, { ...opts(backend), setup: ({ root }: { root: string }) => { setupWith({})({ root }); mkdirSync(join(root, 'archive'), { recursive: true }); symlinkSync('../notes/beta.md', join(root, 'archive/link.md')); git(root, 'add', 'archive/link.md'); git(root, 'commit', '-qm', 'link'); } }));

  test(`${backend}: a ghost with more same-name files than the history read covers is kept (move_unproven), never soft-deleted`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, {}, 'remove the old copy', ['notes/alpha.md']);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'move_unproven', detail: expect.stringContaining('same_file_name') });
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend, Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`shelf-${n}/alpha.md`, `---\ntitle: Shelf ${n}\n---\n\nShelf note ${n}.\n`])))));

  test(`${backend}: a move committed after the soft-delete was prepared and before it was published keeps the page`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    commit(root, {}, 'remove', ['notes/alpha.md']);
    const preview = await runner(engine, 'ghost-pages');
    expect(preview.affected).toBe(1);
    let moved = false;
    installFaultHook(point => {
      if (point !== 'consumer:prepared' || moved) return;
      moved = true;
      commit(root, { 'archive/alpha.md': ALPHA }, 'the same content lands elsewhere while the soft-delete waits');
    });
    try {
      const applied = await runner(engine, 'ghost-pages', { expect: preview.preview_hash, yes: true });
      expect(moved).toBe(true);
      expect(applied.outcomes ?? {}).not.toHaveProperty('soft_deleted');
    } finally { installFaultHook(undefined); }
    expect(await live(engine, 'notes/alpha')).toBe(true);
  }, opts(backend)));
}
