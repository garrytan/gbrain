/**
 * atomic-write.ts — the ONE atomic config-file writer for bootstrap host
 * surfaces (rule-of-three extraction: hooks.ts settings JSON, codex-toml.ts
 * TOML text, opencode-json.ts JSONC text all swap through here).
 *
 * Semantics, hardened for shared user-scope targets [C10 / X11]:
 * - The SYMLINK TARGET is resolved first so a dotfile-manager-linked config
 *   survives as a link (a bare rename would replace the link with a regular
 *   file). DANGLING links are resolved too (readlink, hop by hop): the write
 *   creates the missing target and the link survives.
 * - tmp file uses a random suffix and inherits the EXISTING file's mode; a
 *   fresh file takes `freshMode` (caller's convention — secret-bearing
 *   targets pass 0o600). `forceMode` overrides both (codex-toml forces 0600
 *   because the file carries a bearer token regardless of its prior mode).
 * - chmod after write because writeFileSync's mode applies only on create.
 *
 * EOL and serialization stay caller-side: hooks.ts stringifies JSON,
 * codex-toml converts to CRLF when the original was CRLF, opencode-json
 * preserves EOLs naturally via jsonc-parser text splicing.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Resolve the write target through symlinks, INCLUDING dangling ones.
 * existsSync follows symlinks, so a DANGLING link reads "absent" and a bare
 * rename would replace the link itself with a regular file — instead the
 * link text is resolved hop by hop (relative to each link's dir, bounded
 * against loops) and the write lands at the final target, preserving the
 * link the same way the live-symlink realpath branch does. */
function resolveWriteTarget(path: string): string {
  if (existsSync(path)) {
    // TOCTOU guard: the file can vanish between existsSync and realpathSync
    // (a concurrent unlink), which would throw a raw ENOENT out of a writer
    // that is perfectly able to proceed — fall through and treat the path as
    // fresh/dangling instead.
    try {
      return realpathSync(path); // live file / live symlink chain
    } catch {
      /* raced away — resolve below */
    }
  }
  let target = path;
  for (let hops = 0; hops < 40; hops++) {
    let st;
    try {
      st = lstatSync(target);
    } catch {
      return target; // truly absent — fresh-file target
    }
    if (!st.isSymbolicLink()) return target;
    const linkText = readlinkSync(target);
    target = isAbsolute(linkText) ? linkText : resolve(dirname(target), linkText);
  }
  return target; // pathological loop — bounded, last hop wins
}

export function atomicWriteTextFile(
  path: string,
  text: string,
  opts?: { freshMode?: number; forceMode?: number },
): void {
  const target = resolveWriteTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  let mode: number | undefined;
  if (opts?.forceMode !== undefined) {
    mode = opts.forceMode;
  } else {
    try {
      mode = statSync(target).mode & 0o777;
    } catch {
      mode = opts?.freshMode;
    }
  }
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  // Failure hygiene: a throwing write/chmod/rename (ENOSPC, EACCES, target
  // turned into a directory, …) must not leak the tmp file next to the
  // user's config — unlink it best-effort and rethrow the original error.
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort — the original error is the one that matters */
    }
    throw e;
  }
}
