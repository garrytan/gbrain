/**
 * file_register and file_verify: a host that put a file's bytes in the brain's storage itself records gbrain's files
 * row for it, and reads it back, without the bytes ever passing through the process that runs gbrain. Neither reads a
 * local file, so both are callable over a network transport, unlike file_upload.
 *
 * Runs the op handlers directly with a crafted ctx against a real `local` backend, and the dispatcher with no
 * transport marker (a network caller).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, OperationError } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
let storageDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  storageDir = mkdtempSync(join(tmpdir(), 'gb-file-register-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(storageDir, { recursive: true, force: true });
});

const storage = () => ({ backend: 'local', bucket: 'b', localPath: storageDir });

function ctx(withStorage = true) {
  return {
    engine,
    config: withStorage ? { engine: 'pglite', storage: storage() } : { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
  } as never;
}

/** An object a host stored itself, and the row it would register for it. */
function stored(path: string, body: string) {
  const full = join(storageDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return {
    storage_path: path,
    filename: path.split('/').pop()!,
    size_bytes: Buffer.byteLength(body),
    content_hash: createHash('sha256').update(body).digest('hex'),
    mime_type: 'text/plain',
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error('expected a refusal');
}

async function count(path: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*)::text AS n FROM files WHERE storage_path = $1`, [path]);
  return Number.parseInt(rows[0].n, 10);
}

describe('file_register', () => {
  test('records the row for an object storage holds, attached to its page, and nothing else', async () => {
    const file = stored('notes/plan/plan.pdf', 'a plan in a pdf');
    const out = await operationsByName.file_register.handler(ctx(), { ...file, page_slug: 'notes/plan' });
    expect(out).toEqual({ status: 'registered', storage_path: 'notes/plan/plan.pdf', size_bytes: file.size_bytes });
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT page_slug, filename, mime_type, size_bytes, content_hash, metadata FROM files WHERE storage_path = $1`, [file.storage_path]);
    expect(rows.length).toBe(1);
    expect(rows[0].page_slug).toBe('notes/plan');
    expect(rows[0].filename).toBe('plan.pdf');
    expect(Number(rows[0].size_bytes)).toBe(file.size_bytes);
    expect(rows[0].content_hash).toBe(file.content_hash);
    expect((rows[0].metadata as Record<string, unknown>).storage).toBe('local');
  });

  test('registering again is the same one row', async () => {
    const file = stored('unsorted/twice.txt', 'twice');
    await operationsByName.file_register.handler(ctx(), file);
    await operationsByName.file_register.handler(ctx(), file);
    expect(await count('unsorted/twice.txt')).toBe(1);
  });

  test('an object storage does not hold is refused, and no row is recorded', async () => {
    const error = await refusal(() => operationsByName.file_register.handler(ctx(), {
      storage_path: 'unsorted/nowhere.txt', filename: 'nowhere.txt', size_bytes: 3, content_hash: 'a'.repeat(64),
    }));
    expect(error.code).toBe('storage_error');
    expect(await count('unsorted/nowhere.txt')).toBe(0);
  });

  test('with no storage backend it is refused before anything is recorded', async () => {
    const file = stored('unsorted/nobackend.txt', 'x');
    const error = await refusal(() => operationsByName.file_register.handler(ctx(false), file));
    expect(error.code).toBe('storage_error');
    expect(await count('unsorted/nobackend.txt')).toBe(0);
  });

  test('a storage path that climbs, is absolute, or has an empty segment is refused', async () => {
    for (const storage_path of ['../outside.txt', 'a/../../b.txt', '/etc/passwd', 'a//b.txt', 'a/./b.txt', 'a\\b.txt', 'a/b\u0000.txt']) {
      const error = await refusal(() => operationsByName.file_register.handler(ctx(), {
        storage_path, filename: 'b.txt', size_bytes: 1, content_hash: 'a'.repeat(64),
      }));
      expect(error.code).toBe('invalid_params');
    }
  });

  test('a hash that is not hex SHA-256, or a size that is not whole bytes, is refused', async () => {
    const file = stored('unsorted/shape.txt', 'shape');
    for (const bad of [{ content_hash: 'sha1:abc' }, { content_hash: 'A'.repeat(64) }, { size_bytes: -1 }, { size_bytes: 1.5 }]) {
      const error = await refusal(() => operationsByName.file_register.handler(ctx(), { ...file, ...bad }));
      expect(error.code).toBe('invalid_params');
    }
  });
});

