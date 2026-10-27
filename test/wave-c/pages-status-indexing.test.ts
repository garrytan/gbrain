/**
 * Wave C 1I-a (spec §3.6): `gbrain pages status` reports a page whose committed head waits for its index step as
 * `indexing` (a never-indexed create and a replaced page alike), with the write's request and commit and the receipt as its
 * fix, and a held head as `index_held` with the hold code and the read-only `pages reindex --from-git --dry-run` preview.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPagesStatus } from '../../src/commands/pages-status.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

for (const backend of testBackends()) describe(`[${backend}] pages status during the index lag`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a never-indexed create is indexing (never missing), with its request and the receipt as the fix; a held head is index_held', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const row = await write(engine, ctx, 'notes/lag-create', pageBody(2 * MiB, 'MARKERLAGCREATE'), 'put');
    expect(row.state).toBe('indexing');
    const [page] = (await readPagesStatus(engine, 'default', ['notes/lag-create'])).pages;
    expect(page).toMatchObject({ state: 'indexing', searchable: false, page: null,
      index: { state: 'pending', request_id: row.id, commit: row.outcome?.persistence.git_commit, hold_code: null } });
    expect(page!.fix).toMatchObject({ argv: ['gbrain', 'write-request', '--', row.id], actor: 'agent' });
    await engine.executeRaw("UPDATE page_pending_heads SET hold_code = 'hash_mismatch' WHERE slug = 'notes/lag-create'");
    const [held] = (await readPagesStatus(engine, 'default', ['notes/lag-create'])).pages;
    expect(held).toMatchObject({ state: 'index_held', index: { state: 'held', hold_code: 'hash_mismatch' } });
    expect(held!.why).toContain('hash_mismatch');
    expect(held!.fix).toMatchObject({ argv: ['gbrain', 'pages', 'reindex', 'notes/lag-create', '--source', 'default', '--from-git', '--dry-run'] });
  }, { databaseUrl, setup }), 120_000);

  test('a replaced page is indexing over the generation its rows still show, which stays searchable as it was', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    _unregisterIndexSplitPageConsumerForTests();
    await write(engine, ctx, 'notes/lag-replace', pageBody(4 * 1024, 'MARKERSMALLFIRST'), 'put');
    const [first] = (await readPagesStatus(engine, 'default', ['notes/lag-replace'])).pages;
    expect(first!.index).toBeNull();
    registerIndexSplitPageConsumer({ run: async () => undefined });
    _resetGitFirstGateForTests();
    const [{ revision }] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE slug = 'notes/lag-replace'");
    const row = await write(engine, ctx, 'notes/lag-replace', pageBody(2 * MiB, 'MARKERLAGREPLACE'), 'put', { expectedRevision: revision });
    expect(row.state).toBe('indexing');
    const [page] = (await readPagesStatus(engine, 'default', ['notes/lag-replace'])).pages;
    expect(page).toMatchObject({ state: 'indexing', searchable: first!.searchable, page: { id: first!.page!.id }, index: { state: 'pending', request_id: row.id } });
    expect(page!.why).toContain(first!.state);
  }, { databaseUrl, setup }), 120_000);
});
