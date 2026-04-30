/**
 * Recursive filesystem walk into a slug → Stats map.
 *
 * Replaces per-page `existsSync` + `statSync` syscall storms (Issue #14 of
 * the v0.22.3 eng review). On a 200K-page brain the per-page approach was
 * 400K syscalls in a synchronous loop; this walk is one syscall per directory
 * plus one stat per file, then O(1) Map lookups for everything downstream.
 *
 * The slug key is the on-disk path relative to the brain repo, with the
 * trailing `.md` stripped, matching how pages are stored: `people/alice.md`
 * on disk becomes `people/alice` as a slug.
 *
 * Skipped entries:
 *   - `.git/`, `node_modules/`, and dot-directories generally — not part of
 *     the brain's page namespace. Speeds up walks significantly on dirty
 *     working copies.
 *   - Files that don't end in `.md`. Sidecar JSON, raw binary attachments,
 *     etc. are tracked by the brain but not via slugs.
 */

import { readdirSync, statSync, type Stats, type Dirent } from 'fs';
import { join } from 'path';

export interface DiskFileEntry {
  size: number;
  mtimeMs: number;
}

/**
 * Walk `repoPath` and return a Map of slug → file metadata for every `.md`
 * file. Skips dot-directories. Synchronous (matches the call-site shape and
 * the io pattern of stat-heavy scans).
 *
 * @param repoPath  Absolute path to the brain repo root.
 * @returns  Map keyed by slug (no `.md` suffix). Empty map if repoPath
 *           doesn't exist or contains no markdown files.
 */
export function walkBrainRepo(repoPath: string): Map<string, DiskFileEntry> {
  const result = new Map<string, DiskFileEntry>();

  function recurse(dirPath: string, slugPrefix: string): void {
    // Annotate as Dirent[] explicitly: ReturnType<typeof readdirSync> with
    // withFileTypes:true picks an overload union that includes
    // Dirent<Buffer<ArrayBufferLike>>, which makes entry.name a Buffer in
    // strict tsc mode. Cast to the string-based Dirent[] (same shape sync.ts
    // uses for its own filesystem walk).
    let entries: Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return; // unreadable directory — skip silently
    }

    for (const entry of entries) {
      // Skip dot-directories (.git, .gbrain, .vscode, etc) and node_modules.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const childPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        recurse(childPath, slugPrefix ? `${slugPrefix}/${entry.name}` : entry.name);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;

      let stats: Stats;
      try {
        stats = statSync(childPath);
      } catch {
        continue; // race: file deleted between readdir and stat
      }

      const slug = slugPrefix
        ? `${slugPrefix}/${entry.name.slice(0, -3)}`
        : entry.name.slice(0, -3);
      result.set(slug, { size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }

  recurse(repoPath, '');
  return result;
}
