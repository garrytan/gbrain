/**
 * cross-modal-eval/receipt-write — auto-mkdir receipt writer.
 *
 * `gbrainPath()` from `src/core/config.ts` does NOT auto-mkdir (Codex T5
 * correction). Every receipt write needs an explicit `mkdirSync({recursive})`
 * ahead of the write so first-run users don't get `ENOENT: no such file or
 * directory` from a fresh `~/.gbrain/`.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export function writeReceipt(path: string, content: string | object): void {
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}