describe('file_verify', () => {
  test('lists the rows, one page or all, each with whether its object is present', async () => {
    const kept = stored('people/ana/photo.jpg', 'a photo');
    await operationsByName.file_register.handler(ctx(), { ...kept, page_slug: 'people/ana' });
    const gone = stored('people/ana/gone.jpg', 'gone soon');
    await operationsByName.file_register.handler(ctx(), { ...gone, page_slug: 'people/ana' });
    rmSync(join(storageDir, gone.storage_path));

    const listed = (await operationsByName.file_verify.handler(ctx(), { slug: 'people/ana' })) as Array<Record<string, unknown>>;
    expect(listed.map(r => [r.storage_path, r.present])).toEqual([['people/ana/gone.jpg', false], ['people/ana/photo.jpg', true]]);
    const all = (await operationsByName.file_verify.handler(ctx(), {})) as Array<Record<string, unknown>>;
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test('with a storage path, reads the bytes back and says whether they match the row', async () => {
    const file = stored('notes/read/back.txt', 'read me back');
    await operationsByName.file_register.handler(ctx(), file);
    const out = (await operationsByName.file_verify.handler(ctx(), { storage_path: file.storage_path })) as Record<string, unknown>;
    expect(out).toMatchObject({ present: true, matches: true, read_bytes: file.size_bytes, read_sha256: file.content_hash });

    writeFileSync(join(storageDir, file.storage_path), 'changed underneath');
    const changed = (await operationsByName.file_verify.handler(ctx(), { storage_path: file.storage_path })) as Record<string, unknown>;
    expect(changed).toMatchObject({ present: true, matches: false });
  });

  test('a backend that fails is an error, never a list of files reported missing', async () => {
    // A row the backend cannot be asked about (its path escapes the local root, so the local backend throws, as an
    // S3 backend throws when the store does not answer).
    await engine.executeRaw(
      `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata) VALUES ('notes/broken', 'b.txt', '../escaped/b.txt', 'text/plain', 1, $1, '{}'::jsonb)`,
      ['b'.repeat(64)],
    );
    const error = await refusal(() => operationsByName.file_verify.handler(ctx(), { slug: 'notes/broken' }));
    expect(error.code).toBe('storage_error');
  });

  test('a storage path with no row is refused', async () => {
    const error = await refusal(() => operationsByName.file_verify.handler(ctx(), { storage_path: 'no/such/row.txt' }));
    expect(error.code).toBe('storage_error');
  });
});

describe('over a network transport', () => {
  test('both are dispatched with no transport marker, where file_list and file_upload are not', async () => {
    const file = stored('unsorted/network.txt', 'over the network');
    const opts = { remote: true, sourceId: 'default', config: { engine: 'pglite', storage: storage() } } as never;
    const registered = await dispatchToolCall(engine, 'file_register', file, opts);
    expect(registered.isError).not.toBe(true);
    const verified = await dispatchToolCall(engine, 'file_verify', { storage_path: file.storage_path }, opts);
    expect(verified.isError).not.toBe(true);
    expect(JSON.parse(verified.content[0].text)).toMatchObject({ matches: true });
    for (const name of ['file_list', 'file_upload']) {
      const denied = await dispatchToolCall(engine, name, {}, opts);
      expect(JSON.parse(denied.content[0].text).error).toBe('unknown_tool');
    }
  });
});

describe('the read policy', () => {
  const local = () => ({ ...(ctx() as Record<string, unknown>), remote: false }) as never;

  test('a remote caller cannot attach a file to a private page, nor replace the row of a file attached to one', async () => {
    await engine.putPage('notes/hidden', { type: 'note', title: 'Hidden', compiled_truth: 'A private note.', timeline: '', frontmatter: { visibility: 'private' } });
    const file = stored('notes/hidden/hidden.txt', 'a private attachment');
    const onto = await refusal(() => operationsByName.file_register.handler(ctx(), { ...file, page_slug: 'notes/hidden' }));
    expect(onto.code).toBe('page_not_found');
    expect(await count(file.storage_path)).toBe(0);

    await operationsByName.file_register.handler(local(), { ...file, page_slug: 'notes/hidden' });
    const over = await refusal(() => operationsByName.file_register.handler(ctx(), { ...file, page_slug: 'notes/elsewhere' }));
    expect(over.code).toBe('page_not_found');
    const rows = await engine.executeRaw<{ page_slug: string }>(`SELECT page_slug FROM files WHERE storage_path = $1`, [file.storage_path]);
    expect(rows).toEqual([{ page_slug: 'notes/hidden' }]);
  });

  test('a remote caller sees no file attached to a private page, as with file_list; a local caller does', async () => {
    await engine.putPage('notes/quiet', { type: 'note', title: 'Quiet', compiled_truth: 'A private note.', timeline: '', frontmatter: { visibility: 'private' } });
    const file = stored('notes/quiet/quiet.txt', 'a private attachment');
    await operationsByName.file_register.handler(local(), { ...file, page_slug: 'notes/quiet' });

    expect(await operationsByName.file_verify.handler(ctx(), { slug: 'notes/quiet' })).toEqual([]);
    const error = await refusal(() => operationsByName.file_verify.handler(ctx(), { storage_path: file.storage_path }));
    expect(error.code).toBe('storage_error');

    const listed = (await operationsByName.file_verify.handler(local(), { slug: 'notes/quiet' })) as Array<Record<string, unknown>>;
    expect(listed.map(r => [r.storage_path, r.present])).toEqual([[file.storage_path, true]]);
    expect(await operationsByName.file_verify.handler(local(), { storage_path: file.storage_path })).toMatchObject({ matches: true });
  });
});
