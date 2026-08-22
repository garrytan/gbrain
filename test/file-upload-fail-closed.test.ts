/**
 * #4302 — file_upload / file_url fail-closed honesty.
 *
 * Before the fix:
 *   - file_upload with NO storage backend inserted a files row and returned
 *     status:'uploaded' — the row claimed bytes stored nowhere;
 *   - already_exists trusted the DB row alone — vanished backend bytes lied;
 *   - file_url returned a `gbrain:files/<path>` placeholder pointing at
 *     nothing, without ever consulting a backend.
 *
 * Runs the op handlers directly with a crafted ctx (config controlled per
 * test) against a real `local` backend.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, OperationError } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let storageDir: string;
let fixtureDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  storageDir = mkdtempSync(join(tmpdir(), 'gb-4302-storage-'));
  // Remote-confinement default is strict (cwd) — keep fixtures under cwd.
  fixtureDir = mkdtempSync(join(process.cwd(), '.gb-4302-fixtures-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(storageDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

function mkCtx(withStorage: boolean) {
  return {
    engine,
    config: withStorage
      ? { engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: storageDir } }
      : { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false, // local trust: loose path confinement; storage policy is what's under test
    sourceId: 'default',
  } as never;
}

describe('file_upload fail-closed (#4302)', () => {
  test('no storage backend: typed storage_error BEFORE any files row', async () => {
    const op = operationsByName['file_upload'];
    const src = join(fixtureDir, 'nostore.txt');
    writeFileSync(src, 'bytes with nowhere to go');
    let threw: unknown = null;
    try {
      await op.handler(mkCtx(false), { path: src, page_slug: 'notes/nostore' });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(OperationError);
    expect((threw as OperationError).code).toBe('storage_error');
    // No phantom row.
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM files WHERE filename = 'nostore.txt'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(0);
  });

  test('upload with a local backend stores real bytes + row', async () => {
    const op = operationsByName['file_upload'];
    const src = join(fixtureDir, 'real.txt');
    writeFileSync(src, 'real bytes');
    const out = (await op.handler(mkCtx(true), { path: src, page_slug: 'notes/real' })) as {
      status: string; storage_path: string;
    };
    expect(out.status).toBe('uploaded');
    expect(existsSync(join(storageDir, 'notes/real/real.txt'))).toBe(true);
  });

  test('already_exists only when the backend really holds the object', async () => {
    const op = operationsByName['file_upload'];
    const src = join(fixtureDir, 'dup.txt');
    writeFileSync(src, 'duplicate candidate');
    const first = (await op.handler(mkCtx(true), { path: src, page_slug: 'notes/dup' })) as { status: string };
    expect(first.status).toBe('uploaded');
    // Row + backend both present → honest already_exists.
    const second = (await op.handler(mkCtx(true), { path: src, page_slug: 'notes/dup' })) as { status: string };
    expect(second.status).toBe('already_exists');
    // Backend bytes vanish → the row alone must NOT claim already_exists.
    unlinkSync(join(storageDir, 'notes/dup/dup.txt'));
    const third = (await op.handler(mkCtx(true), { path: src, page_slug: 'notes/dup' })) as { status: string };
    expect(third.status).toBe('uploaded');
    expect(existsSync(join(storageDir, 'notes/dup/dup.txt'))).toBe(true);
  });
});

describe('file_url fail-closed (#4302)', () => {
  test('resolves a real backend URL for a present object', async () => {
    const upload = operationsByName['file_upload'];
    const src = join(fixtureDir, 'url.txt');
    writeFileSync(src, 'url target');
    await upload.handler(mkCtx(true), { path: src, page_slug: 'notes/url' });
    const op = operationsByName['file_url'];
    const out = (await op.handler(mkCtx(true), { storage_path: 'notes/url/url.txt' })) as { url: string };
    // LocalStorage canonicalizes its base (macOS /var → /private/var).
    expect(out.url).toBe(`file://${join(realpathSync(storageDir), 'notes/url/url.txt')}`);
  });

  test('row without backend object: storage_error, not a fake URL', async () => {
    const upload = operationsByName['file_upload'];
    const src = join(fixtureDir, 'gone.txt');
    writeFileSync(src, 'soon gone');
    await upload.handler(mkCtx(true), { path: src, page_slug: 'notes/gone' });
    unlinkSync(join(storageDir, 'notes/gone/gone.txt'));
    const op = operationsByName['file_url'];
    let threw: unknown = null;
    try {
      await op.handler(mkCtx(true), { storage_path: 'notes/gone/gone.txt' });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(OperationError);
    expect((threw as OperationError).code).toBe('storage_error');
    expect(String((threw as OperationError).message)).toContain('re-upload');
  });

  test('no backend configured: storage_error, never the gbrain:files placeholder', async () => {
    const upload = operationsByName['file_upload'];
    const src = join(fixtureDir, 'nourl.txt');
    writeFileSync(src, 'no url backend');
    await upload.handler(mkCtx(true), { path: src, page_slug: 'notes/nourl' });
    const op = operationsByName['file_url'];
    let threw: unknown = null;
    try {
      await op.handler(mkCtx(false), { storage_path: 'notes/nourl/nourl.txt' });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(OperationError);
    expect((threw as OperationError).code).toBe('storage_error');
  });
});
