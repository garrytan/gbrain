import { isImageFilePath } from '../import-file.ts';
import { isCodeFilePath } from '../sync.ts';
import { OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';

// Keep the existing sync admission bound; base64 expansion remains bounded too.
export const MAX_SYNC_BYTES = 10 * 1024 ** 2;
export type SyncContentEncoding = 'utf8' | 'base64';
export function syncText(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new OperationError('invalid_params', 'Sync text must be valid UTF-8.');
  return text;
}
export function freezeSyncContent(path: string, bytes: Buffer): { content: string; contentEncoding: SyncContentEncoding; contentHash: string } {
  if (bytes.length > MAX_SYNC_BYTES) throw new OperationError('request_too_large', 'Sync file exceeds the bounded import size.');
  const image = isImageFilePath(path);
  if (!image && !/\.mdx?$/i.test(path) && !isCodeFilePath(path)) throw new OperationError('invalid_params', 'Unsupported managed sync file type.');
  return { content: image ? bytes.toString('base64') : syncText(bytes), contentEncoding: image ? 'base64' : 'utf8', contentHash: sha256(bytes) };
}
/** Old text intents remain readable. Binary intents always require an explicit codec and digest. */
export function thawSyncContent(path: string, content: unknown, encoding: unknown, hash: unknown): Buffer {
  if (typeof content !== 'string') throw new OperationError('storage_error', 'The frozen import content is missing.');
  const image = isImageFilePath(path);
  if (!image && !/\.mdx?$/i.test(path) && !isCodeFilePath(path)) throw new OperationError('invalid_params', 'Unsupported managed sync file type.');
  if (image ? encoding !== 'base64' : encoding !== undefined && encoding !== 'utf8') {
    throw new OperationError('invalid_params', 'The frozen sync content encoding does not match its file type.');
  }
  if (content.length > MAX_SYNC_BYTES * 4 / 3 + 4) throw new OperationError('request_too_large', 'Frozen sync content exceeds the bounded import size.');
  const bytes = Buffer.from(content, image ? 'base64' : 'utf8');
  if (bytes.length > MAX_SYNC_BYTES || (image ? bytes.toString('base64') !== content : syncText(bytes) !== content)) {
    throw new OperationError('invalid_params', 'The frozen sync content is not canonically encoded.');
  }
  if ((image || hash !== undefined) && (typeof hash !== 'string' || sha256(bytes) !== hash)) {
    throw new OperationError('source_changed', 'The frozen sync content digest does not match its bytes.');
  }
  return bytes;
}
