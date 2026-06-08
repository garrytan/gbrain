import matter from 'gray-matter';
import { safeLoad as yamlSafeLoad } from 'js-yaml';
import type { Page, PageType } from './types.ts';
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
  /**
   * v0.39 T1.5 — active schema pack to drive type inference. When set,
   * `inferType` uses the pack's `page_types[].path_prefixes` instead of
   * the hardcoded gbrain-base table. When unset, falls back to the
   * pre-v0.39 hardcoded behavior (preserves byte-for-byte parity gate
   * `test/regressions/gbrain-base-equivalence.test.ts`).
   *
   * Callers thread this from `loadActivePack(ctx)` once per command —
   * NEVER per file inside sync, per codex perf finding #7.
   */
  activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
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
 * Coerce a raw YAML frontmatter value into a string.
 *
 * js-yaml parses unquoted scalars by type: `title: 2024-06-01` becomes a JS
 * `Date`, `title: 1458` becomes a `number`. The old `(frontmatter.X as string)`
 * cast was a compile-time lie — at runtime the value stayed a Date/number, so
 * any downstream `.toLowerCase()` / `.trim()` threw and (via the importer's
 * failure gate) could wedge sync indefinitely (issue #1939).
 *
 * Dates coerce to their UTC ISO date (`2024-06-01`) — deterministic across
 * machines and matching the on-disk source token, unlike `String(date)` which
 * renders a timezone-dependent long form. Everything else uses `String()`.
 */
export function coerceFrontmatterString(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
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

  const type = coerceFrontmatterString(frontmatter.type) || (
    opts?.activePack ? inferTypeFromPack(filePath, opts.activePack) : inferType(filePath)
  );
  const title = coerceFrontmatterString(frontmatter.title).trim() || inferTitle(filePath);
  const tags = extractTags(frontmatter);
  const slug = coerceFrontmatterString(frontmatter.slug) || inferSlug(filePath);

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
  //    The heuristic: a frontmatter `key: value` line with 3+ unescaped
  //    double-quote characters is suspicious. But raw quote-counting is
  //    too dumb: a YAML flow sequence like `tags: ["yc", "w2025"]` has
  //    4 unescaped `"` by design (valid), and a single-quoted scalar
  //    like `title: 'a: "b" "c"'` has literal inner `"` (also valid).
  //    Disambiguate by running js-yaml on just the value; only flag
  //    lines that genuinely fail to parse. The full-frontmatter YAML
  //    parse error is caught separately by check 6 (YAML_PARSE) below.
  for (let i = firstNonEmpty + 1; i < closeLine; i++) {
    const line = lines[i];
    const m = line.match(/^\s*[A-Za-z_][\w-]*\s*:\s*(.*)$/);
    if (!m) continue;
    const value = m[1];
    let count = 0;
    for (let j = 0; j < value.length; j++) {
      if (value[j] === '"' && (j === 0 || value[j - 1] !== '\\')) count++;
    }
    if (count < 3) continue;

    // 3+ unescaped quotes — could be valid YAML (flow seq, single-quoted
    // scalar with inner quotes, bare scalar with embedded quotes) or
    // genuinely broken. Parse the value to disambiguate.
    let isValidYaml = false;
    try {
      yamlSafeLoad(value);
      isValidYaml = true;
    } catch {
      // YAML parse failed — line is genuinely broken
    }

    if (!isValidYaml) {
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

// v0.38 T7a (Phase B): inferType is now pack-aware.
//
// The original hardcoded behavior is preserved IDENTICALLY when the
// pack is gbrain-base (or when no pack is provided — back-compat
// callers). Schema packs can extend the path → type mapping by
// declaring `page_types[].path_prefixes` in their manifest; users
// who add `paper: { path_prefixes: [papers/, literature/] }` get
// papers/foo.md → type 'paper' without forking the engine.
//
// inferType (legacy sync wrapper) → calls inferTypeWithPrefixes with
//   the GBRAIN_BASE_PATH_PREFIXES table below, which reproduces the
//   pre-v0.38 hardcoded behavior byte-for-byte (parity-pinned by
//   test/regressions/gbrain-base-equivalence.test.ts).
// inferTypeFromPack(filePath, manifest) → new primitive that walks
//   the active pack's page_types[].path_prefixes. Priority: pack
//   declarations are scanned in order they appear in the manifest;
//   first match wins. Empty/unset prefixes do NOT match.
//
// Callers in async paths (import-file.ts, sync.ts, cycle phases) can
// adopt inferTypeFromPack(path, pack) to honor user-defined types.
// The bare inferType(path) call site remains for sync legacy paths
// and matches gbrain-base by construction.

/**
 * Hardcoded path-prefix table mirroring pre-v0.38 inferType behavior.
 * MUST stay in lockstep with the gbrain-base.yaml `path_prefixes` field
 * (parity-pinned by test/regressions/gbrain-base-equivalence.test.ts).
 * Order matters: wiki subtypes + writing scan first (stronger signal
 * than ancestor directories).
 */
const GBRAIN_BASE_PATH_PREFIXES: ReadonlyArray<{ prefixes: string[]; type: PageType }> = [
  { prefixes: ['/writing/'], type: 'writing' },
  { prefixes: ['/wiki/analysis/'], type: 'analysis' },
  { prefixes: ['/wiki/guides/', '/wiki/guide/'], type: 'guide' },
  { prefixes: ['/wiki/hardware/'], type: 'hardware' },
  { prefixes: ['/wiki/architecture/'], type: 'architecture' },
  { prefixes: ['/wiki/concepts/', '/wiki/concept/'], type: 'concept' },
  { prefixes: ['/people/', '/person/'], type: 'person' },
  { prefixes: ['/companies/', '/company/'], type: 'company' },
  { prefixes: ['/deals/', '/deal/'], type: 'deal' },
  { prefixes: ['/yc/'], type: 'yc' },
  { prefixes: ['/civic/'], type: 'civic' },
  { prefixes: ['/projects/', '/project/'], type: 'project' },
  { prefixes: ['/sources/', '/source/'], type: 'source' },
  { prefixes: ['/media/'], type: 'media' },
  { prefixes: ['/emails/', '/email/'], type: 'email' },
  { prefixes: ['/slack/'], type: 'slack' },
  { prefixes: ['/cal/', '/calendar/'], type: 'calendar-event' },
  { prefixes: ['/notes/', '/note/'], type: 'note' },
  { prefixes: ['/meetings/', '/meeting/'], type: 'meeting' },
];

function inferType(filePath?: string): PageType {
  return inferTypeWithPrefixes(filePath, GBRAIN_BASE_PATH_PREFIXES);
}

/**
 * Pack-aware variant. Callers with access to the active pack pass it
 * here to honor user-declared types. Empty `page_types` array (no
 * `extends: null` pack) falls back to gbrain-base defaults.
 *
 * Algorithm: each pack page_type contributes its `path_prefixes` array
 * in declaration order. First prefix that matches wins. Default
 * 'concept' applies when nothing matches.
 *
 * Note on prefix shape: gbrain-base stores prefixes WITHOUT the
 * leading `/` (e.g. `people/`). For matching, we lower-case the path
 * with a leading `/` prepended (matches the original behavior) and
 * test against `'/' + prefix` so `people/` matches `/people/` inside
 * the full path.
 */
export function inferTypeFromPack(
  filePath: string | undefined,
  pack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> },
): PageType {
  if (!filePath) return 'concept';
  // Empty pack → fall back to gbrain-base hardcoded defaults.
  if (pack.page_types.length === 0) {
    return inferTypeWithPrefixes(filePath, GBRAIN_BASE_PATH_PREFIXES);
  }
  const lower = ('/' + filePath).toLowerCase();
  for (const pt of pack.page_types) {
    for (const prefix of pt.path_prefixes) {
      const needle = prefix.startsWith('/') ? prefix.toLowerCase() : '/' + prefix.toLowerCase();
      if (lower.includes(needle)) {
        return pt.name;
      }
    }
  }
  return 'concept';
}

/**
 * v0.42 (T5, plan D5): pack-aware type+subtype inference. Same path-prefix
 * resolution as `inferTypeFromPack` PLUS subtype detection from
 * `pack.page_types[i].subtypes[]` (declared per type). Walks subtype rules
 * AFTER the prefix match wins. ReDoS-guarded compile of `path_pattern`
 * happens here (test/regex per call; acceptable on the ingest path).
 *
 * Subtype-rule resolution order:
 *   1. frontmatter_field+frontmatter_value (exact match)
 *   2. path_pattern (regex test against the lower-cased full path)
 *
 * Frontmatter rule wins when both match. Returns the FIRST matching
 * subtype name; subtype declarations earlier in the pack's subtypes
 * array take precedence.
 *
 * Back-compat: legacy `inferTypeFromPack(filePath, pack)` preserved
 * unchanged for the ~17 call sites that don't yet need subtype info.
 */
export function inferTypeAndSubtypeFromPack(
  filePath: string | undefined,
  pack: { page_types: ReadonlyArray<{
    name: string;
    path_prefixes: ReadonlyArray<string>;
    subtypes?: ReadonlyArray<{
      name: string;
      when: { path_pattern?: string; frontmatter_field?: string; frontmatter_value?: unknown };
    }>;
  }> },
  frontmatter?: Record<string, unknown>,
): { type: PageType; subtype?: string } {
  if (!filePath) return { type: 'concept' };
  // Empty pack → legacy fallback; no subtype info available.
  if (pack.page_types.length === 0) {
    return { type: inferTypeWithPrefixes(filePath, GBRAIN_BASE_PATH_PREFIXES) };
  }
  const lower = ('/' + filePath).toLowerCase();
  // Stage 1: prefix-match wins (same as inferTypeFromPack)
  let matchedType: { name: string; subtypes?: ReadonlyArray<{ name: string; when: { path_pattern?: string; frontmatter_field?: string; frontmatter_value?: unknown } }> } | undefined;
  outer: for (const pt of pack.page_types) {
    for (const prefix of pt.path_prefixes) {
      const needle = prefix.startsWith('/') ? prefix.toLowerCase() : '/' + prefix.toLowerCase();
      if (lower.includes(needle)) {
        matchedType = pt;
        break outer;
      }
    }
  }
  if (!matchedType) return { type: 'concept' };
  const typeName = matchedType.name as PageType;
  // Stage 2: subtype rule resolution (if any declared)
  const subtypes = matchedType.subtypes ?? [];
  if (subtypes.length === 0) return { type: typeName };
  for (const st of subtypes) {
    // Frontmatter rule first
    if (st.when.frontmatter_field !== undefined && frontmatter !== undefined) {
      const value = frontmatter[st.when.frontmatter_field];
      if (st.when.frontmatter_value !== undefined && value === st.when.frontmatter_value) {
        return { type: typeName, subtype: st.name };
      }
    }
    // Path pattern rule
    if (st.when.path_pattern !== undefined) {
      try {
        const re = new RegExp(st.when.path_pattern);
        if (re.test(filePath) || re.test(lower)) {
          return { type: typeName, subtype: st.name };
        }
      } catch {
        // Malformed regex — skip silently; pack-load validation should
        // have caught this at parse time via redos-guard.
        continue;
      }
    }
  }
  return { type: typeName };
}

function inferTypeWithPrefixes(
  filePath: string | undefined,
  table: ReadonlyArray<{ prefixes: ReadonlyArray<string>; type: PageType }>,
): PageType {
  if (!filePath) return 'concept';
  const lower = ('/' + filePath).toLowerCase();
  for (const row of table) {
    for (const p of row.prefixes) {
      if (lower.includes(p)) return row.type;
    }
  }
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

// ---------------------------------------------------------------------------
// Page -> markdown serialization helpers (v0.38 DRY extract per eng review)
//
// Pre-v0.38 the dream cycle's reverse-render at src/core/cycle/synthesize.ts
// and the planned v0.38 put_page write-through path were going to have
// near-identical 15-line bodies that differed only in their frontmatter
// stamps. This extract is the single source of truth.
// ---------------------------------------------------------------------------

import { join } from 'node:path';

/** Options for serializePageToMarkdown. */
export interface SerializePageOpts {
  /** Frontmatter fields merged on top of page.frontmatter at render time.
   *  Use this to stamp provenance (`ingested_via: 'webhook'`), identity
   *  markers (`dream_generated: true`), or any caller-specific extra
   *  fields. Original page.frontmatter keys win unless explicitly
   *  overridden. */
  frontmatterOverrides?: Record<string, unknown>;
}

/**
 * Render a Page row to its canonical on-disk markdown form. Sibling to
 * `serializeMarkdown` (which takes the underlying primitives); this version
 * pulls everything from a `Page` object so callers don't have to destructure
 * compiled_truth / timeline / tags / frontmatter at every site.
 *
 * - Frontmatter: starts from `page.frontmatter`, merged with optional
 *   `opts.frontmatterOverrides`. Useful for stamping `dream_generated`,
 *   `ingested_via`, etc.
 * - Type / title: pulled from the Page columns; falls back to 'note' /
 *   empty string when absent.
 * - Tags: passed separately so callers don't need to query engine.getTags
 *   if they already have them in hand.
 */
export function serializePageToMarkdown(
  page: Page,
  tags: string[],
  opts: SerializePageOpts = {},
): string {
  const frontmatter: Record<string, unknown> = {
    ...((page.frontmatter ?? {}) as Record<string, unknown>),
    ...(opts.frontmatterOverrides ?? {}),
  };
  return serializeMarkdown(
    frontmatter,
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as PageType) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
}

/**
 * Compute the on-disk path for a (brainDir, slug, source_id) tuple per
 * the v0.32.8 multi-source filing layout:
 *   - Default source: `<brainDir>/<slug>.md`
 *   - Non-default source: `<brainDir>/.sources/<source_id>/<slug>.md`
 *
 * Shared by the dream-cycle reverse-render (`reverseWriteRefs` in
 * synthesize.ts) and the v0.38 put_page write-through path so both
 * sites compute the same path for the same row.
 *
 * NOTE: caller is responsible for validating `source_id` against path-
 * traversal attacks via `validateSourceId` (src/core/utils.ts) BEFORE
 * passing it here. This helper does the filename math only.
 */
export function resolvePageFilePath(
  brainDir: string,
  slug: string,
  sourceId: string,
): string {
  return sourceId === 'default'
    ? join(brainDir, `${slug}.md`)
    : join(brainDir, '.sources', sourceId, `${slug}.md`);
}
