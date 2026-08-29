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
  | 'NON_STRING_FIELD'
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
  /**
   * #1035: true when `type` came from an explicit frontmatter `type:` field,
   * false when it was inferred from the file path (or defaulted to 'concept').
   * Importers use this to preserve an existing page's type on round-trip:
   * explicit frontmatter type is an override; absence means "don't change it".
   */
  typeExplicit?: boolean;
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
 * Byte offset of the first character AFTER the closing frontmatter fence —
 * i.e. where the body starts and where a body-only editor may safely operate
 * without ever touching frontmatter bytes.
 *
 * Fence semantics mirror collectValidationErrors exactly (the canonical
 * definition): leading blank lines are allowed before the opener, fences are
 * matched with trim() so CRLF line endings (`---\r`) count. Returns 0 when the
 * file has no frontmatter at all (first non-empty line is not `---`) — there
 * is no fence to protect, the whole file is body. Returns 0 for an UNCLOSED
 * fence too; callers that must not edit such files should pre-validate with
 * parseMarkdown({validate:true}) and treat MISSING_CLOSE as a blocker (the
 * backlinks fixer does).
 */
export function frontmatterBodyOffset(content: string): number {
  const lines = content.split('\n');

  let offset = 0;
  let i = 0;
  // Skip leading blank lines.
  for (; i < lines.length; i++) {
    if (lines[i].trim().length > 0) break;
    offset += lines[i].length + 1;
  }
  if (i >= lines.length) return 0; // empty / whitespace-only file
  if (lines[i].trim() !== '---') return 0; // no frontmatter

  offset += lines[i].length + 1; // consume the opening fence line
  for (i = i + 1; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    const lineLen = lines[i].length + (isLast ? 0 : 1);
    offset += lineLen;
    if (lines[i].trim() === '---') {
      return Math.min(offset, content.length);
    }
  }
  return 0; // unclosed fence — no safe body offset
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
/**
 * gray-matter's YAML parser treats an unquoted `: ` (colon-space) or a
 * trailing `:` inside a plain scalar value as an ambiguous nested-mapping
 * indicator and fails to parse the ENTIRE leading frontmatter block — not
 * just that one field. This is silent: parseMarkdown catches the error and
 * falls back to empty frontmatter + the whole document as body, which
 * looks exactly like accidental double-frontmatter corruption even though
 * only one (syntactically invalid) block was ever written. The single most
 * common trigger is a raw email/message subject line landing unquoted in
 * `title:` — "Re: ..." is close to universal in reply subjects.
 * See github.com/garrytan/gbrain/issues/3708.
 *
 * Fix: quote any single-line `key: value` frontmatter scalar whose value
 * isn't already quoted, a flow collection (`[...]`/`{...}`), or a block
 * scalar (`|`/`>`), and contains an ambiguous colon, before handing the
 * block to gray-matter. Multi-line values, list items (indented, so they
 * never match the bare `key:` anchor below), and already-safe values are
 * left untouched — this only rescues the exact shape that breaks, so
 * writers (agents, scripts, humans) no longer have to remember to quote
 * colon-bearing titles themselves.
 */
function quoteAmbiguousFrontmatterScalars(content: string): string {
  const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!fenceMatch) return content;
  const fenceBody = fenceMatch[1]!;
  const closer = fenceMatch[2]!;
  const rest = content.slice(fenceMatch[0].length);

  const fixedBody = fenceBody
    .split('\n')
    .map(line => {
      // Top-level `key: value` only — indented lines (list items, nested
      // maps) never match this anchor, so they pass through untouched.
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):[ \t]+(.+)$/);
      if (!kv) return line;
      const key = kv[1]!;
      const value = kv[2]!;
      // Already quoted, a flow collection, or a block-scalar indicator —
      // caller already handled quoting correctly; leave it alone.
      if (/^['"[{|>]/.test(value)) return line;
      // The ambiguous cases gray-matter/js-yaml chokes on: an embedded
      // ": " (looks like a nested mapping key) or a trailing ":".
      if (!value.includes(': ') && !value.endsWith(':')) return line;
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    })
    .join('\n');

  return `---\n${fixedBody}\n---${closer}${rest}`;
}

