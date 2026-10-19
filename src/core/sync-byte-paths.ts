/**
 * Byte-exact Git paths for classic sync (GBRA-133). Git stores a file name as
 * bytes; a page path is text. A name that is not valid UTF-8 (a Latin-1 name
 * from an old archive) or that holds a control character (a tab, a newline)
 * cannot be a page path, so classic sync holds it `unsupported_path` instead of
 * handing the importer a lossy string. This module is the one place that
 * turns those raw bytes into something stored, shown or typed:
 *
 *  - the hold key, `/gbrain-bytes/` + the path with every byte that is not part
 *    of a printable UTF-8 character (and every `%`) written `%XX` (upper-case
 *    hex). It decodes back to the exact bytes, and it never equals a Git path:
 *    Git never emits a path that starts with `/`.
 *  - the display path, C-escaped like Git's quoting (`notes/caf\351.md`).
 *  - the item id, the first 16 hex digits of the bytes' sha256: an opaque
 *    selector bound to the bytes, safe on any command line.
 *  - the rename command in the fix, which spells the old name with printf
 *    escapes and hands it to `git mv` through a pipe, never as raw argv text.
 */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type { Action } from './agent-output.ts';
import type { GitHoldRecord } from './persistence/sync-holds.ts';

export type UnsupportedPathReason = 'not_utf8' | 'control_character';

export const BYTE_PATH_KEY_PREFIX = '/gbrain-bytes/';

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
const C_ESCAPES: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };

/** A Git path as sync can use it: the decoded name, or why it cannot be one. */
export function classifyGitPathBytes(raw: Uint8Array): { path: string } | { reason: UnsupportedPathReason } {
  let path: string;
  try { path = STRICT_UTF8.decode(raw); } catch { return { reason: 'not_utf8' }; }
  return CONTROL.test(path) ? { reason: 'control_character' } : { path };
}

/** Splits bytes into printable UTF-8 characters (strings) and single bytes that are not (numbers). */
function segments(raw: Uint8Array): Array<string | number> {
  const out: Array<string | number> = [];
  for (let i = 0; i < raw.length;) {
    const lead = raw[i]!;
    const size = lead < 0x80 ? 1 : lead >= 0xc2 && lead < 0xe0 ? 2 : lead >= 0xe0 && lead < 0xf0 ? 3 : lead >= 0xf0 && lead < 0xf5 ? 4 : 0;
    let char: string | null = null;
    if (size && i + size <= raw.length) {
      try { char = STRICT_UTF8.decode(raw.subarray(i, i + size)); } catch { char = null; }
    }
    if (char === null || CONTROL.test(char)) { out.push(lead); i += 1; continue; }
    out.push(char);
    i += size;
  }
  return out;
}

const hex = (byte: number) => '%' + byte.toString(16).toUpperCase().padStart(2, '0');

/** The hold key of a path's exact bytes (see the module comment). */
export function encodeBytePathKey(raw: Uint8Array): string {
  return BYTE_PATH_KEY_PREFIX + segments(raw).map(part => typeof part === 'number' ? hex(part) : part === '%' ? hex(0x25) : part).join('');
}

