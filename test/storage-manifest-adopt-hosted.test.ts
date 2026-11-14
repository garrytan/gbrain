/**
 * GST-1943: `gbrain storage adopt` and JSONL import on a brain with a Git checkout (managed persistence, PGLite). Git stays
 * the parent. Protects:
 *   - adopt and import refuse storage_manifest_missing until storage init has hosted the shelf, and write nothing;
 *   - after init, the adopt apply commits each card to the hosted repository (origin adopt) and tags the original through
 *     its own source's page door, deleting nothing; finalize then soft-deletes the original.
 * .serial: real git subprocesses and a GBRAIN_HOME swap.
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { initStorageSource } from '../src/core/storage-manifest/source.ts';
import { applyAdopt, applyFinalize, previewAdopt, previewFinalize } from '../src/core/storage-manifest/adopt.ts';
import { previewImport } from '../src/core/storage-manifest/jsonl.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx, params) as Promise<Record<string, any>>;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: { code?: string; canonical?: string }) => e.canonical ?? e.code ?? 'error');
const FENCE = '```';
const record = (id: string) => ({ id, title: `Archive ${id}`, kind: 'directory',
  locations: [{ store: 'b2', bucket: 'bucket-a', path: `/archive/${id}`, tool: 'restic', repository: 'archive/restic', snapshot: 'c'.repeat(64), size_bytes: 4096, hash_kind: 'sha256-tree-v1' }],
  original_path: `/srv/data/${id}`, restore: { skill: 'restore-data', args: { id }, command: 'restic restore latest' } });
const opts = { sourceId: 'default', prefix: 'storage-manifest/' };

describe('storage adopt on a brain with a Git checkout', () => {
  test('adopt and import wait for storage init; then cards are committed first and originals are tagged, then finalized', () => managedBrain(async ({ engine, ctx, root }) => {
    await call(ctx, 'put_page', { slug: 'storage-manifest/runs-2026', request_id: randomUUID(),
      content: `---\ntype: stored-object\ntitle: Interim runs\n---\n## Record\n\n${FENCE}json\n${JSON.stringify(record('runs-2026'))}\n${FENCE}\n` });
    expect(await refusal(previewAdopt(ctx, opts))).toBe('storage_manifest_missing');
    expect(await refusal(previewImport(engine, 'shelf.jsonl', JSON.stringify({ ...record('runs-2026'), restore: { skill: 'restore-data' } })))).toBe('storage_manifest_missing');
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);

    const dir = join(dirname(root), 'shelf');
    const preview = await initStorageSource(engine, { dir, dryRun: true });
    await initStorageSource(engine, { dir, dryRun: false, expect: preview.plan!.plan_hash });
    const repository = join(dir, 'repo.git');
    const before = Number(git(repository, 'rev-list', '--count', 'main'));

    const plan = await previewAdopt(ctx, opts);
    expect(plan).toMatchObject({ shelf: 'exists', drop_fields: ['restore.command'], counts: { register: 1 } });
    const applied = await applyAdopt(ctx, { ...opts, expect: plan.plan_hash, dropFields: ['restore.command'] });
    expect(applied).toMatchObject({ side_effects: 'complete' });
    expect(Number(git(repository, 'rev-list', '--count', 'main'))).toBe(before + 1);
    const file = git(repository, 'ls-tree', '-r', '--name-only', 'main').split('\n').find((path) => path.includes('runs-2026'));
    const committed = git(repository, 'show', `main:${file}`);
    expect(committed).toContain('origin: adopt');
    expect(committed).not.toContain('restic restore latest');
    expect(await engine.executeRaw("SELECT t.tag FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.source_id='default' AND p.slug='storage-manifest/runs-2026'")).toContainEqual({ tag: 'storage-manifest-adopted' });
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default' AND deleted_at IS NOT NULL")).toEqual([]);

    const finalize = await previewFinalize(ctx, opts);
    expect(finalize.entries.map((e) => e.state)).toEqual(['delete']);
    expect(await applyFinalize(ctx, { ...opts, expect: finalize.plan_hash })).toMatchObject({ side_effects: 'complete', deleted: ['storage-manifest/runs-2026'] });
    expect((await call(ctx, 'storage_get', { id: 'runs-2026' })).origin).toBe('adopt');
  }), 90_000);
});