/**
 * #4526: gray-matter only recognizes a frontmatter fence at byte 0, but the
 * rest of the pipeline (frontmatterBodyOffset above, collectValidationErrors'
 * MISSING_OPEN check below) tolerates leading blank lines before the opener.
 * A content blob with a single leading newline therefore silently lost its
 * whole frontmatter block: empty data, the block left embedded in the body,
 * and the title humanized from the slug — a raw UUID for `fact/<uuid>`
 * pages. Strip leading blank lines when (and only when) the first non-empty
 * line is a fence, so the parse matches what the validators already accept.
 */
function stripLeadingBlanksBeforeFence(content: string): string {
  if (!/^[ \t\r]*\n/.test(content)) return content; // fast path: first line non-blank
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i === 0 || i >= lines.length || lines[i].trim() !== '---') return content;
  return lines.slice(i).join('\n');
}

/**
 * #4526 (second arm): pages already corrupted by the pre-fix parse carry
 * their real frontmatter EMBEDDED at the top of the body (double-frontmatter
 * after a get→put round-trip). When the normal precedence found no title
 * (no frontmatter `title:`, no body H1) and the alternative is humanizing
 * the slug/filename, promote a `title:` from the embedded leading fence
 * block instead. Deliberately last-before-fallback: it never overrides a
 * real title, it only rescues the junk-title case.
 */
