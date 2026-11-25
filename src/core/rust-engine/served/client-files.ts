/**
 * File imports from a network client of a brain server (decision 9 of the L3 plan; review finding F6). A client's
 * file paths are not the server's, so the server never reads a path a network client names. The client reads the
 * file itself and sends its bytes with the operation (`importClientFile`); the server writes them under a private
 * directory of its own, at the same relative path, runs the same import entry point on that copy, and removes it.
 *
 * What stays the same as an import in process: the result, the size and symlink skips (the symlink check runs on the
 * client, where the link is, and names the client's path as the in-process import does). What differs: the import's
 * source root is the server's private copy, so it reads nothing else from the client's directory.
 */
import { closeSync, lstatSync, constants as fsConstants, fstatSync, mkdtempSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { importSizeLimit } from '../../import-screen.ts';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { relativeEscapesRoot } from '../../path-confine.ts';
import type { BrainEngine } from '../../engine.ts';
import { ownerIpcRefusal } from '../owner-ipc/routes.ts';

export const IMPORT_CLIENT_FILE = 'importClientFile';
export type ClientFileImport = 'importFromFile' | 'importImageFile';

/**
 * What a client sends for one file: its bytes, that the path is a symlink (never followed), or that the file is over
 * the import's size limit (its bytes are not read or sent; the server answers the importer's own size skip).
 */
export type ClientFilePayload = { symlink: true } | { symlink: false; bytes: Buffer } | { symlink: false; oversized: number };

/** import-file.ts MAX_IMAGE_BYTES, kept equal by test/rust-served-review.test.ts (a static import would close a module cycle). */
export const CLIENT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** The size limit of one import, the one the in-process importer applies (import-screen.ts, import-file.ts). */
export function clientFileLimit(name: ClientFileImport, relativePath: string): number {
  return name === 'importImageFile' ? CLIENT_IMAGE_MAX_BYTES : importSizeLimit(relativePath);
}

/**
 * Read on the client, before anything is sent (review G12): the path is opened once without following a final
 * symlink, must be a regular file (a FIFO or a device refuses without blocking), and is read only up to the limit.
 */
export function readClientFile(filePath: string, relativePath = filePath, name: ClientFileImport = 'importFromFile'): ClientFilePayload {
  if (lstatSync(filePath).isSymbolicLink()) return { symlink: true };
  const fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'the path is not a regular file');
    const limit = clientFileLimit(name, relativePath);
    if (stat.size > limit) return { symlink: false, oversized: stat.size };
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (n === 0) break; at += n; }
    return { symlink: false, bytes: at === bytes.length ? bytes : bytes.subarray(0, at) };
  } finally { closeSync(fd); }
}

/** A canonical relative path with no `..`, no root and no empty segment; anything else refuses (review G11). */
function safeRelative(relativePath: string): string {
  const norm = normalize(relativePath);
  if (!relativePath || norm === '.' || relativeEscapesRoot(norm) || norm.split(sep).some(part => part === '..' || part === '')) {
    throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'its relative path leaves the import root');
  }
  return norm;
}

/** The data options a network client's import may set; every hook and coordination field stays the server's (review G11). */
const DATA_OPTIONS: Readonly<Record<ClientFileImport, readonly string[]>> = {
  importFromFile: ['noEmbed', 'inferFrontmatter', 'sourceId', 'forceRechunk'],
  importImageFile: ['noEmbed', 'sourceId'],
};

function dataOptions(name: ClientFileImport, opts: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!opts || typeof opts !== 'object') return out;
  for (const key of DATA_OPTIONS[name]) {
    const value = (opts as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'sourceId' ? typeof value !== 'string' : typeof value !== 'boolean') continue;
    out[key] = value;
  }
  return out;
}

type Importer = (engine: BrainEngine, path: string, relativePath: string, opts: Record<string, unknown>) => Promise<unknown>;

/** The server side: run `name` on a private copy of the client's bytes. `deps` replaces the importers in tests. */
export async function importClientFile(engine: BrainEngine, name: unknown, clientPath: unknown, relativePath: unknown, payload: unknown,
  opts: unknown, deps: Partial<Record<ClientFileImport, Importer>> = {}): Promise<unknown> {
  if (name !== 'importFromFile' && name !== 'importImageFile') throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'it names no client file import');
  if (typeof clientPath !== 'string' || typeof relativePath !== 'string') throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'its paths are not text');
  const p = payload as (ClientFilePayload & { bytes?: unknown; oversized?: unknown }) | null;
  if (!p || typeof p !== 'object') throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'it carries no file');
  const { slugifyPath } = await import('../../sync.ts');
  if (p.symlink === true) {
    // The in-process skip, naming the client's own path (import-file.ts, the symlink defence of each entry point).
    return { slug: name === 'importFromFile' ? relativePath : slugifyPath(relativePath), status: 'skipped', chunks: 0, error: `Skipping symlink: ${clientPath}` };
  }
  const rel = safeRelative(relativePath);
  const limit = clientFileLimit(name, rel);
  if (typeof p.oversized === 'number') {
    // The importer's own size skip, as it answers for this file in process (import-file.ts importFromFile, importImageFile).
    return name === 'importFromFile'
      ? { slug: rel, status: 'skipped', chunks: 0, error: `File too large (${p.oversized} bytes)`,
        refusal: { code: 'file_too_large', message: `File too large (${p.oversized} bytes, max ${limit}).` }, skip_reason: 'file_too_large' }
      : { slug: slugifyPath(rel), status: 'skipped', chunks: 0,
        error: `Image too large (${p.oversized} bytes, max ${limit}). Voyage multimodal caps at 20MB per input.` };
  }
  if (!((p.bytes as unknown) instanceof Uint8Array)) throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'its file bytes are missing');
  const bytes = p.bytes as Uint8Array;
  // Checked before anything is written: a client that sent more than the limit gets no temporary copy (review G12).
  if (bytes.byteLength > limit) throw ownerIpcRefusal(IMPORT_CLIENT_FILE, `its file is larger than the import limit of ${limit} bytes`);
  const { importFromFile, importImageFile } = deps.importFromFile && deps.importImageFile ? { importFromFile: deps.importFromFile, importImageFile: deps.importImageFile }
    : { ...(await import('../../import-file.ts') as unknown as Record<ClientFileImport, Importer>), ...deps };
  const root = mkdtempSync(join(tmpdir(), 'gbrain-served-import-'));
  try {
    const copy = join(root, rel);
    mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
    writeFileSync(copy, bytes, { mode: 0o600 });
    const options = dataOptions(name, opts);
    return name === 'importFromFile' ? await importFromFile(engine, copy, rel, options) : await importImageFile(engine, copy, rel, options);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
