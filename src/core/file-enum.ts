import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Enumerate absolute paths of `.md` files under `dir` whose basename starts
 * with `filenamePrefix` AND whose mtime is strictly greater than `since`.
 *
 * Symmetric with stamp_frontmatter.py:209-210 in webex-digest-package
 * (glob("Webex *.md") + st_mtime > since_ts). Non-recursive.
 */
export async function enumerateFilteredSince(
  dir: string,
  since: string,
  filenamePrefix: string,
): Promise<string[]> {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) {
    throw new Error(`enumerateFilteredSince: invalid --since timestamp: ${since}`);
  }
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return out; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (!entry.endsWith('.md')) continue;
    if (!entry.startsWith(filenamePrefix)) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > sinceMs) out.push(full);
    } catch { continue; }
  }
  out.sort();
  return out;
}
