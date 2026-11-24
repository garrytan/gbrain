import { closeSync, openSync, readSync } from 'node:fs';

const MAX_BYTES = 64 * 1024;
const MAX_PAGES = 150;
const REVISION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Read an explicit, bounded list; an empty or malformed list never means all pages. */
export function readAtomPageSelection(path: string): ReadonlyMap<string, string> {
  const buf = Buffer.alloc(MAX_BYTES + 1);
  const fd = openSync(path, 'r');
  let size = 0;
  try {
    while (size < buf.length) {
      const count = readSync(fd, buf, size, buf.length - size, null);
      if (count === 0) break;
      size += count;
    }
  } finally {
    closeSync(fd);
  }
  if (size > MAX_BYTES) throw new Error('The atom page list exceeds 64 KiB.');
  const rows: unknown = JSON.parse(buf.subarray(0, size).toString('utf8'));
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_PAGES) {
    throw new Error('Provide between 1 and 150 {slug, revision} entries.');
  }
  const pages = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== 2 ||
        typeof row.slug !== 'string' || !row.slug.trim() || row.slug.length > 512 ||
        typeof row.revision !== 'string' || !REVISION.test(row.revision) || pages.has(row.slug)) {
      throw new Error('Each atom page entry needs a unique slug and an exact revision UUID.');
    }
    pages.set(row.slug, row.revision.toLowerCase());
  }
  return pages;
}