/** The exact bytes a hold key names, or null when `key` is not a canonical byte-path key (an ordinary path among them). */
export function decodeBytePathKey(key: string): Buffer | null {
  if (!key.startsWith(BYTE_PATH_KEY_PREFIX)) return null;
  const body = key.slice(BYTE_PATH_KEY_PREFIX.length);
  const bytes: number[] = [];
  for (let i = 0; i < body.length;) {
    if (body[i] === '%') {
      if (!/^[0-9A-F]{2}$/.test(body.slice(i + 1, i + 3))) return null;
      bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    const char = String.fromCodePoint(body.codePointAt(i)!);
    bytes.push(...Buffer.from(char, 'utf8'));
    i += char.length;
  }
  const raw = Buffer.from(bytes);
  return encodeBytePathKey(raw) === key ? raw : null;
}

/** The path for a terminal or a message: C escapes for control characters and bytes that are not UTF-8, capped at 200 characters. */
export function displayBytePath(raw: Uint8Array): string {
  const shown = segments(raw).map(part => typeof part === 'string' ? (part === '\\' ? '\\\\' : part)
    : C_ESCAPES[part] ?? '\\' + part.toString(8).padStart(3, '0')).join('');
  return shown.length > 200 ? shown.slice(0, 197) + '...' : shown;
}

/** An opaque selector bound to the path's bytes: the first 16 hex digits of their sha256. */
export function bytePathItemId(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** A suggested replacement name: each control character or byte that is not UTF-8 becomes `_`. */
export function suggestedBytePathName(raw: Uint8Array): string {
  return segments(raw).map(part => typeof part === 'number' ? '_' : part).join('');
}

/**
 * The shell command that renames the file, run from the directory the path is relative to. printf writes the old name
 * (octal escapes for every byte outside printable ASCII and for `\ ' %`) followed by NUL, and xargs -0 hands it to git mv,
 * so the command text is plain ASCII and a name ending in a newline survives.
 */
export function bytePathRenameCommand(raw: Uint8Array, newName: string): string {
  const format = [...raw].map(byte => byte >= 0x20 && byte < 0x7f && !'\\\'%'.includes(String.fromCharCode(byte))
    ? String.fromCharCode(byte) : '\\' + byte.toString(8).padStart(3, '0')).join('') + '\\000';
  return `printf '${format}' | xargs -0 -I{} git mv -- {} '${newName.replaceAll("'", "'\\''")}'`;
}

/** Whether a byte-path hold's file is gone from `root` (null: `key` is an ordinary path, not a byte-path key). */
export function bytePathHoldGone(root: string, key: string): boolean | null {
  const raw = decodeBytePathKey(key);
  if (!raw) return null;
  return !lstatSync(Buffer.concat([Buffer.from(root.endsWith('/') ? root : root + '/'), raw]), { throwIfNoEntry: false });
}

/** The fix for an `unsupported_path` hold: the user renames the file (its argv is a read-only status; the name is never in it). */
export function unsupportedPathHoldFix(record: Pick<GitHoldRecord, 'source_id' | 'path' | 'meta'>): Action {
  const source = record.source_id;
  const raw = decodeBytePathKey(record.path);
  const reason = record.meta.reason === 'control_character' ? 'control_character' : 'not_utf8';
  const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
  const what = reason === 'control_character' ? 'has a control character in its name (a tab, a newline or another byte below 0x20)' : 'has a name that is not valid UTF-8';
  const rename = raw
    ? `The file ${displayBytePath(raw)} (item ${bytePathItemId(raw)}) ${what}, so sync cannot use it as a page path and held it; the rest of source ${source} keeps syncing. `
      + `Rename it to a valid UTF-8 name without control characters, from the directory the path is relative to (the source's checkout), for example: `
      + `${bytePathRenameCommand(raw, suggestedBytePathName(raw))} (the old name is spelled with printf escapes). `
    : `A file in source ${source} ${what}, so sync held it; gbrain sources status ${source} --json names it. Rename it to a valid UTF-8 name without control characters. `;
  return { argv: verify.argv, consent: [], actor: 'user', requires_exclusive: false, docs: reason === 'control_character' ? 'docs/guides/write-refusals.md#unsupported_path-control_character' : 'docs/guides/write-refusals.md#unsupported_path-not_utf8',
    user_message: rename + `Then commit the rename and run gbrain sync --source ${source} --no-pull, which imports the file under its new name and clears the hold.`,
    why: 'A page path is text and this name is bytes no text names exactly, so importing it would store a different path than the file has. Renaming the file changes the repository, so the user decides; '
      + 'the hold re-screens on every sync and clears once the old name leaves the tree.',
    then: { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: 'Imports the renamed file and clears the hold once the rename is committed; a file that still has the old name stays held without blocking the rest.' },
    verify };
}