function inferTitleFromEmbeddedFrontmatter(body: string): string {
  const m = body.match(/^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return '';
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^title:[ \t]+(.+?)[ \t\r]*$/);
    if (!kv) continue;
    let value = kv[1]!;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return '';
}

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
  //
  // quoteAmbiguousFrontmatterScalars runs unconditionally, not just as an
  // error-path retry: the unquoted-colon case (#3708) doesn't throw a
  // catchable exception here — gray-matter just silently decides there's
  // no valid frontmatter at all (empty data, the whole document as body),
  // so there's no failure signal to react to after the fact. Pre-quoting
  // ambiguous values keeps that input from ever reaching gray-matter in
  // its broken shape.
  // #4526: lift the fence to byte 0 first (leading blank lines are legal per
  // the validators), THEN quote ambiguous scalars (whose regex anchors ^---).
  const safeContent = quoteAmbiguousFrontmatterScalars(stripLeadingBlanksBeforeFence(content));
  let parsed: ReturnType<typeof matter> | null = null;
  let yamlParseError: Error | null = null;
  try {
    parsed = matter(safeContent);
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

  // #1948/#1939: frontmatter values can be non-strings (YAML coerces `title: 123`
  // → number, a bare date → Date). The `as string` cast used to lie: a truthy
  // non-string flowed downstream typed as string and crashed the first
  // `.toLowerCase()` (content-sanity), aborting the whole lint/sync run.
  // coerceFrontmatterString turns a scalar/date into a usable string (a date slug
  // `2024-06-01` is legitimate); the NON_STRING_FIELD lint finding below still
  // surfaces the un-quoted field so it can be cleaned up.
  const explicitType = coerceFrontmatterString(frontmatter.type);
  const type = explicitType || (
    opts?.activePack ? inferTypeFromPack(filePath, opts.activePack) : inferType(filePath)
  );
  // #2446: title precedence is frontmatter `title:` > the body's first H1 >
  // the slug/filename-humanized fallback. Slug-based imports (contacts,
  // calendar) write a correct `# Heading` but no frontmatter title; without
  // the H1 fallback they get junk titles humanized from the slug
  // (`Contact 20170928 5 John Defalco`), which also breaks anything keyed on
  // the title (e.g. the by-mention gazetteer's first-token bucketing).
  // #4526: an embedded leading fence block's `title:` outranks only the
  // humanized-filename fallback — it rescues pages the pre-fix parse left
  // with their frontmatter stuck in the body, without overriding real titles.
  const title =
    coerceFrontmatterString(frontmatter.title).trim() ||
    inferTitleFromBody(body) ||
    inferTitleFromEmbeddedFrontmatter(body) ||
    inferTitle(filePath);
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
    typeExplicit: explicitType !== '',
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

  // 3. MISSING_CLOSE — find the next `---` after the opener.
  let closeLine = -1;
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeLine = i;
      break;
    }
  }
  if (closeLine === -1) {
    // No closing fence found. Surface the first heading-shaped line as a
    // hint for where the parser thinks the frontmatter went off the rails —
    // only useful when the close is genuinely missing, since YAML allows
    // `#` comment lines inside a closed fence (see comment below).
    let headingHint = -1;
    for (let i = firstNonEmpty + 1; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i].trim())) {
        headingHint = i;
        break;
      }
    }
    errors.push({
      code: 'MISSING_CLOSE',
      message:
        headingHint >= 0
          ? `No closing --- before heading at line ${headingHint + 1}`
          : 'No closing --- delimiter found',
      line: headingHint >= 0 ? headingHint + 1 : firstNonEmpty + 1,
    });
    return;
  }
  // Closing fence found. Content between opening and closing is YAML, which
  // permits `#` comment lines anywhere — those are not markdown headings
  // and must not raise MISSING_CLOSE.

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

  const looksLikeFrontmatter = hasFrontmatterFieldSyntax(fmBody);

  // 6. YAML_PARSE — validate the fenced YAML directly. gray-matter normally
  // throws for malformed frontmatter, but it can also return the whole file as
  // body with empty data, so the validation surface must not depend only on
  // gray-matter's parse path. Gate this on frontmatter-shaped fields so a
  // leading Markdown thematic break / epigraph is preserved as body content.
  let detectedYamlParseError = looksLikeFrontmatter ? ctx.yamlParseError : null;
  if (!detectedYamlParseError && looksLikeFrontmatter) {
    try {
      yamlSafeLoad(fmBody);
    } catch (e) {
      detectedYamlParseError = e as Error;
    }
  }
  if (detectedYamlParseError) {
    errors.push({
      code: 'YAML_PARSE',
      message: `YAML parse failed: ${detectedYamlParseError.message}`,
      line: firstNonEmpty + 1,
    });
  }

  // 7. SLUG_MISMATCH — only when expectedSlug was provided and a slug field exists.
  //    #3772: a declared slug whose slugified spelling equals the path-derived
  //    slug is normalization-equivalent (export stamps these to preserve
  //    legacy page identities across a round-trip) — not a mismatch.
  if (ctx.expectedSlug && typeof ctx.parsedFrontmatter.slug === 'string') {
    const declared = ctx.parsedFrontmatter.slug as string;
    if (declared !== ctx.expectedSlug && slugifyPath(declared) !== ctx.expectedSlug) {
      errors.push({
        code: 'SLUG_MISMATCH',
        message: `Frontmatter slug "${declared}" does not match path-derived slug "${ctx.expectedSlug}"`,
      });
    }
  }

  // 8. NON_STRING_FIELD (#1948) — title/type/slug declared as a non-string YAML
  //    scalar (e.g. `title: 123`, `slug: 2024`). The parser coerces title to a
  //    string and falls back to inference for type/slug, but lint surfaces the
  //    malformed frontmatter so it gets fixed rather than silently rewritten.
  //    Pre-fix the slug validator above `typeof`-skipped these, hiding them.
  for (const field of ['title', 'type', 'slug'] as const) {
    const v = ctx.parsedFrontmatter[field];
    if (v != null && typeof v !== 'string') {
      errors.push({
        code: 'NON_STRING_FIELD',
        message: `Frontmatter "${field}" should be a string but is ${typeof v} (${JSON.stringify(v)}); quote the value (e.g. ${field}: "${String(v)}").`,
      });
    }
  }
}

