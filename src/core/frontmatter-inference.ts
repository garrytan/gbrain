/**
 * Frontmatter inference — synthesize YAML frontmatter from filesystem metadata.
 *
 * ## Why this exists
 *
 * GBrain's sync and import pipelines work fine without frontmatter — gray-matter
 * returns the full content as body, and `inferType`/`inferTitle` in markdown.ts
 * provide fallbacks. But the inferred metadata is minimal:
 *
 *   - `type` defaults to 'concept' for most paths
 *   - `title` is the slugified filename ("2010 04 13 Apr 13 Founders Mtg")
 *   - No `date` field, no `source` metadata, no folder-aware tagging
 *
 * This module provides **rich inference** — directory-aware type mapping, date
 * extraction from filenames, title cleanup (strip date prefixes, HTML entities),
 * heading extraction from content, and source/folder tagging. It produces a
 * complete frontmatter block that can be:
 *
 *   1. Written back to the file on disk (via `gbrain frontmatter generate --fix`)
 *   2. Used at import time without modifying the file (DB-only inference)
 *   3. Shown as a dry-run preview (via `gbrain frontmatter generate --dry-run`)
 *
 * ## Design principles
 *
 *   - **Never overwrite existing frontmatter.** If a file already has `---`, skip it.
 *   - **Infer from filesystem first, content second.** Directory path → type, filename → date + title,
 *     first `#` heading → title fallback, content → entity hints.
 *   - **Deterministic.** Same file always produces the same frontmatter. No LLM calls, no network.
 *   - **Extensible via rules.** The `DIRECTORY_RULES` table maps path patterns to type + source + tags.
 *     Adding a new directory convention = adding one rule.
 *   - **Safe.** `.bak` files on write, `--dry-run` by default in CLI, idempotent.
 *
 * ## How it fits in the pipeline
 *
 * ```
 *   Sync/Import
 *     → file has frontmatter? → normal import (existing path)
 *     → file has NO frontmatter?
 *       → inferFrontmatter(filePath, content) → synthesize frontmatter
 *       → prepend to content → import as usual
 *       → optionally write back to disk (--write-back flag)
 * ```
 *
 * The inference runs BEFORE `parseMarkdown`, so the downstream pipeline sees
 * well-formed frontmatter and all the existing validation/chunking/embedding
 * logic works unchanged.
 *
 * ## Directory rules table
 *
 * Each rule matches a path pattern (case-insensitive prefix) and provides:
 *   - `type`: page type for the brain schema
 *   - `source`: optional source tag (e.g., "apple-notes", "therapy")
 *   - `tags`: optional additional tags
 *   - `datePattern`: where to look for dates — 'filename' (YYYY-MM-DD prefix),
 *     'dirname' (parent dir name), or 'none'
 *   - `titleStrategy`: how to extract title — 'filename' (strip date prefix),
 *     'heading' (first # in content), 'filename-full' (no date strip)
 */

import { basename, dirname, relative } from 'path';

// ─── Types ───────────────────────────────────────────────────────────

export interface InferredFrontmatter {
  title: string;
  type: string;
  date?: string;
  source?: string;
  tags?: string[];
  /** True if the file already has frontmatter (inference skipped). */
  skipped?: boolean;
  /** The rule that matched, for debugging. */
  matchedRule?: string;
}

export interface DirectoryRule {
  /** Case-insensitive path prefix to match (e.g., 'apple notes/'). */
  pathPrefix: string;
  /** Page type to assign. */
  type: string;
  /** Optional source tag. */
  source?: string;
  /** Optional tags to add. */
  tags?: string[];
  /** Where to look for dates. Default: 'filename'. */
  datePattern?: 'filename' | 'dirname' | 'none';
  /** How to extract title. Default: 'filename'. */
  titleStrategy?: 'filename' | 'heading' | 'filename-full';
}

// ─── Directory Rules ─────────────────────────────────────────────────
// Ordered from most specific to least specific. First match wins.
// Add new directory conventions here.

