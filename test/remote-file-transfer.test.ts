/**
 * Remote file transfer (docs/designs/REMOTE_FILE_TRANSFER.md): file_upload_begin / file_upload_part /
 * file_upload_commit / file_upload_abort / file_get, plus file_list and file_url leaving localOnly.
 *
 * Runs over the real dispatcher against PGLite and a real `local` storage backend in a sandboxed GBRAIN_HOME. The
 * local backend cannot sign URLs, so it exercises the inline parts mode; direct mode is exercised by giving the local
 * backend a createUploadUrl for the test and writing the "PUT" bytes straight into its directory, as a client's PUT
 * would land them in a bucket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { S3Storage } from '../src/core/storage/s3.ts';
import { operationsByName } from '../src/core/operations.ts';
import { sniffMime } from '../src/core/ops/file-transfer.ts';
import { withEnv } from './helpers/with-env.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let engine: PGLiteEngine;
let home: string;
let storageDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gb-rft-home-'));
  storageDir = mkdtempSync(join(tmpdir(), 'gb-rft-storage-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    storage: { backend: 'local', bucket: 'test-bucket', localPath: storageDir },
    // The smallest result cap, so file_get's refusal over the cap is cheap to reach.
    mcp: { max_result_bytes_stdio: 256 * 1024 },
  }));
  await engine.putPage('meetings/2026-01-15', { type: 'meeting', title: 'Synthetic meeting', compiled_truth: 'Whiteboard session.', timeline: '' } as never);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const d of [home, storageDir]) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  delete (LocalStorage.prototype as { createUploadUrl?: unknown }).createUploadUrl;
});

/** A remote (untrusted) MCP caller on the local pipe, as the other file-op suites dispatch. */
async function call(name: string, params: Record<string, unknown>, sourceId = 'default') {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    const result = await dispatchToolCall(engine, name, params, { remote: true, transport: 'stdio', sourceId });
    const body = JSON.parse(result.content[0].text);
    return { result, body, isError: !!result.isError };
  });
}

/** begin + every part + commit in parts mode. */
async function uploadInParts(bytes: Buffer, params: Record<string, unknown>) {
  const begin = await call('file_upload_begin', { size_bytes: bytes.length, sha256: sha(bytes), ...params });
  expect(begin.isError).toBe(false);
  expect(begin.body.mode).toBe('parts');
  const partMax = begin.body.part_max_bytes as number;
  for (let i = 0; i * partMax < bytes.length; i++) {
    const part = await call('file_upload_part', { upload_id: begin.body.upload_id, part: i + 1, data_base64: bytes.subarray(i * partMax, (i + 1) * partMax).toString('base64') });
    expect(part.isError).toBe(false);
  }
  return { begin: begin.body, commit: await call('file_upload_commit', { upload_id: begin.body.upload_id }) };
}

/** Upload ids that still hold staged objects (the local backend leaves empty directories behind; a bucket has none). */
const stagingLeft = () => existsSync(join(storageDir, '_incoming'))
  ? readdirSync(join(storageDir, '_incoming')).filter(id => readdirSync(join(storageDir, '_incoming', id), { recursive: true }).some(f => /manifest\.json$|data$|part-\d+$/.test(String(f))))
  : [];

describe('operation surface', () => {
  test('byte-based ops are remote-callable admin ops; path-based file_upload stays localOnly', () => {
    for (const name of ['file_upload_begin', 'file_upload_part', 'file_upload_commit', 'file_upload_abort', 'file_get', 'file_list', 'file_url']) {
      expect(operationsByName[name].localOnly).toBeUndefined();
      expect(operationsByName[name].scope).toBe('admin');
    }
    expect(operationsByName.file_upload.localOnly).toBe(true);
  });

  test('sniffMime reads the real type, not the name', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('plain text'))).toBeNull();
  });
});

