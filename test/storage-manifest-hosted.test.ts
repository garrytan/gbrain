/**
 * GST-1943: the storage shelf on a brain with a Git checkout (managed persistence, PGLite). Git stays the parent: the
 * shelf is a hosted git-canonical repository that `gbrain storage init` creates after its preview, and every card is
 * committed there before the database indexes it. Protects:
 *   - register refuses storage_manifest_missing until init runs; init previews without creating anything, a stale
 *     plan_hash refuses, and the apply hosts the repository and marks the source with the storage role, not federated;
 *   - a registered card is one commit on the hosted branch, and its file holds the card;
 *   - put_page into the hosted shelf is refused storage_source_managed;
 *   - an update with its revision commits again.
 * .serial: real git subprocesses and a GBRAIN_HOME swap.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { initStorageSource } from '../src/core/storage-manifest/source.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx, params) as Promise<Record<string, any>>;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: { code?: string; canonical?: string }) => e.canonical ?? e.code ?? 'error');
const card = (id: string) => ({ id, title: `Archive ${id}`, aliases: ['old research runs'], kind: 'directory',
  locations: [{ store: 'b2', bucket: 'bucket-a', path: `/archive/${id}`, tool: 'restic', repository: 'archive/restic', snapshot: 'c'.repeat(64), size_bytes: 4096 }],
  original_path: `/srv/data/${id}`, restore: { skill: 'restore-data', args: { id } } });

describe('storage shelf on a brain with a Git checkout', () => {
  test('init hosts the shelf after its preview; cards are committed before they are indexed; other writers are refused', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await refusal(call(ctx, 'storage_register', { card: card('runs-2026') }))).toBe('storage_manifest_missing');
    const dir = join(dirname(root), 'shelf');
    const preview = await initStorageSource(engine, { dir, dryRun: true });
    expect(preview).toMatchObject({ action: 'host_repo', dry_run: true, repo_brain: true });
    expect(preview.apply).toEqual(['gbrain', 'storage', 'init', '--dir', dir, '--expect', preview.plan!.plan_hash]);
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);
    expect(await refusal(initStorageSource(engine, { dir, dryRun: false, expect: 'f'.repeat(64) }))).toBe('preview_changed');

    const applied = await initStorageSource(engine, { dir, dryRun: false, expect: preview.plan!.plan_hash });
    expect(applied).toMatchObject({ action: 'host_repo', dry_run: false });
    const [source] = await engine.executeRaw<{ config: Record<string, unknown> | string }>("SELECT config FROM sources WHERE id='storage'");
    const config = typeof source!.config === 'string' ? JSON.parse(source!.config) : source!.config;
    expect(config).toMatchObject({ role: 'storage_manifest', federated: false, canonical: 'git' });

    const repository = join(dir, 'repo.git');
    const before = git(repository, 'rev-list', '--count', 'main');
    await call(ctx, 'storage_register', { card: card('runs-2026') });
    expect(Number(git(repository, 'rev-list', '--count', 'main'))).toBe(Number(before) + 1);
    const file = git(repository, 'ls-tree', '-r', '--name-only', 'main').split('\n').find((path) => path.includes('runs-2026'));
    expect(file).toBeTruthy();
    const committed = git(repository, 'show', `main:${file}`);
    expect(committed).toContain('type: stored-object');
    expect(committed).toContain('restore-data');
    expect(readFileSync(join(dir, 'worktree', file!), 'utf8')).toBe(committed.endsWith('\n') ? committed : `${committed}\n`);

    expect(await refusal(call(ctx, 'put_page', { slug: 'runs-2026', source_id: 'storage', content: '---\ntype: note\ntitle: x\n---\nx\n', request_id: randomUUID() }))).toBe('storage_source_managed');

    const got = await call(ctx, 'storage_get', { id: 'runs-2026' });
    await call(ctx, 'storage_update', { id: 'runs-2026', expected_revision: got.revision, restored_to: '/scratch/runs-2026', restored_verified: true });
    expect(Number(git(repository, 'rev-list', '--count', 'main'))).toBe(Number(before) + 2);
    expect((await call(ctx, 'storage_find', { query: 'old research runs' })).hits[0]).toMatchObject({ id: 'runs-2026', match: 'alias' });
  }), 60_000);
});