export const DIRECTORY_RULES: DirectoryRule[] = [
  // Apple Notes — bulk import from Apple Notes app. Filenames are
  // "YYYY-MM-DD Title.md" with HTML-styled content.
  {
    pathPrefix: 'apple notes/youtube shows/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['youtube', 'shows'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'apple notes/yc/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['yc'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'apple notes/archived/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['archived'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'apple notes/politics/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['politics'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'apple notes/pitch notes/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['pitch-notes'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'apple notes/gstack/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['gstack'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'apple notes/photo-cameras/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['photography'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'apple notes/jan bowman notes/',
    type: 'apple-note',
    source: 'apple-notes',
    tags: ['therapy', 'jan-bowman'],
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  // Catch-all for Apple Notes not in a subfolder
  {
    pathPrefix: 'apple notes/',
    type: 'apple-note',
    source: 'apple-notes',
    datePattern: 'filename',
    titleStrategy: 'filename',
  },

  // Calendar diarization files
  {
    pathPrefix: 'daily/calendar/',
    type: 'calendar-index',
    source: 'calendar',
    datePattern: 'filename',
    titleStrategy: 'filename',
  },

  // Personal sections
  {
    pathPrefix: 'personal/therapy/',
    type: 'therapy-session',
    source: 'therapy',
    datePattern: 'filename',
    titleStrategy: 'filename',
  },
  {
    pathPrefix: 'personal/reflections/',
    type: 'reflection',
    source: 'personal',
    datePattern: 'filename',
    titleStrategy: 'heading',
  },
  {
    pathPrefix: 'personal/',
    type: 'personal',
    source: 'personal',
    datePattern: 'none',
    titleStrategy: 'heading',
  },

  // Writing
  {
    pathPrefix: 'writing/essays/',
    type: 'essay',
    source: 'writing',
    datePattern: 'filename',
    titleStrategy: 'heading',
  },
  {
    pathPrefix: 'writing/ideas/',
    type: 'idea',
    source: 'writing',
    datePattern: 'filename',
    titleStrategy: 'heading',
  },
  {
    pathPrefix: 'writing/',
    type: 'writing',
    source: 'writing',
    datePattern: 'filename',
    titleStrategy: 'heading',
  },

  // Entity directories — these should already have frontmatter in most cases,
  // but the 55 people pages etc. that don't get handled here.
  { pathPrefix: 'people/', type: 'person', titleStrategy: 'heading' },
  { pathPrefix: 'companies/', type: 'company', titleStrategy: 'heading' },
  { pathPrefix: 'projects/', type: 'project', titleStrategy: 'heading' },
  { pathPrefix: 'civic/', type: 'civic', titleStrategy: 'heading' },
  { pathPrefix: 'events/', type: 'event', titleStrategy: 'heading', datePattern: 'filename' },
  { pathPrefix: 'meetings/', type: 'meeting', titleStrategy: 'heading', datePattern: 'filename' },
  { pathPrefix: 'media/', type: 'media', titleStrategy: 'heading' },

  // Catch-all for any remaining files
  { pathPrefix: '', type: 'note', titleStrategy: 'heading' },
];

// ─── Date extraction ─────────────────────────────────────────────────

/** Extract YYYY-MM-DD date from a filename like "2010-04-13 Apr 13 founders mtg.md" */
export function extractDateFromFilename(filename: string): string | null {
  // Pattern 1: YYYY-MM-DD prefix (with - or space separator after)
  const m1 = filename.match(/^(\d{4}-\d{2}-\d{2})[\s_-]/);
  if (m1) return m1[1];

  // Pattern 2: YYYY-MM-DD anywhere in filename
  const m2 = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (m2) return m2[1];

  // Pattern 3: "YYYY MM DD" with spaces
  const m3 = filename.match(/^(\d{4})\s+(\d{2})\s+(\d{2})\s/);
  if (m3) return `${m3[1]}-${m3[2]}-${m3[3]}`;

  return null;
}

// ─── Title extraction ────────────────────────────────────────────────

/** Extract title from filename, stripping date prefix and extension. */
export function extractTitleFromFilename(filename: string): string {
  // Remove .md extension
  let title = filename.replace(/\.md$/i, '');

  // Strip YYYY-MM-DD prefix (with separator)
  title = title.replace(/^\d{4}-\d{2}-\d{2}[\s_-]+/, '');

  // Strip YYYY MM DD prefix (space-separated)
  title = title.replace(/^\d{4}\s+\d{2}\s+\d{2}\s+/, '');

  // Clean up: title case, replace dashes/underscores with spaces
  title = title
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Don't title-case if it already has mixed case (e.g., "YC presidency")
  if (title === title.toLowerCase() || title === title.toUpperCase()) {
    title = title.replace(/\b\w/g, c => c.toUpperCase());
  }

  return title || 'Untitled';
}

/** Extract title from first heading (# ...) in content. */
export function extractTitleFromHeading(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines.slice(0, 20)) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1].trim();
  }
  return null;
}

// ─── Core inference ──────────────────────────────────────────────────

/**
 * Infer frontmatter for a file that has none.
 *
 * @param relativePath - Path relative to brain root (e.g., "Apple Notes/2010-04-13 Apr 13 founders mtg.md")
 * @param content - File content (may be empty)
 * @returns Inferred frontmatter fields
 */
export function inferFrontmatter(relativePath: string, content: string): InferredFrontmatter {
  // Check if file already has frontmatter
  const firstNonEmpty = content.split('\n').find(l => l.trim().length > 0);
  if (firstNonEmpty?.trim() === '---') {
    return { title: '', type: '', skipped: true };
  }

  const lowerPath = relativePath.toLowerCase();
  const filename = basename(relativePath);

  // Find matching rule
  let matchedRule: DirectoryRule | undefined;
  for (const rule of DIRECTORY_RULES) {
    if (lowerPath.startsWith(rule.pathPrefix.toLowerCase())) {
      matchedRule = rule;
      break;
    }
  }

  // Default rule if none matched
  if (!matchedRule) {
    matchedRule = { pathPrefix: '', type: 'note', titleStrategy: 'heading' };
  }

  // Extract date
  let date: string | undefined;
  const datePattern = matchedRule.datePattern ?? 'filename';
  if (datePattern === 'filename') {
    date = extractDateFromFilename(filename) ?? undefined;
  }

  // Extract title
  let title: string;
  const titleStrategy = matchedRule.titleStrategy ?? 'filename';
  if (titleStrategy === 'heading') {
    title = extractTitleFromHeading(content) ?? extractTitleFromFilename(filename);
  } else if (titleStrategy === 'filename-full') {
    title = filename.replace(/\.md$/i, '').replace(/[-_]/g, ' ').trim();
  } else {
    title = extractTitleFromFilename(filename);
  }

  // Build tags from rule + subfolder
  const tags = [...(matchedRule.tags ?? [])];
  // Add subfolder as tag for Apple Notes (e.g., "YC", "Politics")
  if (matchedRule.source === 'apple-notes' && matchedRule.pathPrefix === 'apple notes/') {
    const parts = relativePath.split('/');
    if (parts.length > 2) {
      const subfolder = parts[1].toLowerCase().replace(/\s+/g, '-');
      if (!tags.includes(subfolder)) tags.push(subfolder);
    }
  }

  return {
    title,
    type: matchedRule.type,
    date,
    source: matchedRule.source,
    tags: tags.length > 0 ? tags : undefined,
    matchedRule: matchedRule.pathPrefix || '(default)',
  };
}

/**
 * Generate a YAML frontmatter block from inferred fields.
 * Returns the `---\n...\n---\n` string to prepend to content.
 */
export function serializeFrontmatter(fm: InferredFrontmatter): string {
  if (fm.skipped) return '';

  const lines: string[] = ['---'];

  // Title — quote if it contains special YAML chars
  const needsQuote = /[:"'#\[\]{}|>&*!?,]/.test(fm.title);
  lines.push(`title: ${needsQuote ? JSON.stringify(fm.title) : fm.title}`);

  lines.push(`type: ${fm.type}`);

  if (fm.date) {
    lines.push(`date: "${fm.date}"`);
  }

  if (fm.source) {
    lines.push(`source: ${fm.source}`);
  }

  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map(t => JSON.stringify(t)).join(', ')}]`);
  }

  lines.push('---');
  return lines.join('\n') + '\n';
}

/**
 * Apply frontmatter inference to file content.
 * Returns the content with frontmatter prepended, or the original content if it already has frontmatter.
 */
export function applyInference(relativePath: string, content: string): { content: string; inferred: InferredFrontmatter } {
  const inferred = inferFrontmatter(relativePath, content);
  if (inferred.skipped) {
    return { content, inferred };
  }
  const fm = serializeFrontmatter(inferred);
  return { content: fm + '\n' + content, inferred };
}
