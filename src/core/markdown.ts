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
  const cleanFrontmatter = normalizeCodemapDates({ ...frontmatter });
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
  if (lower.includes('/systems/') || lower.includes('/system/')) return 'system';
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

export function buildFrontmatterSearchText(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];

  appendField(lines, 'repo', frontmatter.repo);
  appendField(lines, 'language', frontmatter.language);
  appendField(lines, 'build command', frontmatter.build_command);
  appendField(lines, 'test command', frontmatter.test_command);

  const keyEntryPoints = asArrayOfRecords(frontmatter.key_entry_points);
  for (const entryPoint of keyEntryPoints) {
    lines.push(joinSearchParts([
      'entry point',
      entryPoint.name,
      expandSearchableText(entryPoint.path),
      entryPoint.purpose,
    ]));
  }

  const codemap = asArrayOfRecords(frontmatter.codemap);
  for (const entry of codemap) {
    lines.push(joinSearchParts([
      'codemap system',
      entry.system,
      entry.vocabulary,
    ]));

    for (const pointer of asArrayOfRecords(entry.pointers)) {
      lines.push(joinSearchParts([
        'pointer',
        expandSearchableText(pointer.path),
        expandSearchableText(pointer.symbol),
        pointer.role,
        pointer.verified_at,
        pointer.stale === true ? 'stale' : '',
      ]));
    }
  }

  return lines.filter(Boolean).join('\n').trim();
}

export function expandTechnicalAliases(value: string): string[] {
  switch (value.trim().toLowerCase()) {
    case 'c++':
      return ['cpp', 'cplusplus'];
    case 'c#':
      return ['csharp'];
    case 'f#':
      return ['fsharp'];
    case 'objective-c':
      return ['objectivec'];
    default:
      return [];
  }
}

function normalizeCodemapDates(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const codemap = asArrayOfRecords(frontmatter.codemap);
  if (codemap.length === 0) return frontmatter;

  return {
    ...frontmatter,
    codemap: codemap.map((entry) => ({
      ...entry,
      pointers: asArrayOfRecords(entry.pointers).map((pointer) => ({
        ...pointer,
        verified_at: pointer.verified_at instanceof Date
          ? formatVerifiedAt(pointer.verified_at)
          : pointer.verified_at,
      })),
    })),
  };
}

function appendField(lines: string[], label: string, value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    lines.push(joinSearchParts([label, expandSearchableText(value)]));
    return;
  }
  if (Array.isArray(value) && value.length > 0) {
    lines.push(joinSearchParts([label, ...value.map((item) => expandSearchableText(String(item)))]));
  }
}

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

function expandSearchableText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  const aliases = expandTechnicalAliases(trimmed);
  const parts = [trimmed];

  if (normalized && normalized !== trimmed && !(normalized.length === 1 && aliases.length > 0)) {
    parts.push(normalized);
  }
  parts.push(...aliases);

  return Array.from(new Set(parts.filter(Boolean))).join(' ');
}

function joinSearchParts(parts: unknown[]): string {
  return parts
    .flatMap((part) => typeof part === 'string' ? [part] : [])
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function formatVerifiedAt(value: Date): string {
  return isDateOnly(value) ? value.toISOString().slice(0, 10) : value.toISOString();
}

function isDateOnly(value: Date): boolean {
  return value.getUTCHours() === 0
    && value.getUTCMinutes() === 0
    && value.getUTCSeconds() === 0
    && value.getUTCMilliseconds() === 0;
}
