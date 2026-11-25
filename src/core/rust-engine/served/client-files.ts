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
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { BrainEngine } from '../../engine.ts';
import { ownerIpcRefusal } from '../owner-ipc/routes.ts';

export const IMPORT_CLIENT_FILE = 'importClientFile';
export type ClientFileImport = 'importFromFile' | 'importImageFile';

/** What a client sends for one file: its bytes, or that the path is a symlink (never followed). */
export type ClientFilePayload = { symlink: true } | { symlink: false; bytes: Buffer };

/** Read on the client, before anything is sent. */
export function readClientFile(filePath: string): ClientFilePayload {
  if (lstatSync(filePath).isSymbolicLink()) return { symlink: true };
  return { symlink: false, bytes: readFileSync(filePath) };
}

/** A relative path with no `..`, no root and no empty segment; anything else refuses. */
function safeRelative(relativePath: string): string {
  const norm = normalize(relativePath);
  if (!relativePath || isAbsolute(relativePath) || norm.startsWith('..') || norm.split(sep).some(part => part === '..' || part === '')) {
    throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'its relative path leaves the import root');
  }
  return norm;
}

/** The server side: run `name` on a private copy of the client's bytes. */
export async function importClientFile(engine: BrainEngine, name: unknown, clientPath: unknown, relativePath: unknown, payload: unknown,
  opts: unknown): Promise<unknown> {
  if (name !== 'importFromFile' && name !== 'importImageFile') throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'it names no client file import');
  if (typeof clientPath !== 'string' || typeof relativePath !== 'string') throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'its paths are not text');
  const p = payload as ClientFilePayload | null;
  if (!p || typeof p !== 'object') throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'it carries no file');
  const { importFromFile, importImageFile } = await import('../../import-file.ts');
  if (p.symlink === true) {
    // The in-process skip, naming the client's own path (import-file.ts, the symlink defence of each entry point).
    const { slugifyPath } = await import('../../sync.ts');
    return { slug: name === 'importFromFile' ? relativePath : slugifyPath(relativePath), status: 'skipped', chunks: 0, error: `Skipping symlink: ${clientPath}` };
  }
  if (!((p.bytes as unknown) instanceof Uint8Array)) throw ownerIpcRefusal(IMPORT_CLIENT_FILE, 'its file bytes are missing');
  const rel = safeRelative(relativePath);
  const root = mkdtempSync(join(tmpdir(), 'gbrain-served-import-'));
  try {
    const copy = join(root, rel);
    mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
    writeFileSync(copy, p.bytes, { mode: 0o600 });
    const options = (opts && typeof opts === 'object' ? opts : {}) as Parameters<typeof importFromFile>[3];
    return name === 'importFromFile'
      ? await importFromFile(engine, copy, relativePath, options)
      : await importImageFile(engine, copy, relativePath, options as Parameters<typeof importImageFile>[3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
