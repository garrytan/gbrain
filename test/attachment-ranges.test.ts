import { expect, test } from 'bun:test';
import { S3Storage } from '../src/core/storage/s3.ts';
import { SupabaseStorage } from '../src/core/storage/supabase.ts';
import { chunkManifest, verifiedSlice } from '../src/core/attachments/integrity.ts';
import { CHUNK_BYTES, sha256 } from '../src/core/attachments/context.ts';
import type { StorageBackend } from '../src/core/storage.ts';

function fixture(size = 2 * CHUNK_BYTES + 17) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i + Math.floor(i / CHUNK_BYTES)) % 251;
  const row = { storage_path: 'attachments/synthetic', storage: 'local', content_hash: sha256(bytes), size_bytes: size };
  const manifest = chunkManifest(bytes, row.storage_path, row.storage);
  const ranges: number[][] = [];
  let full = 0;
  const storage: StorageBackend = { upload: async () => {}, delete: async () => {}, exists: async () => true, list: async () => [], getUrl: async () => 'synthetic', download: async () => { full++; return bytes; },
    downloadRange: async (_path: string, offset: number, length: number) => {
      ranges.push([offset, length]); return bytes.subarray(offset, offset + length);
    } };
  return { bytes, row, manifest, storage, ranges, full: () => full };
}
test('aligned 64 MiB download reads exactly one file worth of backend bytes', async () => {
  const f = fixture(64 * 1024 * 1024);
  for (let offset = 0; offset < f.bytes.length; offset += CHUNK_BYTES) {
    expect(await verifiedSlice(f.storage, f.row, f.manifest, offset)).toEqual(f.bytes.subarray(offset, offset + CHUNK_BYTES));
  }
  expect(f.ranges.reduce((sum, [, length]) => sum + length, 0)).toBe(f.bytes.length);
  expect(f.ranges).toHaveLength(256);
  expect(f.full()).toBe(0);
});
test('unaligned offsets verify at most two chunks; EOF and empty objects return no bytes', async () => {
  const f = fixture();
  expect(await verifiedSlice(f.storage, f.row, f.manifest, 1)).toEqual(f.bytes.subarray(1, CHUNK_BYTES + 1));
  expect(f.ranges).toEqual([[0, CHUNK_BYTES * 2]]);
  for (const offset of [CHUNK_BYTES - 1, CHUNK_BYTES + 1, f.bytes.length - 1]) {
    expect(await verifiedSlice(f.storage, f.row, f.manifest, offset)).toEqual(f.bytes.subarray(offset, offset + CHUNK_BYTES));
  }
  expect(await verifiedSlice(f.storage, f.row, f.manifest, 2 * CHUNK_BYTES)).toEqual(f.bytes.subarray(2 * CHUNK_BYTES));
  expect((await verifiedSlice(f.storage, f.row, f.manifest, f.bytes.length)).length).toBe(0);
  const empty = fixture(0);
  expect((await verifiedSlice(empty.storage, empty.row, empty.manifest, 0)).length).toBe(0);
});
test('requested corruption fails; partial reads do not claim to verify unrequested chunks', async () => {
  const f = fixture(); f.bytes[CHUNK_BYTES] ^= 0xff;
  expect((await verifiedSlice(f.storage, f.row, f.manifest, 0)).length).toBe(CHUNK_BYTES);
  await expect(verifiedSlice(f.storage, f.row, f.manifest, CHUNK_BYTES)).rejects.toMatchObject({ code: 'checksum_mismatch' });
  expect(f.full()).toBe(0);
});
test('absent, malformed or stale manifests use full verification without mutating metadata', async () => {
  const f = fixture();
  for (const manifest of [null, {}, { ...f.manifest, version: 2 }, { ...f.manifest, hashes: [] },
    { ...f.manifest, hashes: ['x', ...f.manifest.hashes.slice(1)] }, { ...f.manifest, storage_path: 'old' },
    { ...f.manifest, storage: 's3' }, { ...f.manifest, size_bytes: 3 }, { ...f.manifest, sha256: '0'.repeat(64) }]) {
    expect(await verifiedSlice(f.storage, f.row, manifest, 0)).toEqual(f.bytes.subarray(0, CHUNK_BYTES));
  }
  expect(f.full()).toBe(9); expect(f.ranges).toHaveLength(0);
  // Legacy writers can replace bytes and preserve old metadata at the same path/size.
  f.bytes[0] ^= 0xff; f.row.content_hash = sha256(f.bytes);
  expect(await verifiedSlice(f.storage, f.row, f.manifest, 0)).toEqual(f.bytes.subarray(0, CHUNK_BYTES));
  f.bytes[0] ^= 0xff;
  await expect(verifiedSlice(f.storage, f.row, null, 0)).rejects.toMatchObject({ code: 'checksum_mismatch' });
});

