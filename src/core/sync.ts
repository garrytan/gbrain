/**
 * Sync utilities — pure functions for git diff parsing, filtering, and slug management.
 *
 * SYNC DATA FLOW:
 *   git diff --name-status -M LAST..HEAD
 *       │
 *   buildSyncManifest()  →  parse A/M/D/R lines
 *       │
 *   isSyncable()  →  filter to .md pages only
 *       │
 *   pathToSlug()  →  convert file paths to page slugs
 */

export interface SyncManifest {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export interface RawManifestEntry {
  action: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

const CJK_SLUG_CHARS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF\\uAC00-\\uD7AF';
const SLUGIFY_KEEP_RE = new RegExp(`[^a-z0-9.\\s_\\-${CJK_SLUG_CHARS}]`, 'g');
const HANGUL_COMPATIBILITY_RE = /[\u3130-\u318F\u3200-\u321E\u3260-\u327E]/g;

/**
 * Parse the output of `git diff --name-status -M LAST..HEAD` into structured entries.
 *
 * Input format (tab-separated):
 *   A       path/to/new-file.md
 *   M       path/to/modified-file.md
 *   D       path/to/deleted-file.md
 *   R100    old/path.md     new/path.md
 */
export function buildSyncManifest(gitDiffOutput: string): SyncManifest {
  const manifest: SyncManifest = {
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
  };

  const lines = gitDiffOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;

    const action = parts[0];
    const path = parts[parts.length === 3 ? 2 : 1]; // For renames, new path is 3rd column

    if (action === 'A') {
      manifest.added.push(path);
    } else if (action === 'M') {
      manifest.modified.push(path);
    } else if (action === 'D') {
      manifest.deleted.push(parts[1]);
    } else if (action.startsWith('R')) {
      // Rename: R100\told-path\tnew-path
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath && newPath) {
        manifest.renamed.push({ from: oldPath, to: newPath });
      }
    }
  }

  return manifest;
}

/**
 * Filter a file path to determine if it should be synced to MBrain.
 */
export function isSyncable(path: string): boolean {
  // Must be .md or .mdx
  if (!path.endsWith('.md') && !path.endsWith('.mdx')) return false;

  // Skip hidden directories
  if (path.split('/').some(p => p.startsWith('.'))) return false;

  // Skip .raw/ sidecar directories
  if (path.includes('.raw/')) return false;

  // Skip dependency directories
  if (path.split('/').includes('node_modules')) return false;

  // Skip meta files that aren't pages
  const skipFiles = ['schema.md', 'index.md', 'log.md', 'README.md'];
  const basename = path.split('/').pop() || '';
  if (skipFiles.includes(basename)) return false;

  // Skip ops/ directory
  if (path.startsWith('ops/')) return false;

  return true;
}

/**
 * Slugify a single path segment: lowercase, strip special chars, spaces → hyphens.
 */
export function slugifySegment(segment: string): string {
  return normalizeSlugCompatibilityChars(segment)
    .normalize('NFD')                     // Decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')      // Strip accent marks
    .normalize('NFC')                     // Recompose Hangul syllables after NFD
    .toLowerCase()
    .replace(SLUGIFY_KEEP_RE, '')         // Keep alphanumeric, CJK, dots, spaces, underscores, hyphens
    .replace(/[\s]+/g, '-')              // Spaces → hyphens
    .replace(/-+/g, '-')                 // Collapse multiple hyphens
    .replace(/^-|-$/g, '');              // Strip leading/trailing hyphens
}

function normalizeSlugCompatibilityChars(value: string): string {
  return value
    .replace(/\u3000/g, ' ')
    .replace(/[\uFF00-\uFFEF]/g, char => char.normalize('NFKC'))
    .replace(HANGUL_COMPATIBILITY_RE, char => char.normalize('NFKC'));
}

/**
 * Slugify a file path: strip .md, normalize separators, slugify each segment.
 *
 * Examples:
 *   Apple Notes/2017-05-03 ohmygreen.md → apple-notes/2017-05-03-ohmygreen
 *   people/alice-smith.md → people/alice-smith
 *   notes/v1.0.0.md → notes/v1.0.0
 */
export function slugifyPath(filePath: string): string {
  let path = filePath.replace(/\.mdx?$/i, '');
  path = path.replace(/\\/g, '/');
  path = path.replace(/^\.?\//, '');
  return path.split('/').map(slugifySegment).filter(Boolean).join('/');
}

/**
 * Convert a repo-relative file path to a MBrain page slug.
 */
export function pathToSlug(filePath: string, repoPrefix?: string): string {
  let slug = slugifyPath(filePath);
  if (repoPrefix) slug = `${repoPrefix}/${slug}`;
  return slug.toLowerCase();
}
