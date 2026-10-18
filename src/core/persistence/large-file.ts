/**
 * Wave B: canonical files over the single-string ceiling on the publication path (page-prepare.ts,
 * coordinator.ts, staging.ts). A file over `LARGE_FILE_MIN_BYTES` is never held as one string or Buffer: its
 * digest and the drift check read it in pieces of at most one segment, restore_page streams its new bytes from the
 * page's segments straight into the reserved staging file (`StreamedFileContent`), and a publication that replaces
 * or removes one keeps the prior file as a staged copy referenced by path and SHA-256 in its recovery record
 * (`stageBeforeCopy`, model.ts) instead of embedding its bytes.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { SEGMENT_MAX_BYTES } from '../page-body/limits.ts';
import { atomicStagingPath, validateAtomicStagingPath } from '../atomic-write.ts';
import { flushDirectory } from '../fs-durable.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { assertManagedFilesystemWrite } from './filesystem-guard.ts';
import { sha256 } from './digest.ts';
import type { RecoveryStagingFile } from './staging.ts';
import { faultPoint } from './fault-points.ts';

/** A canonical file of more bytes than this is read, hashed, copied and written in pieces. */
export const LARGE_FILE_MIN_BYTES = PAGE_MAX_BYTES;
const PIECE_BYTES = SEGMENT_MAX_BYTES;

/**
 * @internal Work the large-file path does, for the memory-bound tests: bytes read from canonical or staged files
 * (`bytesRead`), streamed into a staging file (`bytesWritten`) or copied by the kernel into a before stage
 * (`bytesCopied`), produced to measure a streamed file (`bytesMeasured`, also counted in `bytesRead`), and the largest
 * single piece held (`largestPiece`, at most a segment). Counts, not time.
 */
export const largeFileWork = { bytesRead: 0, bytesWritten: 0, bytesCopied: 0, bytesMeasured: 0, largestPiece: 0 };

function counted(bytes: number, field: 'bytesRead' | 'bytesWritten'): void {
  largeFileWork[field] += bytes;
  if (bytes > largeFileWork.largestPiece) largeFileWork.largestPiece = bytes;
}

/** SHA-256 (hex) and length of an open file's bytes, read in pieces from offset 0. */
export function hashDescriptor(fd: number): { hash: string; bytes: number } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(PIECE_BYTES);
  let bytes = 0;
  for (let n: number; (n = readSync(fd, buffer, 0, PIECE_BYTES, bytes)) > 0; bytes += n) {
    counted(n, 'bytesRead');
    hash.update(buffer.subarray(0, n));
  }
  return { hash: hash.digest('hex'), bytes };
}

/** The persistence file hash: SHA-256 of the file's bytes read in pieces, null when no file exists there. */
export function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try { return hashDescriptor(fd).hash; } finally { closeSync(fd); }
}

/**
 * A canonical file's bytes read on demand through one descriptor: `subarray` reads that range (callers ask at most
 * a segment or the frontmatter head), so it stands in for the Buffer a streamed comparison takes views of
 * (body-digests.ts). `close` refuses (`source_changed`) when the file changed while it was read, so a comparison
 * never judges a torn reading.
 */
export class FileBytes {
  private hashed: string | null = null;
  private constructor(private readonly fd: number, readonly length: number, private readonly stamp: string) {}
  static open(path: string): FileBytes {
    const fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    return new FileBytes(fd, stat.size, `${stat.ino}:${stat.size}:${stat.mtimeMs}`);
  }
  subarray(start = 0, end = this.length): Uint8Array {
    const from = Math.max(0, Math.min(start, this.length)), to = Math.max(from, Math.min(end, this.length));
    const buffer = Buffer.allocUnsafe(to - from);
    for (let at = 0, n: number; at < buffer.length; at += n) {
      n = readSync(this.fd, buffer, at, buffer.length - at, from + at);
      if (n <= 0) throw changedWhileRead();
    }
    counted(buffer.length, 'bytesRead');
    return buffer;
  }
  hash(): string { return this.hashed ??= hashDescriptor(this.fd).hash; }
  close(): void {
    try {
      const stat = fstatSync(this.fd);
      if (`${stat.ino}:${stat.size}:${stat.mtimeMs}` !== this.stamp) throw changedWhileRead();
    } finally { closeSync(this.fd); }
  }
}
function changedWhileRead(): OperationError {
  return new OperationError('source_changed', 'The canonical file changed while it was being read.', 'Retry the write with a new request_id; it reads the file again.');
}

