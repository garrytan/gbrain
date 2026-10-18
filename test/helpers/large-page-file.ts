/**
 * Large page files for the Wave B delete/restore tests: a file of about `bytes` body bytes in gbrain's
 * serialization (`type` before `title`, as serializePageToMarkdown writes them), so a restore writes it back
 * byte for byte, written in 8 MiB pieces so a test never holds it whole; and a streamed SHA-256 of a file.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { conversationBody } from './conversation-page.ts';

const MiB = 1024 * 1024;

export function writeCanonicalPage(path: string, bytes: number, seed: number): { sha: string; size: number } {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '---\ntype: note\ntitle: Large conversation\n---\n\n');
  for (let written = 0, part = 0; written < bytes; part++) {
    const piece = `${part ? '\n\n' : ''}${conversationBody(Math.min(8 * MiB, bytes - written), { seed: seed + part })}`;
    appendFileSync(path, piece);
    written += Buffer.byteLength(piece);
  }
  appendFileSync(path, '\n');
  return { sha: fileSha(path), size: statSync(path).size };
}

export function fileSha(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(4 * MiB);
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}
