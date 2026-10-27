/**
 * Wave C 1I-a (spec §2.6, §3.6, dx-r3-native-8; unsplit pages): `gbrain pages verify` and `gbrain pages reindex --from-git`.
 * Verify says ok for a page equal to its committed file, and not ok (with the fix) for a page whose head is pending
 * (the receipt), held (the reindex preview) or changed in Git behind the database. Reindex previews HEAD, the blob and a
 * hash, refuses an apply with a stale hash, and an apply re-derives the page from the committed file, flips a held head
 * (its request's receipt says indexed) and leaves the page verified.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPageReindex, previewPageReindex, verifyPage } from '../../src/commands/pages-from-git.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const code = (error: unknown) => (error as { code?: string }).code;

for (const backend of testBackends()) describe(`[${backend}] pages verify and pages reindex --from-git`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('an equal page verifies ok; a page changed in Git behind the database does not, and reindex re-derives it', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const row = await write(engine, ctx, 'notes/verify-small', pageBody(4 * 1024, 'MARKERVERIFYSMALL'), 'put');
    expect(row.state).toBe('committed');
    expect(await verifyPage(engine, 'default', 'notes/verify-small')).toMatchObject({ ok: true, state: 'equal', fix: null, path: 'notes/verify-small.md' });
    const file = join(root, 'notes/verify-small.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('MARKERVERIFYSMALL', 'MARKERCHANGEDINGIT'));
    git(root, 'add', 'notes/verify-small.md');
    git(root, 'commit', '-q', '-m', 'edit outside gbrain');
    const drifted = await verifyPage(engine, 'default', 'notes/verify-small');
    expect(drifted.ok).toBe(false);
    expect(['database_ahead', 'git_ahead']).toContain(drifted.state);
    expect(drifted.differing.length).toBeGreaterThan(0);
    expect(drifted.fix).toMatchObject({ argv: ['gbrain', 'pages', 'reindex', 'notes/verify-small', '--source', 'default', '--from-git', '--dry-run'] });
    const preview = await previewPageReindex(engine, 'default', 'notes/verify-small');
    expect(preview).toMatchObject({ status: 'preview', head: git(root, 'rev-parse', 'HEAD').trim(), path: 'notes/verify-small.md', state: drifted.state });
    const applied = await applyPageReindex(engine, 'default', 'notes/verify-small', preview.preview_hash);
    expect(applied.verify).toMatchObject({ ok: true, state: 'equal', indexed_commit: preview.head });
    const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug = 'notes/verify-small'");
    expect(page!.compiled_truth).toContain('MARKERCHANGEDINGIT');
  }, { databaseUrl, setup }), 180_000);

  test('a pending head is indexing (fix: the receipt); a held head is index_held, and reindex flips it to the committed file', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const row = await write(engine, ctx, 'notes/verify-held', pageBody(2 * MiB, 'MARKERVERIFYHELD'), 'put');
    expect(row.state).toBe('indexing');
    const pending = await verifyPage(engine, 'default', 'notes/verify-held');
    expect(pending).toMatchObject({ ok: false, state: 'indexing', pending: { request_id: row.id, hold_code: null } });
    expect(pending.fix).toMatchObject({ argv: ['gbrain', 'write-request', '--', row.id] });
    await engine.executeRaw("UPDATE page_pending_heads SET hold_code = 'hash_mismatch' WHERE slug = 'notes/verify-held'");
    expect(await verifyPage(engine, 'default', 'notes/verify-held')).toMatchObject({ ok: false, state: 'index_held', pending: { hold_code: 'hash_mismatch' } });
    const preview = await previewPageReindex(engine, 'default', 'notes/verify-held');
    expect(preview).toMatchObject({ state: 'index_held', pending: { request_id: row.id } });
    expect(await applyPageReindex(engine, 'default', 'notes/verify-held', 'f'.repeat(64)).then(() => null, code)).toBe('preview_changed');
    expect(await engine.executeRaw("SELECT 1 FROM page_pending_heads WHERE slug = 'notes/verify-held'")).toHaveLength(1);
    const applied = await applyPageReindex(engine, 'default', 'notes/verify-held', preview.preview_hash);
    expect(applied.verify).toMatchObject({ ok: true, state: 'equal', pending: null, indexed_commit: preview.head });
    expect(await engine.executeRaw("SELECT 1 FROM page_pending_heads WHERE slug = 'notes/verify-held'")).toEqual([]);
    const [request] = await engine.executeRaw<{ state: string; outcome: { index?: { state?: string } } }>('SELECT state, outcome FROM persistence_requests WHERE id = $1::uuid', [row.id]);
    expect(request).toMatchObject({ state: 'committed', outcome: { index: { state: 'indexed', commit: preview.head } } });
    const [page] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'notes/verify-held'");
    expect(page!.n).toBeGreaterThan(0);
    // The segmented page is compared by its parsed fields (frontmatter key order aside), so a body change still differs.
    const file = join(root, 'notes/verify-held.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('MARKERVERIFYHELD', 'MARKERBODYCHANGED'));
    git(root, 'add', 'notes/verify-held.md');
    git(root, 'commit', '-q', '-m', 'body edit outside gbrain');
    expect(await verifyPage(engine, 'default', 'notes/verify-held')).toMatchObject({ ok: false, differing: ['/body'] });
  }, { databaseUrl, setup }), 180_000);

  test('a page that does not exist refuses page_not_found; a non-strict source refuses reindex', () => managedBrain(async ({ engine }) => {
    expect(await verifyPage(engine, 'default', 'notes/nowhere').then(() => null, code)).toBe('page_not_found');
    expect(await previewPageReindex(engine, 'default', 'notes/nowhere').then(() => null, code)).toBe('invalid_params');
  }, { databaseUrl, setup }), 60_000);
});