/**
 * Bytes of a canonical file produced in pieces (restore_page of a page over the single-string ceiling: export's
 * serializer over the segments), measured once in preparation (length and SHA-256) and produced again into the
 * publication's staging file. Never concatenated.
 */
export class StreamedFileContent {
  private constructor(readonly bytes: number, readonly hash: string, private readonly produce: (engine: BrainEngine) => AsyncIterable<string | Uint8Array>) {}
  static async measure(engine: BrainEngine, produce: (engine: BrainEngine) => AsyncIterable<string | Uint8Array>): Promise<StreamedFileContent> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const piece of pieces(produce(engine))) { counted(piece.length, 'bytesRead'); largeFileWork.bytesMeasured += piece.length; hash.update(piece); bytes += piece.length; }
    return new StreamedFileContent(bytes, hash.digest('hex'), produce);
  }
  pieces(engine: BrainEngine): AsyncIterable<Uint8Array> { return pieces(this.produce(engine)); }
}
async function* pieces(source: AsyncIterable<string | Uint8Array>): AsyncIterable<Uint8Array> {
  for await (const piece of source) yield typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
}
export function isStreamedContent(content: unknown): content is StreamedFileContent { return content instanceof StreamedFileContent; }
/** UTF-8 byte length of a file target's content. */
export function fileContentBytes(content: string | Uint8Array | StreamedFileContent): number {
  return isStreamedContent(content) ? content.bytes : typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
}
export function fileContentHash(content: string | Uint8Array | StreamedFileContent): string {
  return isStreamedContent(content) ? content.hash : sha256(content);
}

const BEFORE_STAGE = '.tmp.before-';
/**
 * The before stage's name: an atomic staging sibling (`.<sha256(target)>.tmp.`) whose UUID is prefixed `before-`.
 * Older binaries accept only `.tmp.<uuid>` stage names, so a record naming one blocks them instead of being misread.
 */
export function beforeStagePath(path: string): string { return atomicStagingPath(path).replace(/\.tmp\.(?=[0-9a-f-]{36}$)/, BEFORE_STAGE); }
/**
 * Where `stageBeforeCopy` writes the copy before renaming it to its before stage, so a copy a crash cut short is never
 * at the stage's name. Recovery removes it unread: the rename is the commit point, so a copy still under this name was
 * never the prior file's only copy (publication starts after the rename).
 */
