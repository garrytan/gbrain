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
 *
 *   <!-- timeline -->
 *   Timeline content here...
 *
 * The first --- pair is YAML frontmatter (handled by gray-matter).
 * After frontmatter, the body is split at the first recognized timeline
 * sentinel: `<!-- timeline -->` (preferred), `--- timeline ---` (decorated),
 * or a plain `---` immediately preceding a `## Timeline` / `## History`
 * heading (backward-compat for existing files). A bare `---` in body text
 * is treated as a markdown horizontal rule, not a timeline separator.
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
 * Split body content at the first recognized timeline sentinel.
 * Returns compiled_truth (before) and timeline (after).
 *
 * Recognized sentinels (in order of precedence):
 *   1. `<!-- timeline -->` — preferred, unambiguous, what serializeMarkdown emits
 *   2. `--- timeline ---` — decorated separator
 *   3. `---` ONLY when the next non-empty line is `## Timeline` or `## History`
 *      (backward-compat fallback for older gbrain-written files)
 *
 * A plain `---` line is a markdown horizontal rule, NOT a timeline separator.
 * Treating bare `---` as a separator caused 83% content truncation on wiki corpora.
 */
export function splitBody(body: string): { compiled_truth: string; timeline: string } {
  const lines = body.split('\n');
  const splitIndex = findTimelineSplitIndex(lines);

  if (splitIndex === -1) {
    return { compiled_truth: body, timeline: '' };
  }

  const compiled_truth = lines.slice(0, splitIndex).join('\n');
  const timeline = lines.slice(splitIndex + 1).join('\n');
  return { compiled_truth, timeline };
}

function findTimelineSplitIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === '<!-- timeline -->' || trimmed === '<!--timeline-->') {
      return i;
    }

    if (trimmed === '--- timeline ---' || /^---\s+timeline\s+---$/i.test(trimmed)) {
      return i;
    }

    if (trimmed === '---') {
      const beforeContent = lines.slice(0, i).join('\n').trim();
      if (beforeContent.length === 0) continue;

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next.length === 0) continue;
        if (/^##\s+(timeline|history)\b/i.test(next)) return i;
        break;
      }
    }
  }
  return -1;
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
    body += '\n\n<!-- timeline -->\n\n' + timeline;
  }

  return yamlContent + '\n\n' + body + '\n';
}

function inferType(filePath?: string): PageType {
  if (!filePath) return 'concept';

  // Normalize: add leading / for consistent matching.
  // Wiki subtypes and /writing/ check FIRST — they're stronger signals than
  // ancestor directories. e.g. `projects/blog/writing/essay.md` is a piece of
  // writing, not a project page; `tech/wiki/analysis/foo.md` is analysis,
  // not a hit on the broader `tech/` ancestor.
  const lower = ('/' + filePath).toLowerCase();
  if (lower.includes('/writing/')) return 'writing';
  if (lower.includes('/wiki/analysis/')) return 'analysis';
  if (lower.includes('/wiki/guides/') || lower.includes('/wiki/guide/')) return 'guide';
  if (lower.includes('/wiki/hardware/')) return 'hardware';
  if (lower.includes('/wiki/architecture/')) return 'architecture';
  if (lower.includes('/wiki/concepts/') || lower.includes('/wiki/concept/')) return 'concept';
  if (lower.includes('/people/') || lower.includes('/person/')) return 'person';
  if (lower.includes('/companies/') || lower.includes('/company/')) return 'company';
  if (lower.includes('/deals/') || lower.includes('/deal/')) return 'deal';
  if (lower.includes('/yc/')) return 'yc';
  if (lower.includes('/civic/')) return 'civic';
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
