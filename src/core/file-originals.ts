/**
 * Originals are never overwritten.
 *
 * A file attached to a page is the evidence its facts cite. When a different
 * file arrives under a name that is already taken (same page, same filename,
 * other bytes), the first file stays exactly as it is and the new one is stored
 * beside it under a name that carries its content hash. Uploading the same bytes
 * again is still a no-op. Pure helpers, no I/O: each upload path does its own
 * lookups (the files row, or the file on disk).
 */

/** Hex characters of the content hash put in front of the filename. */
export const ORIGINAL_HASH_CHARS = 12;

/**
 * Where a different file with the same name goes: the same folder, the filename
 * prefixed with the first ORIGINAL_HASH_CHARS of its SHA-256
 * (`people/alice/cv.pdf` -> `people/alice/1a2b3c4d5e6f-cv.pdf`).
 */
export function keptOriginalPath(storagePath: string, hash: string): string {
  const cut = storagePath.lastIndexOf('/');
  const dir = cut >= 0 ? storagePath.slice(0, cut + 1) : '';
  const name = cut >= 0 ? storagePath.slice(cut + 1) : storagePath;
  return `${dir}${hash.slice(0, ORIGINAL_HASH_CHARS)}-${name}`;
}

export type OriginalPlacement =
  | { action: 'write'; path: string; keptOriginal?: string }
  | { action: 'same'; path: string }
  | { action: 'refuse'; path: string; reason: string };

/**
 * Decide where an upload goes, given the content hash already stored at the
 * wanted path and at its kept-original path (undefined: nothing there).
 * - nothing at the wanted path: write there;
 * - the same bytes there: nothing to write;
 * - other bytes there: write beside it, keeping the original (`keptOriginal`);
 *   if the beside-path also holds other bytes (a hash-prefix collision), refuse.
 */
export function placeOriginal(
  wanted: string,
  hash: string,
  hashAtWanted: string | undefined,
  hashAtKept: string | undefined,
): OriginalPlacement {
  // Rows store the hash bare or as `sha256:<hex>`; compare the hex.
  const norm = (h: string | undefined) => (h === undefined ? undefined : h.replace(/^sha256:/, ''));
  hash = norm(hash)!;
  hashAtWanted = norm(hashAtWanted);
  hashAtKept = norm(hashAtKept);
  if (hashAtWanted === undefined) return { action: 'write', path: wanted };
  if (hashAtWanted === hash) return { action: 'same', path: wanted };
  const kept = keptOriginalPath(wanted, hash);
  if (hashAtKept === undefined) return { action: 'write', path: kept, keptOriginal: wanted };
  if (hashAtKept === hash) return { action: 'same', path: kept };
  return { action: 'refuse', path: kept,
    reason: `${wanted} and ${kept} both hold other files; rename this file and upload it again` };
}
