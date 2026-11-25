/**
 * An attachment upload that is waiting on storage when its page is renamed is recorded under the page's current slug.
 *
 * Authoring gate
 *  1. Protects: file_upload reads the page's slug and id, uploads the bytes, then records the files row. A rename
 *     (updateSlug: sync renames, `gbrain repair rename-identity`, `gbrain repair slug-spelling`) that commits during the
 *     upload must not leave the row under the old slug, where `file_list` by the page's slug no longer finds it.
 *  2. Fails when: the row takes the slug the upload read before the storage wait.
 *  3. Why new: no test interleaves a rename with an upload in flight.
 *  4. Seams: the local storage backend's `uploadFile`, held on a promise so the rename runs while the upload waits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
let home: string, storageDir: string, fixtureDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gb-upload-rename-home-'));
  storageDir = mkdtempSync(join(tmpdir(), 'gb-upload-rename-storage-'));
  fixtureDir = mkdtempSync(join(tmpdir(), 'gb-upload-rename-files-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
}, 120_000);
afterAll(async () => {
  await engine?.disconnect();
  for (const d of [home, storageDir, fixtureDir]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('file_upload during a rename', () => {
  test('an upload waiting on storage while its page is renamed is listed under the new slug', () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.putPage('people/old-name', { type: 'person', title: 'Old name', compiled_truth: 'body', timeline: '' });
    const fixture = join(fixtureDir, 'card.txt');
    writeFileSync(fixture, 'card bytes\n');

    let release!: () => void, waiting!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { waiting = resolve; });
    const original = LocalStorage.prototype.uploadFile;
    LocalStorage.prototype.uploadFile = async function (this: LocalStorage, ...args: Parameters<typeof original>) {
      waiting(); await gate; return original.apply(this, args);
    };
    try {
      const ctx = { engine, config: { engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: storageDir } }, remote: false, sourceId: 'default' } as never;
      const upload = operationsByName.file_upload!.handler(ctx, { path: fixture, page_slug: 'people/old-name' });
      upload.catch(() => undefined);
      await reached;
      // The rename commits while the upload waits on storage.
      expect(await engine.updateSlug('people/old-name', 'people/new-name', { sourceId: 'default' })).toBe(1);
      release();
      expect(await upload).toMatchObject({ status: 'uploaded' });
    } finally {
      LocalStorage.prototype.uploadFile = original;
    }
    const listed = await operationsByName.file_list!.handler({ engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default' } as never, { slug: 'people/new-name' }) as Array<{ page_slug: string; filename: string }>;
    const rows = await engine.executeRaw<{ page_slug: string; page_id: number | null }>("SELECT page_slug, page_id FROM files WHERE filename = 'card.txt'");
    expect({ listed: listed.map(f => [f.page_slug, f.filename]), rows: rows.map(r => r.page_slug) })
      .toEqual({ listed: [['people/new-name', 'card.txt']], rows: ['people/new-name'] });
  }), 60_000);

  test('a re-upload of an existing attachment with new bytes, waiting on storage while its page is renamed, moves the row to the new slug', () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.putPage('people/re-old', { type: 'person', title: 'Old name', compiled_truth: 'body', timeline: '' });
    const fixture = join(fixtureDir, 're-card.txt');
    const ctx = { engine, config: { engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: storageDir } }, remote: false, sourceId: 'default' } as never;
    writeFileSync(fixture, 'first bytes\n');
    expect(await operationsByName.file_upload!.handler(ctx, { path: fixture, page_slug: 'people/re-old' })).toMatchObject({ status: 'uploaded' });
    writeFileSync(fixture, 'second bytes\n');

    let release!: () => void, waiting!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { waiting = resolve; });
    const original = LocalStorage.prototype.uploadFile;
    LocalStorage.prototype.uploadFile = async function (this: LocalStorage, ...args: Parameters<typeof original>) {
      waiting(); await gate; return original.apply(this, args);
    };
    try {
      const upload = operationsByName.file_upload!.handler(ctx, { path: fixture, page_slug: 'people/re-old' });
      upload.catch(() => undefined);
      await reached;
      expect(await engine.updateSlug('people/re-old', 'people/re-new', { sourceId: 'default' })).toBe(1);
      release();
      expect(await upload).toMatchObject({ status: 'uploaded' });
    } finally {
      LocalStorage.prototype.uploadFile = original;
    }
    const rows = await engine.executeRaw<{ page_slug: string }>("SELECT page_slug FROM files WHERE filename = 're-card.txt'");
    expect(rows.map(r => r.page_slug)).toEqual(['people/re-new']);
  }), 60_000);
});

const pg = testBackends().includes('postgres') ? describe : describe.skip;
pg('file_upload during a rename (postgres, a rename transaction still open)', () => {
  let engine2: BrainEngine; let close: () => Promise<void>;
  beforeAll(async () => { const db = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine2 = db.engine; close = db.close; }, 180_000);
  afterAll(async () => { await close?.(); });

  test('the upload\'s row waits for the open rename and takes the new slug', () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine2.putPage('people/pg-old', { type: 'person', title: 'Old name', compiled_truth: 'body', timeline: '' });
    const fixture = join(fixtureDir, 'pg-card.txt');
    writeFileSync(fixture, 'pg card bytes\n');
    let release!: () => void, renamed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const opened = new Promise<void>(resolve => { renamed = resolve; });
    // The rename holds its transaction open (its page row locked) while the upload records its row.
    const rename = engine2.transaction(async tx => { await tx.updateSlug('people/pg-old', 'people/pg-new', { sourceId: 'default' }); renamed(); await gate; });
    await opened;
    const ctx = { engine: engine2, config: { engine: 'postgres', storage: { backend: 'local', bucket: 'b', localPath: storageDir } }, remote: false, sourceId: 'default' } as never;
    const upload = operationsByName.file_upload!.handler(ctx, { path: fixture, page_slug: 'people/pg-old' });
    upload.catch(() => undefined);
    await Promise.race([upload, new Promise(resolve => setTimeout(resolve, 1500))]);
    release();
    await rename;
    expect(await upload).toMatchObject({ status: 'uploaded' });
    const rows = await engine2.executeRaw<{ page_slug: string }>("SELECT page_slug FROM files WHERE filename = 'pg-card.txt'");
    expect(rows.map(r => r.page_slug)).toEqual(['people/pg-new']);
  }), 60_000);
});