function hasFrontmatterFieldSyntax(fmBody: string): boolean {
  for (const line of fmBody.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (/^(?:['"][^'"]+['"]|[A-Za-z_][\w.-]*)\s*:/.test(trimmed)) {
      return true;
    }
  }
  return false;
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
 *   4. #2225 fallback (no sentinel anywhere): the first bare `## Timeline` /
 *      `## History` heading, outside code fences, with a non-empty prefix,
 *      whose section content (up to the next H2 or EOF) is timeline-shaped —
 *      dated bullets only. Only that section moves to the timeline half (the
 *      heading line is KEPT there — it is content, not a separator); later
 *      unrelated H2 sections stay in compiled_truth. This rescues the naive
 *      MCP get/put reassembly (compiled_truth + '## Timeline' + timeline)
 *      that used to silently bury the whole timeline inside compiled_truth,
 *      WITHOUT eating ordinary wiki pages whose '## History' is prose.
 *
 * A plain `---` line is a markdown horizontal rule, NOT a timeline separator.
 * Treating bare `---` as a separator caused 83% content truncation on wiki corpora.
 */
export function splitBody(body: string): { compiled_truth: string; timeline: string } {
  const lines = body.split('\n');
  const splitIndex = findTimelineSplitIndex(lines);

  if (splitIndex !== -1) {
    const compiled_truth = lines.slice(0, splitIndex).join('\n');
    const timeline = lines.slice(splitIndex + 1).join('\n');
    return { compiled_truth, timeline };
  }

  const section = findBareTimelineSection(lines);
  if (section) {
    return {
      // Only the timeline-shaped section moves; anything from the next H2
      // onward stays in compiled_truth (later unrelated sections survive).
      compiled_truth: lines.slice(0, section.start).concat(lines.slice(section.end)).join('\n'),
      // Heading line kept: it belongs to the timeline content.
      timeline: lines.slice(section.start, section.end).join('\n'),
    };
  }

  return { compiled_truth: body, timeline: '' };
}

/**
 * Line index of the first recognized timeline sentinel, or -1. Exported for
 * the timeline write-through's on-disk splice (timeline-write-through.ts),
 * which must locate the sentinel in raw file text without re-serializing the
 * page. Callers pass BODY lines (after frontmatter — splitBody's own call
 * shape) so the frontmatter's `---` delimiters can't false-positive rule 3.
 */
export function findTimelineSplitIndex(lines: string[]): number {
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
        if (/^##\s+(timeline|history)\s*$/i.test(next)) return i;
        break;
      }
    }
  }
  return -1;
}

/** A timeline entry line: a bullet whose text starts with a 4-digit year
 *  (optionally bolded), e.g. `- 2024-05-01: Series A closed`, `- 2020: Founded`. */
const DATED_BULLET_RE = /^\s*[-*+]\s+\**\d{4}\b/;

/**
 * #2225 fallback scan: the first bare `## Timeline` / `## History` H2 heading
 * with no sentinel before it, GATED on the section actually looking like a
 * timeline — otherwise an ordinary wiki page with a prose '## History'
 * section would lose everything after that heading into the timeline half.
 * A section qualifies only when its content (up to the next H2 or EOF) is
 * dated bullets (`DATED_BULLET_RE`, blank lines and indented bullet
 * continuations allowed) with at least one bullet. Lines inside fenced code
 * blocks (```/~~~) are skipped (same fence tracking as inferTitleFromBody),
 * and a heading with an empty prefix is skipped too — a heading-first body
 * would split into an empty compiled_truth, which is worse than not
 * splitting. Returns the section's [start, end) line range (heading
 * included, next H2 excluded) or null.
 */