describe('inline parts mode (backend without signed URLs)', () => {
  test('an image attached to a page round-trips: stored, listed, returned as an image block; staging is gone', async () => {
    const { commit } = await uploadInParts(PNG, { filename: 'whiteboard.png', page_slug: 'meetings/2026-01-15' });
    expect(commit.isError).toBe(false);
    expect(commit.body).toMatchObject({ status: 'uploaded', storage_path: 'meetings/2026-01-15/whiteboard.png', size_bytes: PNG.length, mime_type: 'image/png' });
    expect(readFileSync(join(storageDir, 'meetings/2026-01-15/whiteboard.png')).equals(PNG)).toBe(true);
    expect(stagingLeft()).toEqual([]);

    const list = await call('file_list', { slug: 'meetings/2026-01-15' });
    expect(list.isError).toBe(false);
    expect(list.body).toEqual([expect.objectContaining({ storage_path: 'meetings/2026-01-15/whiteboard.png', content_hash: sha(PNG), size_bytes: PNG.length })]);

    const got = await call('file_get', { storage_path: 'meetings/2026-01-15/whiteboard.png' });
    expect(got.isError).toBe(false);
    expect(got.body).toMatchObject({ mime_type: 'image/png', size_bytes: PNG.length, sha256: sha(PNG) });
    expect(got.body.data_base64).toBeUndefined(); // the bytes never ride in the JSON text
    const image = (got.result.content as unknown as Array<{ type: string; data?: string; mimeType?: string }>).find(c => c.type === 'image');
    expect(image).toEqual({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
    expect(got.result.content[0].type).toBe('text');
  });

  test('a multi-part file without a page lands in unsorted/ and comes back as data_base64', async () => {
    const bytes = Buffer.alloc(150_000, 7);
    const begin = await call('file_upload_begin', { filename: 'notes.bin', size_bytes: bytes.length, sha256: sha(bytes) });
    // Parts may be any size up to part_max_bytes; commit stitches them in part order.
    for (let n = 1, off = 0; off < bytes.length; n++, off += 40_000) {
      const r = await call('file_upload_part', { upload_id: begin.body.upload_id, part: n, data_base64: bytes.subarray(off, off + 40_000).toString('base64') });
      expect(r.isError ? JSON.stringify(r.body) : 'ok').toBe('ok');
    }
    const commit = await call('file_upload_commit', { upload_id: begin.body.upload_id });
    expect(commit.isError).toBe(false);
    expect(commit.body.storage_path).toBe(`unsorted/${sha(bytes).slice(0, 8)}-notes.bin`);
    const got = await call('file_get', { storage_path: commit.body.storage_path });
    expect(Buffer.from(got.body.data_base64, 'base64').equals(bytes)).toBe(true);
  });

  test('bytes that differ from the declared SHA-256 are refused and nothing is stored', async () => {
    const bytes = Buffer.from('synthetic payload');
    const begin = await call('file_upload_begin', { filename: 'tampered.txt', page_slug: 'meetings/2026-01-15', size_bytes: bytes.length, sha256: sha(Buffer.from('something else')) });
    await call('file_upload_part', { upload_id: begin.body.upload_id, part: 1, data_base64: bytes.toString('base64') });
    const commit = await call('file_upload_commit', { upload_id: begin.body.upload_id });
    expect(commit.isError).toBe(true);
    expect(commit.body.message).toContain('SHA-256');
    expect(existsSync(join(storageDir, 'meetings/2026-01-15/tampered.txt'))).toBe(false);
    expect((await engine.executeRaw(`SELECT 1 FROM files WHERE storage_path = 'meetings/2026-01-15/tampered.txt'`)).length).toBe(0);
    await call('file_upload_abort', { upload_id: begin.body.upload_id });
  });

  test('a missing part is refused', async () => {
    const bytes = Buffer.from('abc');
    const begin = await call('file_upload_begin', { filename: 'empty.txt', size_bytes: bytes.length, sha256: sha(bytes) });
    const commit = await call('file_upload_commit', { upload_id: begin.body.upload_id });
    expect(commit.isError).toBe(true);
    expect(commit.body.message).toContain('parts are missing');
    await call('file_upload_abort', { upload_id: begin.body.upload_id });
  });

  test('abort drops the staged bytes; the upload is then unknown', async () => {
    const bytes = Buffer.from('to be dropped');
    const begin = await call('file_upload_begin', { filename: 'drop.txt', size_bytes: bytes.length, sha256: sha(bytes) });
    await call('file_upload_part', { upload_id: begin.body.upload_id, part: 1, data_base64: bytes.toString('base64') });
    expect(stagingLeft()).toContain(begin.body.upload_id);
    expect((await call('file_upload_abort', { upload_id: begin.body.upload_id })).body.status).toBe('aborted');
    expect(stagingLeft()).not.toContain(begin.body.upload_id);
    const commit = await call('file_upload_commit', { upload_id: begin.body.upload_id });
    expect(commit.isError).toBe(true);
    expect(commit.body.message).toContain('No pending upload');
  });

  test('an upload begun in one source is unknown to a caller in another', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT DO NOTHING`);
    const bytes = Buffer.from('source bound');
    const begin = await call('file_upload_begin', { filename: 'bound.txt', size_bytes: bytes.length, sha256: sha(bytes) });
    const foreign = await call('file_upload_commit', { upload_id: begin.body.upload_id }, 'other-src');
    expect(foreign.isError).toBe(true);
    expect(foreign.body.message).toContain('No pending upload');
    await call('file_upload_abort', { upload_id: begin.body.upload_id });
  });

  test('begin refuses bad input before staging anything', async () => {
    expect((await call('file_upload_begin', { filename: 'x.png', size_bytes: 10, sha256: 'nothex' })).isError).toBe(true);
    expect((await call('file_upload_begin', { filename: 'x.png', size_bytes: 0, sha256: sha(PNG) })).isError).toBe(true);
    expect((await call('file_upload_begin', { filename: '../x.png', size_bytes: 10, sha256: sha(PNG) })).isError).toBe(true);
    expect((await call('file_upload_begin', { filename: 'x.png', size_bytes: 10, sha256: sha(PNG), page_slug: '_incoming/abc' })).isError).toBe(true);
    await withEnv({ GBRAIN_REMOTE_UPLOAD_MAX_BYTES: '100' }, async () => {
      expect((await call('file_upload_begin', { filename: 'big.bin', size_bytes: 101, sha256: sha(PNG) })).isError).toBe(true);
    });
  });

  test('import of a non-image is skipped, the file is still stored', async () => {
    const bytes = Buffer.from('%PDF-1.7\nsynthetic');
    const { commit } = await uploadInParts(bytes, { filename: 'agenda.pdf', page_slug: 'meetings/2026-01-15', import: true });
    expect(commit.isError).toBe(false);
    expect(commit.body).toMatchObject({ status: 'uploaded', mime_type: 'application/pdf', import: { status: 'skipped' } });
  });
});

describe('direct mode (backend that signs upload URLs)', () => {
  /** The test's "bucket": createUploadUrl hands out the key, and the client's PUT is a write into the storage dir. */
  function signingLocalBackend() {
    (LocalStorage.prototype as { createUploadUrl?: unknown }).createUploadUrl = async (path: string, opts?: { mime?: string }) =>
      ({ url: `test-put://${path}`, method: 'PUT' as const, headers: { 'Content-Type': opts?.mime ?? 'application/octet-stream' } });
  }
  const put = (url: string, bytes: Buffer) => {
    const key = url.slice('test-put://'.length);
    mkdirSync(dirname(join(storageDir, key)), { recursive: true });
    writeFileSync(join(storageDir, key), bytes);
  };

  test('begin returns a URL for the staging data key only; commit stores the PUT bytes', async () => {
    signingLocalBackend();
    const bytes = Buffer.from('direct upload body');
    const begin = await call('file_upload_begin', { filename: 'direct.txt', page_slug: 'meetings/2026-01-15', size_bytes: bytes.length, sha256: sha(bytes), mime_type: 'text/plain' });
    expect(begin.isError).toBe(false);
    expect(begin.body).toMatchObject({ mode: 'direct', method: 'PUT', headers: { 'Content-Type': 'text/plain' } });
    expect(begin.body.url).toBe(`test-put://_incoming/${begin.body.upload_id}/data`);
    put(begin.body.url, bytes);
    const commit = await call('file_upload_commit', { upload_id: begin.body.upload_id });
    expect(commit.isError).toBe(false);
    expect(commit.body).toMatchObject({ status: 'uploaded', storage_path: 'meetings/2026-01-15/direct.txt', mime_type: 'text/plain' });
    expect(readFileSync(join(storageDir, 'meetings/2026-01-15/direct.txt')).equals(bytes)).toBe(true);
    expect(stagingLeft()).not.toContain(begin.body.upload_id);
  });

  test('a PUT of other bytes than declared is refused at commit', async () => {
    signingLocalBackend();
    const declared = Buffer.from('declared bytes');
    const begin = await call('file_upload_begin', { filename: 'swap.txt', size_bytes: declared.length, sha256: sha(declared) });
    put(begin.body.url, Buffer.from('a much larger and different body than declared'));
    const commit = await call('file_upload_commit', { upload_id: begin.body.upload_id });
    expect(commit.isError).toBe(true);
    expect(commit.body.message).toContain('declared');
    expect((await engine.executeRaw(`SELECT 1 FROM files WHERE filename = 'swap.txt'`)).length).toBe(0);
  });

  test('commit before the PUT says so and keeps the upload open', async () => {
    signingLocalBackend();
    const bytes = Buffer.from('late body');
    const begin = await call('file_upload_begin', { filename: 'late.txt', size_bytes: bytes.length, sha256: sha(bytes) });
    const early = await call('file_upload_commit', { upload_id: begin.body.upload_id });
    expect(early.isError).toBe(true);
    expect(early.body.message).toContain('no bytes yet');
    put(begin.body.url, bytes);
    expect((await call('file_upload_commit', { upload_id: begin.body.upload_id })).isError).toBe(false);
  });

  test('mode: parts forces inline transfer on a signing backend', async () => {
    signingLocalBackend();
    const bytes = Buffer.from('forced inline');
    const begin = await call('file_upload_begin', { filename: 'inline.txt', size_bytes: bytes.length, sha256: sha(bytes), mode: 'parts' });
    expect(begin.body.mode).toBe('parts');
    await call('file_upload_abort', { upload_id: begin.body.upload_id });
  });
});

describe('file_get and file_url', () => {
  test('file_get refuses a file over the connection result cap and points at file_url', async () => {
    const bytes = Buffer.alloc(300 * 1024, 1);
    const { commit } = await uploadInParts(bytes, { filename: 'large.bin' });
    expect(commit.isError).toBe(false);
    const got = await call('file_get', { storage_path: commit.body.storage_path });
    expect(got.isError).toBe(true);
    expect(got.body.error === 'result_too_large' || got.body.code === 'result_too_large').toBe(true);
    expect(JSON.stringify(got.body)).toContain('file_url');
    const url = await call('file_url', { storage_path: commit.body.storage_path });
    expect(url.isError).toBe(false);
    expect(typeof url.body.url).toBe('string');
  });

  test('file_get of an unknown path is a storage_error', async () => {
    const got = await call('file_get', { storage_path: 'nowhere/missing.png' });
    expect(got.isError).toBe(true);
  });
});

describe('S3 backend signs a PUT', () => {
  test('createUploadUrl is a SigV4 presigned PUT with Content-Type signed', async () => {
    const s3 = new S3Storage({ backend: 's3', bucket: 'synthetic-bucket', region: 'auto', endpoint: 'https://storage.example.test',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' });
    const signed = await s3.createUploadUrl('_incoming/abc/data', { mime: 'image/png', expiresIn: 600 });
    const url = new URL(signed.url);
    expect(signed.method).toBe('PUT');
    expect(signed.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(url.origin).toBe('https://storage.example.test');
    expect(url.pathname).toBe('/synthetic-bucket/_incoming/abc/data');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // No checksum of the (empty, at signing time) body is signed in: a plain PUT of the real bytes must verify.
    expect([...url.searchParams.keys()].filter(k => /checksum/i.test(k))).toEqual([]);
  });
});
