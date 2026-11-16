/**
 * #5963 Part A: `gbrain files upload-raw` on a managed canonical worktree
 * refuses before creating anything (no empty `.raw/` directory, no files row),
 * and names `gbrain files upload` with a storage backend; `file_upload` with no
 * backend stops pointing at upload-raw for a managed page.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, operationsByName } from '../src/core/operations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { refreshManagedFilesystemRoots } from '../src/core/persistence/filesystem-guard.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runFiles } from '../src/commands/files.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-upload-raw-managed-'));
const fixtures = mkdtempSync(join(process.cwd(), '.gb-5963-fixtures-'));

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await disposePersistenceConsumer(engine); await engine.disconnect();
  rmSync(dir, { recursive: true, force: true }); rmSync(fixtures, { recursive: true, force: true });
});

test('upload-raw on a managed root refuses before any mkdir and leaves no files row', async () => {
  await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    const sourceId = `raw-${randomUUID().slice(0, 8)}`;
    const root = join(dir, sourceId); mkdirSync(root);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await refreshManagedFilesystemRoots(engine);
    const doc = join(fixtures, 'doc.pdf');
    writeFileSync(doc, '%PDF-1.4 example');
    let error: unknown;
    try { await runFiles(engine, ['upload-raw', doc, '--page', 'people/alice-example', '--source', sourceId]); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(OperationError);
    const refusal = error as OperationError;
    expect(refusal.code).toBe('writer_coordinator_required');
    expect(refusal.why).toContain('not supported');
    expect(refusal.fix?.argv).toEqual(['gbrain', 'files', 'upload', doc, '--page', 'people/alice-example']);
    expect(existsSync(join(root, 'people', '.raw'))).toBe(false);
    expect(await engine.executeRaw('SELECT 1 FROM files WHERE source_id=$1', [sourceId])).toEqual([]);

    const upload = await operationsByName.file_upload.handler({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} },
      dryRun: false, remote: false, sourceId } as never, { path: doc, page_slug: 'people/alice-example' }).catch((e: unknown) => e as OperationError);
    expect((upload as OperationError).code).toBe('storage_error');
    expect((upload as OperationError).suggestion).not.toContain('upload-raw');
    expect(JSON.stringify((upload as OperationError).fix ?? null)).not.toContain('upload-raw');
  });
}, 60_000);

// #7346: an object-storage upload-raw names the backend it used, and on a managed root its pointer write is refused
// before any byte leaves the machine.
// Value: protects=an upload-raw that cannot write its pointer uploads nothing, and scripts read the real backend;
// fails_when=the bytes reach the backend before the managed refusal, or the JSON says supabase for another backend;
// why_new=the #5963 pin covers only the git-storage branch; seam=runFiles upload-raw with a local storage backend;
// no_claim=publishing pointers through the persistence coordinator.
test('#7346: object-storage upload-raw labels the backend it used', async () => {
  const home = join(dir, 'home-7346-label');
  const store = join(dir, 'store-7346-label');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', storage: { backend: 'local', bucket: 'brain-files', localPath: store } }));
  const img = join(fixtures, 'photo-7346.png');
  writeFileSync(img, 'png-bytes');
  const logs: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await withEnv({ GBRAIN_HOME: home }, () => runFiles(engine, ['upload-raw', img, '--page', 'people/alice-example']));
  } finally { logSpy.mockRestore(); errSpy.mockRestore(); }
  const out = JSON.parse(logs[logs.length - 1]!);
  expect(out.storage).toBe('local');
  expect(out.reference).toBe('local://brain-files/people/alice-example/photo-7346.png');
  expect(readFileSync(img + '.redirect.yaml', 'utf-8')).toContain('target: local://brain-files/people/alice-example/photo-7346.png');
  expect(existsSync(join(store, 'people', 'alice-example', 'photo-7346.png'))).toBe(true);
}, 60_000);

test('#7346: object-storage upload-raw of a file in a managed root refuses before uploading', async () => {
  const home = join(dir, 'home-7346-managed');
  const store = join(dir, 'store-7346-managed');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', storage: { backend: 'local', bucket: 'brain-files', localPath: store } }));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const sourceId = `raw-${randomUUID().slice(0, 8)}`;
    const root = join(dir, sourceId); mkdirSync(join(root, 'people'), { recursive: true });
    const img = join(root, 'people', 'photo-7346-managed.png');
    writeFileSync(img, 'png-bytes');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await refreshManagedFilesystemRoots(engine);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    let error: unknown;
    try { await runFiles(engine, ['upload-raw', img, '--page', 'people/alice-example']); } catch (e) { error = e; } finally { errSpy.mockRestore(); }
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('writer_coordinator_required');
    expect((error as OperationError).fix?.argv).toEqual(['gbrain', 'files', 'upload-raw', img, '--page', 'people/alice-example', '--no-pointer']);
    expect(existsSync(join(store, 'people', 'alice-example', 'photo-7346-managed.png'))).toBe(false);
    expect(existsSync(img + '.redirect.yaml')).toBe(false);
    expect(await engine.executeRaw("SELECT 1 FROM files WHERE storage_path='people/alice-example/photo-7346-managed.png'")).toEqual([]);
  });
}, 60_000);
