import type { StorageBackend } from '../storage.ts';
import { CHUNK_BYTES, fail, MAX_FILE_BYTES, sha256 } from './context.ts';

interface Identity { storage_path: string; storage: string | null; content_hash: string; size_bytes: number | string | null }
interface Manifest {
  version: 1; chunk_bytes: number; size_bytes: number; sha256: string;
  storage_path: string; storage: string; hashes: string[];
}
export function chunkManifest(bytes: Buffer, path: string, storage: string): Manifest {
  const hashes: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) hashes.push(sha256(bytes.subarray(offset, offset + CHUNK_BYTES)));
  return { version: 1, chunk_bytes: CHUNK_BYTES, size_bytes: bytes.length, sha256: sha256(bytes), storage_path: path, storage, hashes };
}
function validManifest(value: unknown, row: Identity): value is Manifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Manifest, size = Number(row.size_bytes);
  return m.version === 1 && m.chunk_bytes === CHUNK_BYTES && m.size_bytes === size &&
    m.sha256 === row.content_hash && m.storage_path === row.storage_path && m.storage === row.storage &&
    /^[a-f0-9]{64}$/.test(m.sha256) && Array.isArray(m.hashes) &&
    m.hashes.length === Math.ceil(size / CHUNK_BYTES) && m.hashes.every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h));
}
/** A range proves only the returned chunks. Consumers must verify the final whole-file digest. */
export async function verifiedSlice(storage: StorageBackend, row: Identity, manifest: unknown, offset: number): Promise<Buffer> {
  const size = Number(row.size_bytes);
  if (row.size_bytes === null || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > size) fail('invalid_params', 'Invalid attachment size or offset.');
  const end = Math.min(size, offset + CHUNK_BYTES);
  if (!storage.downloadRange || !validManifest(manifest, row)) {
    const bytes = await storage.download(row.storage_path);
    if (bytes.length !== size || sha256(bytes) !== row.content_hash) fail('checksum_mismatch', 'Stored attachment does not match its registered checksum.');
    return bytes.subarray(offset, end);
  }
  // At EOF request metadata only, including for an empty file. No invalid HTTP range.
  const start = offset === size ? size : Math.floor(offset / CHUNK_BYTES) * CHUNK_BYTES;
  const stop = Math.min(size, Math.ceil(end / CHUNK_BYTES) * CHUNK_BYTES);
  const bytes = await storage.downloadRange(row.storage_path, start, stop - start, size);
  if (bytes.length !== stop - start) fail('checksum_mismatch', 'Stored attachment range is truncated.');
  for (let at = start; at < stop; at += CHUNK_BYTES) {
    if (sha256(bytes.subarray(at - start, Math.min(at + CHUNK_BYTES, stop) - start)) !== manifest.hashes[at / CHUNK_BYTES]) {
      fail('checksum_mismatch', 'Stored attachment chunk does not match its registered checksum.');
    }
  }
  return bytes.subarray(offset - start, end - start);
}
