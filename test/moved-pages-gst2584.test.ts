/**
 * GST-2584: a file that moved while its old page's deletion was held left a stale page at the old slug, and no repair
 * folded it into the moved page.
 *   - `repair file-drift --held` lists such a page moved_to <slug> and prints the fold, never the recreate;
 *   - `repair moved-pages` folds it on proof read from Git (the old path's last committed content is what the new path took
 *     at the move, or its first commit, and the old page still holds it): alias, links in every role, timeline and saved
 *     versions carried, the hold cleared, the old page soft-deleted and restorable, a receipt per page, no file written;
 *   - kept, with the reason: two candidates, a near-equal body, a first commit that differs, a database edit after the
 *     move, a frontmatter id alone, a shallow history;
 *   - gbrain's own database-only artefacts are derived, not a page-side edit: a file naming the type gbrain-base 1.0.0 gave
 *     its path, equal to the stored `type` copy, while the column took a later pack's type; and the grandfather stamp;
 *   - the file_gone hold says when the page simply has no import record.
 * Real PGLite (and Postgres when DATABASE_URL is set), a managed worktree with real Git commits; no seams.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { operationsByName } from '../src/core/operations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { fileMatchesSnapshot } from '../src/core/persistence/page-prepare.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';

const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ALPHA = '---\ntitle: Alpha\n---\n\nThe alpha body, kept word for word through the move.\n';
const BETA = '---\ntitle: Beta\n---\n\nBeta points at [[notes/alpha]].\n';
const setup = (files: Record<string, string>) => ({ root }: { root: string }) => {
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'first');
};
const opts = (backend: string, files: Record<string, string> = { 'notes/alpha.md': ALPHA, 'notes/beta.md': BETA }) =>
  ({ ...(backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {}), setup: setup(files) });

const cli = async <T>(engine: BrainEngine, run: () => Promise<T>) => withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), run);
const runner = async (engine: BrainEngine, kind: 'moved-pages' | 'file-drift', options: Record<string, unknown>) => cli(engine, async () =>
  (await repairRunner(engine, { apply: options.expect !== undefined, logger })).run(kind, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...options }));
const raw = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number; deleted: boolean; source_path: string | null; type: string }>(
  "SELECT id, deleted_at IS NOT NULL AS deleted, source_path, type FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ path: string; message: string; meta: Record<string, unknown> }>(
  "SELECT completed_keys->0->>'path' AS path, completed_keys->0->>'message' AS message, completed_keys->0->'meta' AS meta FROM op_checkpoints WHERE op='sync-hold' ORDER BY 1"));

/**
 * Syncs the first commit, then edits notes/alpha in the database only (sync's import record no longer matches it), runs
 * `move` in the checkout and syncs again: the move imports as a fresh page and the old page's deletion is held
 * file_gone, as sync does it. With `revert`, the database edit is then taken back, so the old page holds its file again.
 */
async function movedAway(engine: BrainEngine, root: string, move: () => void, revert = true): Promise<void> {
  await registerLocalWriter(engine, 'cli');
  expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
  const [before] = await engine.executeRaw<{ timeline: string }>("SELECT timeline FROM pages WHERE source_id='default' AND slug='notes/alpha'");
  await raw(engine, "UPDATE pages SET timeline='An edit only the database holds.', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'");
  move();
  await performManagedSync(engine, SYNC);
  expect((await holds(engine)).map(hold => hold.path)).toContain('notes/alpha.md');
  if (revert) await raw(engine, "UPDATE pages SET timeline=$1, knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'", [before!.timeline]);
}
const mv = (root: string, to: string) => () => { mkdirSync(join(root, to, '..'), { recursive: true }); git(root, 'mv', 'notes/alpha.md', to); git(root, 'commit', '-qm', 'move'); };