for (const kind of ['s3', 'supabase'] as const) {
  function backend(status = 206, contentRange = 'bytes 2-4/8', chunks = [new Uint8Array([2, 3, 4])]) {
    const requests: any[] = []; let cancelled = false;
    const stream = () => new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
      pull(controller) { controller.close(); }, cancel() { cancelled = true; },
    });
    const store = kind === 's3'
      ? new S3Storage({ backend: 's3', bucket: 'test' }, { send: async (command: any) => {
        requests.push(command.input);
        if (!command.input.Range) return { ContentLength: 8 };
        return { $metadata: { httpStatusCode: status }, ContentRange: contentRange, ContentLength: 3, Body: { transformToWebStream: stream } };
      } } as any)
      : new SupabaseStorage({ backend: 'supabase', bucket: 'test', projectUrl: 'https://storage.example.test', serviceRoleKey: 'synthetic' }, async (_url, init) => {
        requests.push(init);
        if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': '8' } });
        return new Response(stream(), { status, headers: { 'content-range': contentRange } });
      });
    return { store, requests, cancelled: () => cancelled };
  }
  test(`${kind} sends precise range and supports metadata-only EOF`, async () => {
    const f = backend();
    expect(await f.store.downloadRange('key', 2, 3, 8)).toEqual(Buffer.from([2, 3, 4]));
    expect(kind === 's3' ? f.requests[0].Range : f.requests[0].headers.Range).toBe('bytes=2-4');
    expect(await f.store.downloadRange('key', 8, 0, 8)).toEqual(Buffer.alloc(0));
    await expect(f.store.downloadRange('key', 8, 1, 8)).rejects.toThrow('Invalid storage range');
    expect(f.requests).toHaveLength(2);
  });
  test(`${kind} rejects ignored ranges, mismatched totals, truncated and oversized bodies`, async () => {
    for (const f of [backend(200), backend(206, 'bytes 2-4/9'), backend(206, 'bytes 0-2/8')]) {
      await expect(f.store.downloadRange('key', 2, 3, 8)).rejects.toThrow();
      expect(f.cancelled()).toBe(true);
    }
    await expect(backend(206, 'bytes 2-4/8', [new Uint8Array(2)]).store.downloadRange('key', 2, 3, 8)).rejects.toThrow('Truncated');
    const overflow = backend(206, 'bytes 2-4/8', [new Uint8Array(4), new Uint8Array(100)]);
    await expect(overflow.store.downloadRange('key', 2, 3, 8)).rejects.toThrow('exceeded');
    expect(overflow.cancelled()).toBe(true);
  });
}


test('bounded stream accepts fragmented and empty chunks and propagates stream errors', async () => {
  const { boundedBody } = await import('../src/core/storage/range.ts');
  const stream = new ReadableStream<Uint8Array>({ start(c) {
    for (let i = 0; i < 1000; i++) { c.enqueue(new Uint8Array(0)); c.enqueue(new Uint8Array([i % 251])); }
    c.close();
  } });
  expect(await boundedBody(stream, 1000)).toEqual(Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)));
  await expect(boundedBody(new ReadableStream({ start(c) { c.error(new Error('synthetic stream failure')); } }), 3)).rejects.toThrow('synthetic stream failure');
});

test('local ranges enforce expected size, file type and canonical path containment', async () => {
  const { LocalStorage } = await import('../src/core/storage/local.ts');
  const { mkdtempSync, rmSync, writeFileSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'gbrain-range-'));
  try {
    const storage = new LocalStorage(join(root, 'store'));
    await storage.upload('file', Buffer.from('01234567'));
    expect(await storage.downloadRange('file', 2, 3, 8)).toEqual(Buffer.from('234'));
    await expect(storage.downloadRange('file', 0, 3, 9)).rejects.toThrow('size changed');
    await expect(storage.downloadRange('missing', 0, 0, 0)).rejects.toThrow();
    await expect(storage.downloadRange('.', 0, 0, 0)).rejects.toThrow();
    writeFileSync(join(root, 'outside'), 'private');
    symlinkSync(join(root, 'outside'), join(root, 'store', 'escape'));
    await expect(storage.downloadRange('escape', 0, 7, 7)).rejects.toThrow('traversal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