export function beforeStageCopyPath(stagePath: string): string { return `${stagePath}.copying`; }
export function validateBeforeStagePath(path: string, stagePath: string): void {
  const at = stagePath.lastIndexOf(BEFORE_STAGE);
  if (at < 0) throw new Error('atomic-write: invalid journaled staging path');
  validateAtomicStagingPath(path, `${stagePath.slice(0, at)}.tmp.${stagePath.slice(at + BEFORE_STAGE.length)}`);
}

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0, n: number; at < bytes.length; at += n) {
    n = writeSync(fd, bytes, at, bytes.length - at);
    if (n <= 0) throw opError('storage_error', 'The staging file stopped writing before it was complete.',
      'Check free space on the volume holding the source checkout, then inspect the request\'s receipt before submitting the write again.');
  }
}
function removeOwnStage(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/**
 * Where `stageStreamedContent` streams a stage before renaming it to the stage's name, so a stream a crash cut short is
 * never at the stage's name. Recovery removes it unread (staging.ts): the rename is the commit point, so a file still
 * under this name was never published and its bytes can always be produced again.
 */
export function streamingStagePath(stagePath: string): string { return `${stagePath}.streaming`; }

/**
 * Writes `content` into its reserved staging file one piece at a time: streamed into `streamingStagePath` (created
 * exclusively with `mode`, else 0644 under the umask), checked to hold the measured bytes, fsynced, and only then renamed
 * to the stage's name, so a stage under that name is always whole. Bytes that are not the measured ones (the page
 * changed since preparation) remove the stream and refuse as `revision_conflict`, so the request is prepared again.
 * Seam `large_file:stage_streaming` after each piece is written (a crash mid-stream).
 */
export async function stageStreamedContent(engine: BrainEngine, path: string, content: StreamedFileContent, stage: RecoveryStagingFile, mode: number | null): Promise<void> {
  assertManagedFilesystemWrite(path);
  validateAtomicStagingPath(path, stage.path);
  const streaming = streamingStagePath(stage.path);
  const fd = openSync(streaming, 'wx', mode ?? 0o644);
  let staged = false;
  try {
    try {
      if (mode !== null) fchmodSync(fd, mode);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const piece of content.pieces(engine)) {
        writeAll(fd, piece);
        counted(piece.length, 'bytesWritten');
        hash.update(piece);
        bytes += piece.length;
        await faultPoint('large_file:stage_streaming', { path: streaming });
      }
      if (bytes !== stage.bytes || hash.digest('hex') !== stage.hash) throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Read its current revision and submit the updated intent with a new request_id.');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (existsAt(stage.path)) throw opError('unexpected_staging_bytes', 'A file already holds the reserved stage name.',
      'A recovery staging file changed outside gbrain. Inspect the pending recovery in writer status and tell the user; never delete or edit staging files by hand.');
    renameSync(streaming, stage.path);
    staged = true;
  } finally {
    if (!staged) removeOwnStage(streaming);
  }
  flushDirectory(dirname(stage.path));
}

/**
 * Copies the canonical file at `path` to its reserved before stage: the kernel copies it (no user-space buffer) to
 * `beforeStageCopyPath` (exclusive), its recorded mode is set, it is checked to hold the recorded bytes and fsynced,
 * and only then renamed to the stage's name, so a stage under that name is always a whole copy. False (the copy
 * removed) when the file changed since its digest was recorded; a copy that fails or throws is removed too.
 * `boundary` (crash seams): after the copy is written (`stage_copying`, unverified and unflushed) and once it is
 * flushed (`stage_flushed`, before the rename).
 */
export async function stageBeforeCopy(path: string, stage: RecoveryStagingFile, mode: number | null,
  boundary?: (phase: 'stage_copying' | 'stage_flushed') => Promise<void>): Promise<boolean> {
  assertManagedFilesystemWrite(path);
  validateBeforeStagePath(path, stage.path);
  const copying = beforeStageCopyPath(stage.path);
  let staged = false;
  try {
    copyFileSync(path, copying, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await boundary?.('stage_copying');
    const fd = openSync(copying, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      if (mode !== null) fchmodSync(fd, mode);
      const copy = hashDescriptor(fd);
      largeFileWork.bytesCopied += copy.bytes;
      if (copy.bytes !== stage.bytes || copy.hash !== stage.hash) return false;
      fsyncSync(fd);
    } finally { closeSync(fd); }
    await boundary?.('stage_flushed');
    if (existsAt(stage.path)) throw opError('unexpected_staging_bytes', 'A file already holds the reserved before stage name.',
      'A recovery staging file changed outside gbrain. Inspect the pending recovery in writer status and tell the user; never delete or edit staging files by hand.');
    renameSync(copying, stage.path);
    staged = true;
  } finally {
    if (!staged) removeOwnStage(copying);
  }
  flushDirectory(dirname(stage.path));
  return true;
}
export function existsAt(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
