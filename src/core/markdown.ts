import matter from 'gray-matter';
import type { PageType } from './types.ts';
import { slugifyPath } from './sync.ts';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  compiled_truth: string;
  timeline: string;
  slug: string;
  type: PageType;
  title: string;
  tags: string[];
}

/**
 * Parse a markdown file with YAML frontmatter into its components.
 *
 * Structure:
 *   ---
 *   type: concept
 *   title: Do Things That Don't Scale
 *   tags: [startups, growth]
 *   ---
 *   Compiled truth content here...
 *   ---
 *   Timeline content here...
 *
 * The first --- pair is YAML frontmatter (handled by gray-matter).
 * After frontmatter, the body is split at the first standalone ---
 * (a line containing only --- with optional whitespace).
 * Everything before is compiled_truth, everything after is timeline.
 * If no body --- exists, all content is compiled_truth.
 */
export function parseMarkdown(content: string, filePath?: string): ParsedMarkdown {
  const { data: frontmatter, content: body } = matter(content);

  // Split body at first standalone ---
  const { compiled_truth, timeline } = splitBody(body);

  // Extract metadata from frontmatter
  const type = (frontmatter.type as PageType) || inferType(filePath);
  const title = (frontmatter.title as string) || inferTitle(filePath);
  const tags = extractTags(frontmatter);
  const slug = (frontmatter.slug as string) || inferSlug(filePath);

  // Remove processed fields from frontmatter (they're stored as columns)
  const cleanFrontmatter = { ...frontmatter };
  delete cleanFrontmatter.type;
  delete cleanFrontmatter.title;
  delete cleanFrontmatter.tags;
  delete cleanFrontmatter.slug;

  return {
    frontmatter: cleanFrontmatter,
    compiled_truth: compiled_truth.trim(),
    timeline: timeline.trim(),
    slug,
    type,
    title,
    tags,
  };
}

/**
 * Split body content at an explicit timeline sentinel.
 * Returns compiled_truth (before) and timeline (after).
 *
 * Recognized sentinels (in priority order):
 *   1. `<!-- timeline -->` — explicit HTML comment marker (preferred, unambiguous)
 *   2. `--- timeline ---`  — decorated separator (unambiguous)
 *   3. A standalone `---` line whose NEXT non-empty line is `## Timeline` or `## History`
 *      (heading-gated fallback for backward compatibility)
 *
 * Plain `---` horizontal rules in article bodies are NOT treated as sentinels.
 * This avoids the truncation bug where wiki articles using `---` as section
 * dividers had everything after the first divider incorrectly labelled as timeline.
 */
export function splitBody(body: string): { compiled_truth: string; timeline: string } {
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Sentinel 1: explicit HTML comment marker
    if (trimmed === '<!-- timeline -->') {
      const compiled_truth = lines.slice(0, i).join('\n');
      const timeline = lines.slice(i + 1).join('\n');
      return { compiled_truth, timeline };
    }

    // Sentinel 2: decorated separator
    if (trimmed === '--- timeline ---') {
      const compiled_truth = lines.slice(0, i).join('\n');
      const timeline = lines.slice(i + 1).join('\n');
      return { compiled_truth, timeline };
    }

    // Sentinel 3: heading-gated --- (backward compat)
    // Only split on plain `---` when the next non-empty line is a Timeline/History heading.
    if (trimmed === '---') {
      const beforeContent = lines.slice(0, i).join('\n').trim();
      if (beforeContent.length > 0) {
        // Find next non-empty line after this separator
        let nextNonEmpty = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() !== '') {
            nextNonEmpty = lines[j].trim();
            break;
          }
        }
        if (/^##\s+(Timeline|History)\b/i.test(nextNonEmpty)) {
          const compiled_truth = lines.slice(0, i).join('\n');
          const timeline = lines.slice(i + 1).join('\n');
          return { compiled_truth, timeline };
        }
        // Plain --- not followed by Timeline/History heading — treat as horizontal rule,
        // continue scanning for a proper sentinel.
      }
    }
  }

  return { compiled_truth: body, timeline: '' };
}

/**
 * Serialize a page back to markdown format.
 * Produces: frontmatter + compiled_truth + <!-- timeline --> + timeline
 *
 * Uses `<!-- timeline -->` as the explicit sentinel (not plain `---`) so that
 * the output is parseable by `splitBody()` without ambiguity.
 */
export function serializeMarkdown(
  frontmatter: Record<string, unknown>,
  compiled_truth: string,
  timeline: string,
  meta: { type: PageType; title: string; tags: string[] },
): string {
  // Build full frontmatter including type, title, tags
  const fullFrontmatter: Record<string, unknown> = {
    type: meta.type,
    title: meta.title,
    ...frontmatter,
  };
  if (meta.tags.length > 0) {
    fullFrontmatter.tags = meta.tags;
  }

  const yamlContent = matter.stringify('', fullFrontmatter).trim();

  let body = compiled_truth;
  if (timeline) {
    body += '\n\n<!-- timeline -->\n\n' + timeline;
  }

  return yamlContent + '\n\n' + body + '\n';
}

function inferType(filePath?: string): PageType {
  if (!filePath) return 'concept';

  // Normalize: add leading / for consistent matching
  const lower = ('/' + filePath).toLowerCase();
  if (lower.includes('/people/') || lower.includes('/person/')) return 'person';
  if (lower.includes('/companies/') || lower.includes('/company/')) return 'company';
  if (lower.includes('/deals/') || lower.includes('/deal/')) return 'deal';
  if (lower.includes('/yc/')) return 'yc';
  if (lower.includes('/civic/')) return 'civic';
  if (lower.includes('/projects/') || lower.includes('/project/')) return 'project';
  if (lower.includes('/sources/') || lower.includes('/source/')) return 'source';
  if (lower.includes('/media/')) return 'media';
  // Wiki subdirectory types — checked after generic types so /wiki/projects/ still
  // resolves to 'project' via the generic rule above, but wiki-specific subtypes win.
  if (lower.includes('/wiki/analysis/')) return 'analysis';
  if (lower.includes('/wiki/guides/') || lower.includes('/wiki/guide/')) return 'guide';
  if (lower.includes('/wiki/hardware/')) return 'hardware';
  if (lower.includes('/wiki/architecture/')) return 'architecture';
  if (lower.includes('/wiki/concepts/') || lower.includes('/wiki/concept/')) return 'concept';
  return 'concept';
}

function inferTitle(filePath?: string): string {
  if (!filePath) return 'Untitled';

  // Extract filename without extension, convert dashes/underscores to spaces
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1]?.replace(/\.md$/i, '') || 'Untitled';
  return filename.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function inferSlug(filePath?: string): string {
  if (!filePath) return 'untitled';
  return slugifyPath(filePath);
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags;
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}