function findBareTimelineSection(lines: string[]): { start: number; end: number } | null {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!/^##\s+(timeline|history)\b/i.test(lines[i].trim())) continue;
    const beforeContent = lines.slice(0, i).join('\n').trim();
    if (beforeContent.length === 0) continue;

    // Lookahead: section extent + timeline shape. Any non-blank line that is
    // neither a dated bullet nor a continuation of one (incl. fence openers)
    // disqualifies THIS heading; the outer scan keeps looking for a later one.
    let end = lines.length;
    let datedBullets = 0;
    let shaped = true;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (/^##\s+\S/.test(trimmed)) { end = j; break; }
      if (trimmed.length === 0) continue;
      if (DATED_BULLET_RE.test(lines[j])) { datedBullets++; continue; }
      if (datedBullets > 0 && /^\s{2,}\S/.test(lines[j])) continue; // wrapped bullet
      shaped = false;
      break;
    }
    if (shaped && datedBullets > 0) return { start: i, end };
  }
  return null;
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
  // v0.42.x — Life Chronicle (#2390): timeline events + thought diary.
  { prefixes: ['/life/events/'], type: 'event' },
  { prefixes: ['/life/diary/'], type: 'diary' },
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

/**
 * #2446: derive a title from the body's first ATX H1 (`# Heading`).
 *
 * Returns the trimmed heading text with the leading `# ` and any decorative
 * trailing `#` run stripped, or '' if the body has no H1. Only a SINGLE leading
 * `#` matches — `##`+ (h2 and deeper) are skipped — and lines inside a fenced
 * code block (```/~~~) are ignored so a `# comment` in a shell snippet can't be
 * mistaken for the page title.
 */
function inferTitleFromBody(body: string): string {
  let inFence = false;
  for (const raw of body.split('\n')) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Exactly one leading `#`, then whitespace, then the heading text.
    const m = /^#(?!#)\s+(.+?)\s*$/.exec(raw);
    if (m) return m[1].replace(/\s+#+\s*$/, '').trim();
  }
  return '';
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

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep as pathSep } from 'node:path';

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

/**
 * Map a git-root-relative `pages.source_path` into a source's `local_path`.
 *
 * Scoped syncs keep `source_path` relative to the Git root even when
 * `sources.local_path` points at a subdirectory. A direct join duplicates the
 * scope (`.../public/changelog/public/changelog/...`). Find the same Git root
 * sync uses without spawning a subprocess, then remove that exact scope.
 * Non-Git vaults and Git-root local paths keep the direct path.
 *
 * Returns null for an unsafe or non-markdown source path. Callers must still
 * enforce their normal realpath containment check before a write.
 *
 * Segment splitting is platform-aware (`pathSep`), not a blanket
 * `[\\/]+` split: on POSIX, `\` is a legal filename character (real
 * gbrain data has Apple Notes titles containing one), not a directory
 * separator, so splitting on it there reconstructs a path that doesn't
 * exist on disk even though the file does (issue: undeclared_db_only_pages
 * false positive + silent restore/export failure for any such file). On
 * Windows, `\` is the real separator, so it still needs to split there.
 */
function splitLocalPathSegments(value: string): string[] {
  return (pathSep === '\\' ? value.split(/[\\/]+/) : value.split(/\/+/)).filter(Boolean);
}

export function resolveSourceLocalFilePath(
  localPath: string,
  rawSourcePath: string | null | undefined,
): string | null {
  if (!rawSourcePath) return null;
  const value = rawSourcePath.trim();
  if (!value || value.includes('\0') || !/\.mdx?$/i.test(value)) return null;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const sourceSegments = splitLocalPathSegments(value);
  if (sourceSegments.length === 0 || sourceSegments.some(segment => segment === '..')) return null;

  const absoluteLocalPath = resolve(localPath);
  let cursor = absoluteLocalPath;
  while (true) {
    if (existsSync(join(cursor, '.git'))) {
      const scope = splitLocalPathSegments(relative(cursor, absoluteLocalPath));
      if (scope.length > 0 && scope.every((segment, index) => segment === sourceSegments[index])) {
        return join(absoluteLocalPath, ...sourceSegments.slice(scope.length));
      }
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return join(absoluteLocalPath, ...sourceSegments);
}
