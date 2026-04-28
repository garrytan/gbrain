import matter from 'gray-matter';
import type { PageType } from './types.ts';
import { slugifyPath } from './sync.ts';

export type ParseValidationCode =
  | 'MISSING_OPEN'
  | 'MISSING_CLOSE'
  | 'YAML_PARSE'
  | 'SLUG_MISMATCH'
  | 'NULL_BYTES'
  | 'NESTED_QUOTES'
  | 'EMPTY_FRONTMATTER';

export interface ParseValidationError {
  code: ParseValidationCode;
  message: string;
  line?: number;
}

export interface ParseOpts {
  /** When true, errors[] is populated. Existing callers unaffected. */
  validate?: boolean;
  /** When validate is true and frontmatter has a `slug:` field that doesn't
   *  match expectedSlug, emits SLUG_MISMATCH. */
  expectedSlug?: string;
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  compiled_truth: string;
  timeline: string;
  slug: string;
  type: PageType;
  title: string;
  tags: string[];
  /** Present iff opts.validate. Empty array means no errors. */
  errors?: ParseValidationError[];
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
export function parseMarkdown(
  content: string,
  filePath?: string,
  opts?: ParseOpts,
): ParsedMarkdown {
  const errors: ParseValidationError[] = [];

  // gray-matter is forgiving: it returns empty data + original content for
  // pretty much any input. The validation surface below catches the cases
  // it silently swallows. Validation only runs when opts.validate is true,
  // so existing callers are unaffected.
  let parsed: ReturnType<typeof matter> | null = null;
  let yamlParseError: Error | null = null;
  try {
    parsed = matter(content);
  } catch (e) {
    yamlParseError = e as Error;
  }

  if (opts?.validate) {
    collectValidationErrors(content, errors, {
      yamlParseError,
      expectedSlug: opts.expectedSlug,
      parsedFrontmatter: parsed?.data ?? {},
    });
  }

  // When YAML parsing failed (rare; gray-matter is forgiving), fall back to
  // empty frontmatter + raw content as the body so non-validate callers still
  // get a usable shape.
  const frontmatter = (parsed?.data ?? {}) as Record<string, unknown>;
  const body = parsed?.content ?? content;

  const { compiled_truth, timeline } = splitBody(body);

  const type = (frontmatter.type as PageType) || inferType(filePath);
  const title = (frontmatter.title as string) || inferTitle(filePath);
  const tags = extractTags(frontmatter);
  const slug = (frontmatter.slug as string) || inferSlug(filePath);

  const cleanFrontmatter = { ...frontmatter };
  delete cleanFrontmatter.type;
  delete cleanFrontmatter.title;
  delete cleanFrontmatter.tags;
  delete cleanFrontmatter.slug;

  const result: ParsedMarkdown = {
    frontmatter: cleanFrontmatter,
    compiled_truth: compiled_truth.trim(),
    timeline: timeline.trim(),
    slug,
    type,
    title,
    tags,
  };
  if (opts?.validate) result.errors = errors;
  return result;
}

/**
 * Inspect raw content for the 7 frontmatter validation classes that gray-matter
 * silently accepts. Mutates `errors` in place. The order of checks is
 * deliberate: cheap byte-level checks first, then structural checks, then
 * YAML-parse-dependent checks.
 */
function collectValidationErrors(
  content: string,
  errors: ParseValidationError[],
  ctx: {
    yamlParseError: Error | null;
    expectedSlug?: string;
    parsedFrontmatter: Record<string, unknown>;
  },
): void {
  // 1. NULL_BYTES — binary corruption indicator.
  const nullIdx = content.indexOf('\x00');
  if (nullIdx >= 0) {
    const line = content.slice(0, nullIdx).split('\n').length;
    errors.push({
      code: 'NULL_BYTES',
      message: 'Content contains null bytes (likely binary corruption)',
      line,
    });
  }

  // 2. MISSING_OPEN — first non-empty line must be `---`.
  const lines = content.split('\n');
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  if (firstNonEmpty === -1) {
    // Empty file: treat as MISSING_OPEN. Don't run other structural checks.
    errors.push({
      code: 'MISSING_OPEN',
      message: 'File is empty or whitespace-only; expected frontmatter starting with ---',
      line: 1,
    });
    return;
  }
  if (lines[firstNonEmpty].trim() !== '---') {
    errors.push({
      code: 'MISSING_OPEN',
      message: 'Frontmatter must start with --- on the first non-empty line',
      line: firstNonEmpty + 1,
    });
    // Without an opener we can't reason about MISSING_CLOSE / EMPTY_FRONTMATTER
    // / NESTED_QUOTES inside frontmatter. Stop structural checks here.
    return;
  }

  // 3. MISSING_CLOSE — find the next `---` after the opener. If a markdown
  //    heading appears before it, that's a strong signal the closing
  //    delimiter is missing (the heading was meant to be in the body).
  let closeLine = -1;
  let headingBeforeClose = -1;
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---') {
      closeLine = i;
      break;
    }
    if (/^#{1,6}\s/.test(t) && headingBeforeClose === -1) {
      headingBeforeClose = i;
    }
  }
  if (closeLine === -1) {
    errors.push({
      code: 'MISSING_CLOSE',
      message:
        headingBeforeClose >= 0
          ? `No closing --- before heading at line ${headingBeforeClose + 1}`
          : 'No closing --- delimiter found',
      line: headingBeforeClose >= 0 ? headingBeforeClose + 1 : firstNonEmpty + 1,
    });
    return;
  }
  if (headingBeforeClose >= 0 && headingBeforeClose < closeLine) {
    errors.push({
      code: 'MISSING_CLOSE',
      message: `Heading at line ${headingBeforeClose + 1} found inside frontmatter zone (closing --- comes after)`,
      line: headingBeforeClose + 1,
    });
  }

  // 4. EMPTY_FRONTMATTER — open and close present but nothing meaningful between.
  const fmBody = lines.slice(firstNonEmpty + 1, closeLine).join('\n').trim();
  if (fmBody.length === 0) {
    errors.push({
      code: 'EMPTY_FRONTMATTER',
      message: 'Frontmatter block is empty',
      line: firstNonEmpty + 1,
    });
  }

  // 5. NESTED_QUOTES — common breakage pattern: `title: "Name "Nick" Last"`.
  //    Detect any frontmatter `key: ...` line whose value contains 3 or more
  //    unescaped double-quote characters. A clean quoted value has 2.
  for (let i = firstNonEmpty + 1; i < closeLine; i++) {
    const line = lines[i];
    const m = line.match(/^\s*[A-Za-z_][\w-]*\s*:\s*(.*)$/);
    if (!m) continue;
    const value = m[1];
    let count = 0;
    for (let j = 0; j < value.length; j++) {
      if (value[j] === '"' && (j === 0 || value[j - 1] !== '\\')) count++;
    }
    if (count >= 3) {
      errors.push({
        code: 'NESTED_QUOTES',
        message: 'Nested double quotes in YAML value (use single quotes for the outer)',
        line: i + 1,
      });
    }
  }

  // 6. YAML_PARSE — gray-matter threw.
  if (ctx.yamlParseError) {
    errors.push({
      code: 'YAML_PARSE',
      message: `YAML parse failed: ${ctx.yamlParseError.message}`,
      line: firstNonEmpty + 1,
    });
  }

  // 7. SLUG_MISMATCH — only when expectedSlug was provided and a slug field exists.
  if (ctx.expectedSlug && typeof ctx.parsedFrontmatter.slug === 'string') {
    const declared = ctx.parsedFrontmatter.slug as string;
    if (declared !== ctx.expectedSlug) {
      errors.push({
        code: 'SLUG_MISMATCH',
        message: `Frontmatter slug "${declared}" does not match path-derived slug "${ctx.expectedSlug}"`,
      });
    }
  }
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
  // BrainBench v1 amara-life-v1 corpus directories. One-slash slug convention
  // means source paths look like `emails/em-0001.md`, `slack/sl-0037.md`, etc.
  if (lower.includes('/emails/') || lower.includes('/email/')) return 'email';
  if (lower.includes('/slack/')) return 'slack';
  if (lower.includes('/cal/') || lower.includes('/calendar/')) return 'calendar-event';
  if (lower.includes('/notes/') || lower.includes('/note/')) return 'note';
  if (lower.includes('/meetings/') || lower.includes('/meeting/')) return 'meeting';
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