async function repairCli(engine: BrainEngine, args: string[]): Promise<{ out: string; exitCode: number | string | undefined }> {
  const lines: string[] = [];
  const { log, error } = console;
  const stdout = process.stdout.write.bind(process.stdout);
  const previous = process.exitCode;
  process.exitCode = 0;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  console.error = () => {};
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await runRepairCommand(engine, [...args, '--json']); return { out: lines.join('\n'), exitCode: process.exitCode }; }
  finally { console.log = log; console.error = error; process.stdout.write = stdout; process.exitCode = previous ?? 0; _resetCliExitVerdictForTests(); }
}

const listed = (plan: { listing?: Array<{ item: string; class: string; detail?: string }> }, slug: string) => plan.listing!.find(entry => entry.item === `default:${slug}`);

for (const backend of testBackends()) {
  test(`${backend}: a move whose old page's deletion was held folds into the moved page: preview, consent, links, versions, hold, alias, search and restore`, () => managedBrain(async ({ engine, ctx, root }) => {
    await movedAway(engine, root, mv(root, 'notes/archive/alpha.md'));
    const moveCommit = git(root, 'rev-parse', 'HEAD');
    const old = (await page(engine, 'notes/alpha'))!, moved = (await page(engine, 'notes/archive/alpha'))!;
    expect(moved.deleted).toBe(false);
    // A database-only link from another page, to the old page: a relationship only the database holds.
    await cli(engine, () => operationsByName.add_link!.handler(ctx, { from: 'notes/beta', to: 'notes/alpha', link_type: 'advises', request_id: randomUUID() }));
    const versionsBefore = Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [old.id]))[0]!.n);

    // file-drift lists it moved_to and prints the fold, not the recreate.
    const drift = await runner(engine, 'file-drift', { held: true, side: 'deleted', state: 'file_gone', prefer: 'database' });
    expect(drift.affected).toBe(0);
    expect(listed(drift, 'notes/alpha')).toMatchObject({ class: 'moved_to', detail: expect.stringContaining('gbrain repair moved-pages --source default --slug notes/alpha') });
    expect(String(listed(drift, 'notes/alpha')!.detail)).not.toContain('recreates');

    const preview = JSON.parse((await repairCli(engine, ['moved-pages', '--source', 'default'])).out).results[0];
    expect(preview.affected).toBe(1);
    expect(preview.listing).toContainEqual(expect.objectContaining({ item: 'default:notes/alpha', class: 'moved_to', detail: expect.stringContaining(`commit ${moveCommit.slice(0, 12)}`) }));
    expect(preview.details.pairs[0]).toMatchObject({ old: { slug: 'notes/alpha', path: 'notes/alpha.md' }, survivor: { slug: 'notes/archive/alpha', path: 'notes/archive/alpha.md' }, evidence: 'same_commit', move_commit: moveCommit });
    expect(preview.apply_command).toEndWith(' --yes');
    const apply = ['moved-pages', '--source', 'default', '--apply', '--expect', preview.preview_hash];
    expect((await repairCli(engine, apply)).exitCode).toBe(3);
    expect((await page(engine, 'notes/alpha'))!.deleted).toBe(false);
    const applied = JSON.parse((await repairCli(engine, [...apply, '--yes'])).out).results[0];
    expect(applied.outcomes).toEqual({ folded: 1 });

    expect(await page(engine, 'notes/alpha')).toMatchObject({ deleted: true, source_path: null });
    expect(existsSync(join(root, 'notes/alpha.md'))).toBe(false);
    expect(readFileSync(join(root, 'notes/archive/alpha.md'), 'utf8')).toBe(ALPHA);
    expect(git(root, 'status', '--porcelain', '--', 'notes/alpha.md', 'notes/archive')).toBe('');
    expect((await holds(engine)).map(hold => hold.path)).not.toContain('notes/alpha.md');
    const links = await engine.executeRaw<{ link_type: string; from: string }>(`SELECT l.link_type, f.slug AS from FROM links l JOIN pages f ON f.id=l.from_page_id
      WHERE l.to_page_id=$1 ORDER BY 1`, [moved.id]);
    expect(links).toContainEqual({ link_type: 'advises', from: 'notes/beta' });
    expect(await engine.executeRaw('SELECT 1 FROM links WHERE to_page_id=$1 OR from_page_id=$1', [old.id])).toEqual([]);
    const versionsAfter = Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [moved.id]))[0]!.n);
    expect(versionsAfter).toBeGreaterThan(versionsBefore);
    expect(await engine.executeRaw('SELECT 1 FROM page_versions WHERE page_id=$1', [old.id])).toEqual([]);
    expect(await engine.executeRaw("SELECT canonical_slug FROM slug_aliases WHERE source_id='default' AND alias_slug='notes/alpha'")).toEqual([{ canonical_slug: 'notes/archive/alpha' }]);

    // The old slug resolves to the moved page, and a search finds only the moved page.
    const got = await cli(engine, () => operationsByName.get_page!.handler(ctx, { slug: 'notes/alpha' })) as Record<string, unknown>;
    expect(got.slug).toBe('notes/archive/alpha');
    const hits = await cli(engine, () => operationsByName.search!.handler(ctx, { query: 'kept word for word' })) as Array<{ slug: string }>;
    expect(hits.map(hit => hit.slug)).toContain('notes/archive/alpha');
    expect(hits.map(hit => hit.slug)).not.toContain('notes/alpha');

    // A sync afterwards has nothing left to hold.
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([]);

    // gbrain restore brings the old page back within the window, database-only; the alias stops answering for it.
    const [deleted] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug='notes/alpha'");
    await cli(engine, () => operationsByName.restore_page!.handler(ctx, { slug: 'notes/alpha', expected_revision: deleted!.revision, request_id: randomUUID() }));
    expect(await page(engine, 'notes/alpha')).toMatchObject({ deleted: false, source_path: null });
    const back = await cli(engine, () => operationsByName.get_page!.handler(ctx, { slug: 'notes/alpha' })) as Record<string, unknown>;
    expect(back.slug).toBe('notes/alpha');
    expect(existsSync(join(root, 'notes/alpha.md'))).toBe(false);
  }, opts(backend)), 240_000);

  test(`${backend}: an equal body moved to another top folder under another file name, and then edited there, still folds`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, root, () => { mkdirSync(join(root, 'archive'), { recursive: true }); git(root, 'mv', 'notes/alpha.md', 'archive/first-letter.md'); git(root, 'commit', '-qm', 'move');
      writeFileSync(join(root, 'archive/first-letter.md'), `${ALPHA}\nA later edit at the new path.\n`); git(root, 'commit', '-qam', 'edit after the move'); });
    const preview = await runner(engine, 'moved-pages', {});
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'moved_to' });
    expect(preview.details!.pairs).toEqual([expect.objectContaining({ survivor: expect.objectContaining({ slug: 'archive/first-letter' }), evidence: 'same_commit' })]);
    expect((await runner(engine, 'moved-pages', { expect: preview.preview_hash })).outcomes).toEqual({ folded: 1 });
    expect((await page(engine, 'notes/alpha'))!.deleted).toBe(true);
    expect(readFileSync(join(root, 'archive/first-letter.md'), 'utf8')).toContain('A later edit at the new path.');
  }, opts(backend)), 240_000);

  test(`${backend}: a copy committed separately and the old file deleted later folds on the copy's first commit`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, root, () => { mkdirSync(join(root, 'archive'), { recursive: true }); writeFileSync(join(root, 'archive/alpha.md'), ALPHA); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'copy');
      git(root, 'rm', '-q', 'notes/alpha.md'); git(root, 'commit', '-qm', 'delete the old one'); });
    const preview = await runner(engine, 'moved-pages', {});
    expect(preview.details!.pairs).toEqual([expect.objectContaining({ survivor: expect.objectContaining({ slug: 'archive/alpha' }), evidence: 'first_commit' })]);
  }, opts(backend)), 240_000);

  test(`${backend}: a page edited in the database after the move stays held as both changed`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, root, mv(root, 'archive/alpha.md'), false);
    const preview = await runner(engine, 'moved-pages', {});
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'held:both_changed' });
    const drift = await runner(engine, 'file-drift', { held: true, side: 'deleted', state: 'file_gone', prefer: 'database' });
    expect(listed(drift, 'notes/alpha')!.class).not.toBe('moved_to');
  }, opts(backend)), 240_000);

  test(`${backend}: a near-equal body at the new path (its first commit differs) stays held, named by its file name`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, root, () => { mkdirSync(join(root, 'archive'), { recursive: true }); git(root, 'rm', '-q', 'notes/alpha.md');
      writeFileSync(join(root, 'archive/alpha.md'), ALPHA.replace('word for word', 'word for word,')); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'move and touch'); });
    const preview = await runner(engine, 'moved-pages', {});
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'held:first_blob_differs', detail: expect.stringContaining('archive/alpha.md has the same file name') });
    expect((await page(engine, 'notes/alpha'))!.deleted).toBe(false);
  }, opts(backend)), 240_000);

  test(`${backend}: two pages started from the old file's content stay held (several candidates)`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, root, () => { for (const dir of ['archive', 'other']) { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, 'alpha.md'), ALPHA); }
      git(root, 'rm', '-q', 'notes/alpha.md'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'split'); });
    const preview = await runner(engine, 'moved-pages', {});
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'held:several_candidates' });
    expect(preview.details!.held).toEqual([expect.objectContaining({ candidates: ['archive/alpha', 'other/alpha'] })]);
  }, opts(backend)), 240_000);

  test(`${backend}: a frontmatter id shared with a page whose body differs never folds`, () => managedBrain(async ({ engine, root }) => {
    const WITH_ID = '---\ntitle: Alpha\nid: alpha-id\n---\n\nThe alpha body, kept word for word through the move.\n';
    await movedAway(engine, root, () => { mkdirSync(join(root, 'elsewhere'), { recursive: true }); git(root, 'rm', '-q', 'notes/alpha.md');
      writeFileSync(join(root, 'elsewhere/renamed.md'), WITH_ID.replace('kept word for word', 'rewritten')); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'rewrite elsewhere'); });
    const preview = await runner(engine, 'moved-pages', {});
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'held:same_id_body_differs' });
  }, opts(backend, { 'notes/alpha.md': '---\ntitle: Alpha\nid: alpha-id\n---\n\nThe alpha body, kept word for word through the move.\n', 'notes/beta.md': BETA })), 240_000);

  test(`${backend}: a history too shallow to read the move keeps the page held and says so`, () => managedBrain(async ({ engine, root }) => {
    await movedAway(engine, root, mv(root, 'archive/alpha.md'));
    writeFileSync(join(root, '.git/shallow'), `${git(root, 'rev-parse', 'HEAD')}\n`);
    const preview = await runner(engine, 'moved-pages', {});
    expect(preview.affected).toBe(0);
    expect(listed(preview, 'notes/alpha')).toMatchObject({ class: 'held:history_shallow', detail: expect.stringContaining('git fetch --unshallow') });
  }, opts(backend)), 240_000);

  test(`${backend}: a source with no checkout (repo-less) lists nothing to fold`, () => managedBrain(async ({ engine }) => {
    const plan = await cli(engine, async () => (await repairRunner(engine, { apply: false, logger })).run('moved-pages', await resolveRepairScope(engine, 'dbonly'), { explicit: true, sourceFlag: 'dbonly' }));
    expect(plan.affected).toBe(0);
    expect(plan.warnings!.join(' ')).toContain('no canonical checkout');
  }, { ...opts(backend), setup: async (brain: { engine: BrainEngine; root: string }) => {
    setup({ 'notes/alpha.md': ALPHA })(brain);
    await brain.engine.executeRaw("INSERT INTO sources (id, name) VALUES ('dbonly', 'dbonly') ON CONFLICT DO NOTHING");
  } }), 240_000);

  test(`${backend}: a file_gone hold of a page with no import record says so instead of naming a database edit`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
    await raw(engine, "UPDATE pages SET timeline='An edit only the database holds.', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='notes/alpha'");
    git(root, 'rm', '-q', 'notes/alpha.md'); git(root, 'commit', '-qm', 'delete');
    await performManagedSync(engine, SYNC);
    const [hold] = (await holds(engine)).filter(entry => entry.path === 'notes/alpha.md');
    expect(hold!.message).toContain('has no import record');
    expect(hold!.message).not.toContain('changed in the database since the file was last imported');
    expect(hold!.meta).toMatchObject({ side: 'deleted', state: 'file_gone', no_import_record: true });
  }, opts(backend)), 240_000);

  test(`${backend}: a file naming the type gbrain-base 1.0.0 gave its path, equal to the stored copy, is not drift when the column took a later pack's type`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    expect((await page(engine, 'writing/essay'))!.type).toBe('writing');
    // What an older gbrain left: the reserved type copy in the stored frontmatter, and a column a later pack retyped.
    await raw(engine, `UPDATE pages SET type='media', frontmatter=frontmatter || '{"type":"writing","validate":false}'::jsonb, knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='writing/essay'`);
    const snapshot = (await engine.readPageSnapshot('writing/essay', { sourceId: 'default' }))!;
    const file = readFileSync(join(root, 'writing/essay.md'), 'utf8');
    expect(await fileMatchesSnapshot(engine, 'writing/essay', file, snapshot, 'writing/essay.md')).toBe(true);
    // A person's explicit type is still read as written, and so is the old name under a path gbrain-base 1.0.0 types otherwise.
    expect(await fileMatchesSnapshot(engine, 'writing/essay', file.replace('type: writing', 'type: guide'), snapshot, 'writing/essay.md')).toBe(false);
    expect(await fileMatchesSnapshot(engine, 'notes/essay', file, { ...snapshot, page: { ...snapshot.page, slug: 'notes/essay' } }, 'notes/essay.md')).toBe(false);
    // The import keeps the retyped column instead of reading the old name back into it.
    writeFileSync(join(root, 'writing/essay.md'), `${file}\nA later line.\n`); git(root, 'commit', '-qam', 'edit');
    await performManagedSync(engine, SYNC);
    expect((await engine.readPageSnapshot('writing/essay', { sourceId: 'default' }))?.page.compiled_truth).toContain('A later line.');
    expect((await page(engine, 'writing/essay'))!.type).toBe('media');

  }, opts(backend, { 'writing/essay.md': '---\ntype: writing\ntitle: Essay\n---\n\nAn essay gbrain wrote out.\n', 'notes/beta.md': BETA })), 240_000);

  test(`${backend}: a moved page carrying the type rename and the grandfather stamp folds`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await raw(engine, `UPDATE pages SET type='media', frontmatter=frontmatter || '{"type":"writing","validate":false}'::jsonb, knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='writing/essay'`);
    mkdirSync(join(root, 'archive'), { recursive: true }); git(root, 'mv', 'writing/essay.md', 'archive/essay.md'); git(root, 'commit', '-qm', 'move');
    await performManagedSync(engine, SYNC);
    expect((await holds(engine)).map(hold => hold.path)).toContain('writing/essay.md');
    const preview = await runner(engine, 'moved-pages', {});
    expect(listed(preview, 'writing/essay')).toMatchObject({ class: 'moved_to' });
    expect((await runner(engine, 'moved-pages', { expect: preview.preview_hash })).outcomes).toEqual({ folded: 1 });
  }, opts(backend, { 'writing/essay.md': '---\ntype: writing\ntitle: Essay\n---\n\nAn essay gbrain wrote out.\n', 'notes/beta.md': BETA })), 240_000);
}
