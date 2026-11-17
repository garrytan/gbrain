/**
 * Originals are never overwritten (core/file-originals.ts): a different file
 * uploaded under a name that is already taken is stored beside the original,
 * which keeps its bytes and its row. The same bytes again stay a no-op, and a
 * row with nothing stored behind it is still healed in place (#4302).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { keptOriginalPath, placeOriginal, ORIGINAL_HASH_CHARS } from '../src/core/file-originals.ts';

describe('placeOriginal', () => {
  const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64), h3 = 'c'.repeat(64);

  test('free name: write there; same bytes: nothing to write', () => {
    expect(placeOriginal('p/x.pdf', h1, undefined, undefined)).toEqual({ action: 'write', path: 'p/x.pdf' });
    expect(placeOriginal('p/x.pdf', h1, h1, undefined)).toEqual({ action: 'same', path: 'p/x.pdf' });
  });

  test('other bytes under the name: write beside it and keep the original', () => {
    const kept = keptOriginalPath('p/x.pdf', h2);
    expect(kept).toBe(`p/${h2.slice(0, ORIGINAL_HASH_CHARS)}-x.pdf`);
    expect(placeOriginal('p/x.pdf', h2, h1, undefined)).toEqual({ action: 'write', path: kept, keptOriginal: 'p/x.pdf' });
    expect(placeOriginal('p/x.pdf', h2, h1, h2)).toEqual({ action: 'same', path: kept });
  });

  test('both places taken by other bytes: refuse', () => {
    expect(placeOriginal('p/x.pdf', h2, h1, h3).action).toBe('refuse');
  });

  test('sha256:-prefixed hashes compare equal to bare ones', () => {
    expect(placeOriginal('p/x.pdf', h1, `sha256:${h1}`, undefined).action).toBe('same');
  });

  test('a name with no folder keeps working', () => {
    expect(keptOriginalPath('x.pdf', h2)).toBe(`${h2.slice(0, ORIGINAL_HASH_CHARS)}-x.pdf`);
  });
});

describe('file_upload keeps originals', () => {
  let engine: PGLiteEngine;
  let storageDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    storageDir = mkdtempSync(join(tmpdir(), 'gb-originals-storage-'));
    fixtureDir = mkdtempSync(join(tmpdir(), 'gb-originals-fixtures-'));
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const ctx = () => ({
    engine,
    config: { engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: storageDir } },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  }) as never;

  type Out = { status: string; storage_path: string; kept_original?: string };
  const upload = async (name: string, bytes: string, page = 'notes/evidence'): Promise<Out> => {
    const src = join(fixtureDir, name);
    writeFileSync(src, bytes);
    return (await operationsByName['file_upload'].handler(ctx(), { path: src, page_slug: page })) as Out;
  };
  const rowHash = async (path: string) =>
    (await engine.executeRaw<{ content_hash: string }>('SELECT content_hash FROM files WHERE storage_path = $1', [path]))[0]?.content_hash;

  test('a different file with a taken name is stored beside it; the original bytes and row are untouched', async () => {
    const first = await upload('contract.txt', 'version one');
    expect(first).toMatchObject({ status: 'uploaded', storage_path: 'notes/evidence/contract.txt' });
    const firstHash = await rowHash('notes/evidence/contract.txt');

    const second = await upload('contract.txt', 'version two, different bytes');
    expect(second.status).toBe('uploaded');
    expect(second.kept_original).toBe('notes/evidence/contract.txt');
    expect(second.storage_path).not.toBe('notes/evidence/contract.txt');
    expect(second.storage_path).toMatch(/^notes\/evidence\/[0-9a-f]{12}-contract\.txt$/);

    expect(readFileSync(join(storageDir, 'notes/evidence/contract.txt'), 'utf8')).toBe('version one');
    expect(readFileSync(join(storageDir, second.storage_path), 'utf8')).toBe('version two, different bytes');
    expect(await rowHash('notes/evidence/contract.txt')).toBe(firstHash);
    expect(await rowHash(second.storage_path)).not.toBe(firstHash);
  });

  test('uploading either version again is a no-op at its own path', async () => {
    const again1 = await upload('contract.txt', 'version one');
    expect(again1).toMatchObject({ status: 'already_exists', storage_path: 'notes/evidence/contract.txt' });
    const again2 = await upload('contract.txt', 'version two, different bytes');
    expect(again2.status).toBe('already_exists');
    expect(again2.storage_path).toMatch(/^notes\/evidence\/[0-9a-f]{12}-contract\.txt$/);
  });

  test('a row with nothing stored behind it is healed in place, not kept', async () => {
    await upload('ghost.txt', 'old bytes');
    unlinkSync(join(storageDir, 'notes/evidence/ghost.txt'));
    const out = await upload('ghost.txt', 'new bytes');
    expect(out.status).toBe('uploaded');
    expect(out.storage_path).toBe('notes/evidence/ghost.txt');
    expect(out.kept_original).toBeUndefined();
    expect(existsSync(join(storageDir, 'notes/evidence/ghost.txt'))).toBe(true);
  });
});
