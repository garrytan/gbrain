/**
 * #6609 (D5): restoring a page whose recorded canonical file is gone.
 *
 * Protects: on a classic brain whose restore writes no file
 * (`sync.write_through` off), `restore_page` of a soft-deleted page whose
 * recorded file left the checkout refuses with `source_changed` /
 * `canonical_file_absent` and an ask-the-user fix naming `--detach`, and
 * nothing is restored; `detach: true` restores it database-only (no
 * `source_path`, `database_only_reason='detached'`) and a later
 * `gbrain sync --full` keeps it live; `detach` is refused when there is
 * nothing to detach; doctor `missing_recorded_files` warns about a live page
 * whose recorded file a full sync would not find.
 * Fails when: the restore succeeds and keeps the stale `source_path`, so the
 * next full sync soft-deletes the page again (the reported bug).
 * Seams: none; PGLite in memory, a real Git checkout, `performSync`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { missingRecordedFilesEntry } from '../src/commands/doctor/checks/missing-recorded-files.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

const restore_page = operations.find(o => o.name === 'restore_page')!;
let engine: PGLiteEngine;
const dirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('sync.write_through', 'false');
  _resetWriteThroughCacheForTest();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 60_000);

/** A classic source `id` whose checkout holds `people/<name>.md`, synced, then the file untracked and ignored, and synced again (page soft-deleted). */
async function untrackedPage(id: string, name: string): Promise<{ dir: string; slug: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'restore-detach-'));
  dirs.push(dir);
  execSync('git init -q && git config user.email t@example.com && git config user.name t', { cwd: dir });
  mkdirSync(join(dir, 'people'), { recursive: true });
  writeFileSync(join(dir, 'people', `${name}.md`), `---\ntype: person\ntitle: ${name}\n---\n# ${name}\n\nA fixture.\n`);
  execSync('git add -A && git commit -qm seed', { cwd: dir });
  await runSources(engine, ['add', id, '--path', dir, '--no-federated']);
  await performSync(engine, { repoPath: dir, sourceId: id, noPull: true, noEmbed: true });
  appendFileSync(join(dir, '.gitignore'), `/people/${name}.md\n`);
  execSync(`git rm -q --cached people/${name}.md && git add .gitignore && git commit -qm untrack`, { cwd: dir });
  await performSync(engine, { repoPath: dir, sourceId: id, noPull: true, noEmbed: true });
  return { dir, slug: `people/${name}` };
}

function ctx(sourceId: string): OperationContext {
  return { engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId } as unknown as OperationContext;
}
async function restore(sourceId: string, slug: string, extra: Record<string, unknown> = {}) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return restore_page.handler(ctx(sourceId), { slug, source_id: sourceId, expected_revision: snapshot!.revision, request_id: randomUUID(), ...extra }) as Promise<Record<string, any>>;
}
async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  try { await promise; } catch (error) { return error as OperationError; }
  throw new Error('restore_page did not refuse');
}
async function pageRow(sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<{ source_path: string | null; database_only_reason: string | null; live: boolean }>(
    'SELECT source_path, database_only_reason, deleted_at IS NULL AS live FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row;
}
async function doctor(): Promise<Check> {
  const checks = await missingRecordedFilesEntry.run({ engine } as unknown as DoctorContext) as Check[];
  return checks[0]!;
}

describe('#6609 restore of a page whose recorded file is gone', () => {
  test('a plain restore refuses with canonical_file_absent and the detach choice; nothing is restored', async () => {
    const { slug } = await untrackedPage('refuse', 'alice-example');
    expect(await pageRow('refuse', slug)).toEqual({ source_path: `${slug}.md`, database_only_reason: null, live: false });
    const error = await refusal(restore('refuse', slug));
    expect(error.code).toBe('source_changed');
    expect(error.detail).toBe('canonical_file_absent');
    expect(error.retryable).toBe(false);
    expect(error.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'restore', slug, '--source-id', 'refuse', '--detach'],
      mcp: { tool: 'restore_page', arguments: { slug, source_id: 'refuse', detach: true } } });
    expect(error.suggestion).toContain(`put ${slug}.md back in the checkout`);
    expect(await pageRow('refuse', slug)).toEqual({ source_path: `${slug}.md`, database_only_reason: null, live: false });
  }, 60_000);

  test('detach restores it database-only, a full sync keeps it live, and its file synced back re-binds it', async () => {
    const { dir, slug } = await untrackedPage('detach', 'bob-example');
    const restored = await restore('detach', slug, { detach: true });
    expect(restored.status).toBe('restored');
    expect(await pageRow('detach', slug)).toEqual({ source_path: null, database_only_reason: 'detached', live: true });
    await performSync(engine, { repoPath: dir, sourceId: 'detach', noPull: true, noEmbed: true, full: true });
    expect(await pageRow('detach', slug)).toEqual({ source_path: null, database_only_reason: 'detached', live: true });
    // A file synced back at its path re-binds the page and clears the detached stamp.
    execSync(`git rm -q --cached .gitignore && rm .gitignore && git add people && git commit -qm retrack`, { cwd: dir });
    await performSync(engine, { repoPath: dir, sourceId: 'detach', noPull: true, noEmbed: true, full: true });
    expect(await pageRow('detach', slug)).toEqual({ source_path: `${slug}.md`, database_only_reason: null, live: true });
  }, 60_000);

  test('detach is refused when the recorded file is still in the checkout', async () => {
    const { dir, slug } = await untrackedPage('present', 'carol-example');
    execSync(`git rm -q --cached .gitignore && rm .gitignore && git add people && git commit -qm retrack`, { cwd: dir });
    const error = await refusal(restore('present', slug, { detach: true }));
    expect(error.code).toBe('invalid_params');
    expect(error.suggestion).toContain('has its file in place');
    expect((await pageRow('present', slug)).live).toBe(false);
    expect((await restore('present', slug)).status).toBe('restored');
    expect(await pageRow('present', slug)).toEqual({ source_path: `${slug}.md`, database_only_reason: null, live: true });
  }, 60_000);

  test('doctor missing_recorded_files warns about a live page a full sync would delete, and asks the user', async () => {
    expect(categorizeCheck('missing_recorded_files')).toBe('brain');
    const before = await doctor();
    expect(before.status).toBe('ok');
    const { slug } = await untrackedPage('stale', 'dana-example');
    // A page restored the old way: live, still recording the file that left the checkout.
    await engine.executeRaw('UPDATE pages SET deleted_at=NULL WHERE source_id=$1 AND slug=$2', ['stale', slug]);
    const check = await doctor();
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ count: 1 });
    expect(check.message).toContain(`stale:${slug} (${slug}.md)`);
    expect(check.message).toContain(`gbrain restore ${slug} --source-id stale --detach`);
    expect(check.fix).toMatchObject({ ask_user: true });
  }, 60_000);
});
