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
 * Split body content at first standalone --- separator.
 * Returns compiled_truth (before) and timeline (after).
 */
export function splitBody(body: string): { compiled_truth: string; timeline: string } {
  // Match a line that is only --- (with optional whitespace)
  // Must not be at the very start (that would be frontmatter)
  const lines = body.split('\n');
  let splitIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '---') {
      // Skip if this is the very first non-empty line (leftover from frontmatter parsing)
      const beforeContent = lines.slice(0, i).join('\n').trim();
      if (beforeContent.length > 0) {
        splitIndex = i;
        break;
      }
    }
  }

  if (splitIndex === -1) {
    return { compiled_truth: body, timeline: '' };
  }

  const compiled_truth = lines.slice(0, splitIndex).join('\n');
  const timeline = lines.slice(splitIndex + 1).join('\n');
  return { compiled_truth, timeline };
}

/**
 * Serialize a page back to markdown format.
 * Produces: frontmatter + compiled_truth + --- + timeline
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
    body += '\n\n---\n\n' + timeline;
  }

  return yamlContent + '\n\n' + body + '\n';
}

function inferType(filePath?: string): PageType {
  if (!filePath) return 'concept';

  // Normalize: add leading / for consistent matching
  const lower = ('/' + filePath).toLowerCase();
  if (lower.includes('/people/') || lower.includes('/person/')) return 'person';
  if (lower.includes('/companies/') || lower.includes('/company/')) return 'company';
  if (lower.includes('/mandates/') || lower.includes('/mandate/')) return 'mandate';
  if (lower.includes('/knowledge/') || lower.includes('/books/') || lower.includes('/transcripts/')) return 'knowledge';
  if (lower.includes('/projects/') || lower.includes('/project/')) return 'project';
  if (lower.includes('/sources/') || lower.includes('/source/')) return 'source';
  if (lower.includes('/media/')) return 'media';
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
