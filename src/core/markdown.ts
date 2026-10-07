import { dataFrontmatter as matter, FrontmatterLanguageError } from './data-frontmatter.ts';
import { load as yamlLoad } from 'js-yaml';
import type { Page, PageType } from './types.ts';
import { resolveSlugForPath, slugifyPath } from './sync.ts';
import {
  commentValueKeys, frontmatterKeyHazard, recoverFrontmatter, unclosedFenceProtectedKey, yamlLocationMessage,
  RECOVERY_VERSION, type FrontmatterRecovery, type RecoveryKind,
} from './frontmatter-recovery.ts';
import { findLineOutsideFencedCode } from './fence-scan.ts';

export {
  recoverFrontmatter, RECOVERY_VERSION, PROTECTED_FRONTMATTER_KEYS, IDENTITY_FRONTMATTER_KEYS,
  type FrontmatterRecovery, type FrontmatterRecoveryStatus, type FrontmatterRecoveryStep, type RecoveryKind,
} from './frontmatter-recovery.ts';

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
  /** YAML_PARSE only: true when ingestion reads the block anyway (quoting only). Producer checks still fail on it. */
  recoverable?: boolean;
  /** YAML_PARSE only: what ingestion changed to read it; content-free, so it can be recorded as provenance. */
  recovery?: Array<{ kind: RecoveryKind; key: string; line: number; recovery_version: number }>;
}

export type ParseWarningCode = 'FRONTMATTER_RECOVERED' | 'FRONTMATTER_COMMENT_VALUE';

/** Advisories that never block ingestion. Local only: `original`/`replacement` carry raw frontmatter text. */
export interface ParseValidationWarning {
  code: ParseWarningCode;
  message: string;
  key: string;
  line: number;
  kind?: RecoveryKind;
  original?: string;
  replacement?: string;
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
  activePack?: { page_types: ReadonlyArray<{
    name: string;
    path_prefixes: ReadonlyArray<string>;
    subtypes?: ReadonlyArray<{
      name: string;
      when: { path_pattern?: string; frontmatter_field?: string; frontmatter_value?: unknown };
    }>;
  }> };
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
  /** Pack rule matched for this path and type; not yet stored in frontmatter. */
  inferredSubtype?: { type: string; name: string };
  title: string;
  tags: string[];
  /** Present iff opts.validate. Empty array means no errors. */
  errors?: ParseValidationError[];
  /** Present iff opts.validate. Never blocks ingestion; `errors` keeps its meaning. */
  warnings?: ParseValidationWarning[];
  /**
   * Present iff opts.validate and the block needed recovery or hides an
   * ambiguous protected or identity key. `classifyImportHold` reads it.
   */
  recovery?: FrontmatterRecovery;
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
function quoteAmbiguousFrontmatterScalars(content: string, quoted?: Array<{ key: string; index: number; original: string; replacement: string }>): string {
  const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!fenceMatch) return content;
  const fenceBody = fenceMatch[1]!;
  const closer = fenceMatch[2]!;
  const rest = content.slice(fenceMatch[0].length);

  const fixedBody = fenceBody
    .split('\n')
    .map((line, index) => {
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
      quoted?.push({ key, index, original: line, replacement: `${key}: "${escaped}"` });
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
 * The YAML block of a fenced document, found as `parseDataFrontmatter` finds
 * it; a BOM and the opening fence stay in `head`, so recovery rewrites only
 * block lines and keeps every line ending. Null for an unclosed fence or a
 * JSON/other language selector. `blockLine` is the block's first file line.
 */
function splitFrontmatterBlock(content: string): { head: string; block: string; tail: string; blockLine: number } | null {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = content.slice(bom.length);
  const opening = /^---([^\r\n]*)(?:\r?\n|$)/.exec(body);
  if (!opening || !['', 'yaml', 'yml'].includes(opening[1]!.trim().toLowerCase())) return null;
  const rest = body.slice(opening[0].length);
  const closing = /^---[\t ]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) return null;
  return { head: bom + opening[0], block: rest.slice(0, closing.index), tail: rest.slice(closing.index), blockLine: 2 };
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
  const lifted = stripLeadingBlanksBeforeFence(content);
  const liftedLines = content.slice(0, content.length - lifted.length).split('\n').length - 1;
  const quoted: Array<{ key: string; index: number; original: string; replacement: string }> = [];
  const safeContent = quoteAmbiguousFrontmatterScalars(lifted, quoted);
  let parsed: ReturnType<typeof matter> | null = null;
  let yamlParseError: Error | null = null;
  let recovery: FrontmatterRecovery | undefined;
  let fenced: ReturnType<typeof splitFrontmatterBlock> | undefined;
  try {
    parsed = matter(safeContent);
  } catch (e) {
    if (e instanceof FrontmatterLanguageError && !opts?.validate) throw e;
    yamlParseError = e as Error;
    // #5988: only a block the strict parse refuses is recovered, so every file
    // that parses today keeps its values. Only quoting is applied here.
    fenced = e instanceof FrontmatterLanguageError ? null : splitFrontmatterBlock(safeContent);
    if (fenced) {
      recovery = recoverFrontmatter(fenced.block, liftedLines + fenced.blockLine - 1);
      if (recovery.status === 'recovered') {
        try { parsed = matter(fenced.head + recovery.block + fenced.tail); } catch { recovery = { ...recovery, status: 'unrecoverable' }; }
      }
    }
  }

  const warnings: ParseValidationWarning[] = [];
  if (opts?.validate) {
    if (fenced === undefined) fenced = splitFrontmatterBlock(safeContent);
    const blockOffset = fenced ? liftedLines + fenced.blockLine - 1 : 0;
    if (parsed && fenced) {
      const block = recovery?.status === 'recovered' ? recovery.block : fenced.block;
      const data = parsed.data as Record<string, unknown>;
      const hazard = frontmatterKeyHazard(block, data, new Set(quoted.map(q => q.key)), blockOffset);
      if (hazard) recovery = { ...(recovery ?? { block, steps: [], recovery_version: RECOVERY_VERSION }), status: hazard.status, key: hazard.key, line: hazard.line };
      for (const found of commentValueKeys(block, data, blockOffset)) {
        warnings.push({ code: 'FRONTMATTER_COMMENT_VALUE', key: found.key, line: found.line,
          message: `Frontmatter "${found.key}" at line ${found.line} starts with # and reads as a YAML comment, so its value is empty; quote the value to keep it.` });
      }
    }
    const recovered = parsed === null ? [] : [
      ...quoted.map(q => ({ kind: 'quote' as const, key: q.key, line: liftedLines + 2 + q.index, original: q.original, replacement: q.replacement })),
      ...(recovery?.steps ?? []),
    ];
    collectValidationErrors(content, errors, {
      yamlParseError,
      expectedSlug: opts.expectedSlug,
      parsedFrontmatter: parsed?.data ?? {},
      recovered,
      recovery,
    });
    // Language selectors do not look like the plain YAML fence expected by
    // structural validation. Keep their rejection visible to ingestion callers.
    if (yamlParseError instanceof FrontmatterLanguageError && !errors.some(error => error.code === 'YAML_PARSE')) {
      errors.push({ code: 'YAML_PARSE', line: 1, message: `YAML parse failed: ${yamlParseError.message}`, recoverable: false });
    }
    if (errors.some(error => error.code === 'YAML_PARSE' && error.recoverable)) {
      for (const step of recovered) {
        warnings.push({ code: 'FRONTMATTER_RECOVERED', key: step.key, line: step.line, kind: step.kind, original: step.original, replacement: step.replacement ?? undefined,
          message: `Frontmatter "${step.key}" at line ${step.line} is not valid YAML; it was read by quoting its value. Quote it in the file.` });
      }
    }
    if (errors.some(error => error.code === 'MISSING_CLOSE')) {
      const lines = content.split('\n');
      const opener = lines.findIndex(line => line.trim().length > 0);
      const unclosed = unclosedFenceProtectedKey(lines.slice(opener + 1), opener + 1);
      if (unclosed) recovery = { block: '', steps: [], recovery_version: RECOVERY_VERSION, status: 'ambiguous_protected_key', key: unclosed.key, line: unclosed.line };
    }
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
  const inferred = opts?.activePack ? inferTypeAndSubtypeFromPack(filePath, opts.activePack, frontmatter) : undefined;
  const type = explicitType || inferred?.type || inferType(filePath);
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
    ...(inferred?.subtype && type === inferred.type ? { inferredSubtype: { type, name: inferred.subtype } } : {}),
    title,
    tags,
  };
  if (opts?.validate) {
    result.errors = errors;
    result.warnings = warnings;
    if (recovery && recovery.status !== 'clean') result.recovery = recovery;
  }
  return result;
}

/** Apply explicit, stored, then pack-inferred subtype precedence. */
export function resolveParsedSubtype(
  parsed: ParsedMarkdown,
  existing?: { type: string; frontmatter?: Record<string, unknown> | null } | null,
): void {
  if (Object.prototype.hasOwnProperty.call(parsed.frontmatter, 'subtype')) return;
  if (existing && parsed.type === existing.type) {
    if (existing.frontmatter && Object.prototype.hasOwnProperty.call(existing.frontmatter, 'subtype')) {
      parsed.frontmatter.subtype = existing.frontmatter.subtype;
      return;
    }
  }
  if (parsed.inferredSubtype?.type === parsed.type) parsed.frontmatter.subtype = parsed.inferredSubtype.name;
}

/**
 * #5988 hold codes: deterministic content refusals. Ingestion holds the one
 * file and keeps going instead of failing the whole sync. Defined once here;
 * managed and legacy sync, import and `validate --importable` share it.
 */
export const HOLD_CODES = ['invalid_frontmatter', 'frontmatter_slug_conflict', 'file_too_large', 'rename_held', 'parser_regression'] as const;
export type HoldCode = typeof HOLD_CODES[number];
export const INVALID_FRONTMATTER_REASONS = ['yaml_parse', 'needs_interpretation', 'ambiguous_identity_key', 'ambiguous_protected_key'] as const;
export type InvalidFrontmatterReason = typeof INVALID_FRONTMATTER_REASONS[number];

export interface ContentHold {
  code: HoldCode;
  reason?: InvalidFrontmatterReason;
  key?: string;
  line?: number;
  /** Safe to persist and show remotely: names the key, line and cause, never a frontmatter value. */
  message: string;
}

/** Markdown over its limit refuses as `Content too large (`; a code file as `Code file too large (`. */
export function contentSizeHold(byteLength: number, maxBytes: number, codeFile = false): ContentHold | null {
  if (byteLength <= maxBytes) return null;
  return { code: 'file_too_large', message: codeFile ? `Code file too large (${byteLength} bytes)`
    : `Content too large (${byteLength} bytes, max ${maxBytes}). Split the content into smaller files or remove large embedded assets.` };
}

const HOLD_GUIDANCE: Record<InvalidFrontmatterReason, string> = {
  yaml_parse: 'Fix that line in the file (quote a value that contains ": " or starts with a special character), then import it again.',
  needs_interpretation: 'Reading it would mean guessing, so it was not imported. Keep one line per key with its whole value quoted on that line, then import it again.',
  ambiguous_identity_key: 'gbrain never guesses which page a file is. Keep exactly one line for that key, then import it again.',
  ambiguous_protected_key: 'gbrain never guesses who may read a page or where it came from. Write that key on its own line with one quoted value, then import it again.',
};

const HOLD_MESSAGE = new RegExp(`^Invalid YAML frontmatter: (?:ambiguous (?:protected|identity) key(?: "[\\w-]{1,100}")? at line \\d+`
  + `|key(?: "[\\w-]{1,100}")? at line \\d+ (?:continues on unquoted lines|appears more than once|opens \\[ or \\{ without closing it)`
  + `|[a-z ;,'-]{1,200}(?: at line \\d+(?:, column \\d+)?)?(?: \\(key "[\\w-]{1,100}"\\))?)\\. `
  + `(?:${Object.values(HOLD_GUIDANCE).map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

/** True for a frontmatter hold message exactly as `classifyImportHold` builds it: key, line and cause only, safe to show. */
export function isFrontmatterHoldMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && HOLD_MESSAGE.test(message);
}

/** A hold message without its key names (keys can be private): line, cause and guidance only, for receipts and remote callers. */
export function frontmatterHoldMessageWithoutKeys(message: string): string {
  return message.replace(/ \(key "[\w-]{1,100}"\)/, '').replace(/key "[\w-]{1,100}"/, 'key');
}

/**
 * Map a validated parse (plus size and path context) to the one hold it
 * earns, or null when ingestion accepts it. Recovered (quoted) YAML, comment
 * values, a missing close, null bytes and nested quotes are not holds.
 */
export function classifyImportHold(parsed: ParsedMarkdown, ctx: {
  byteLength?: number;
  maxBytes?: number;
  codeFile?: boolean;
  expectedSlug?: string | null;
  /** The sync exemption: a page keeping its recorded origin keeps its declared slug. */
  slugExempt?: (declared: string) => boolean;
  slugConflictMessage?: (found: string, expected: string) => string;
} = {}): ContentHold | null {
  const size = ctx.byteLength !== undefined && ctx.maxBytes !== undefined ? contentSizeHold(ctx.byteLength, ctx.maxBytes, ctx.codeFile) : null;
  if (size) return size;
  const recovery = parsed.recovery;
  const yaml = parsed.errors?.find(error => error.code === 'YAML_PARSE' && !error.recoverable);
  let reason: InvalidFrontmatterReason | null = null;
  if (recovery?.status === 'ambiguous_protected_key' || recovery?.status === 'ambiguous_identity_key') reason = recovery.status;
  else if (yaml) reason = recovery?.status === 'needs_interpretation' ? 'needs_interpretation' : 'yaml_parse';
  if (reason) {
    const step = reason === 'needs_interpretation' ? recovery!.steps.find(s => s.kind !== 'quote') : undefined;
    const key = step?.key ?? recovery?.key;
    const line = step?.line ?? recovery?.line ?? yaml?.line;
    const where = `${line !== undefined ? ` at line ${line}` : ''}`;
    const detail = reason === 'ambiguous_protected_key' ? `ambiguous protected key "${key}"${where}`
      : reason === 'ambiguous_identity_key' ? `ambiguous identity key "${key}"${where}`
      : reason === 'needs_interpretation' ? `key "${key}"${where} ${step!.kind === 'dup' ? 'appears more than once' : step!.kind === 'fold' ? 'continues on unquoted lines' : 'opens [ or { without closing it'}`
      : `${(yaml?.message ?? '').replace(/^YAML parse failed:\s*/, '') || 'malformed YAML'}${key ? ` (key "${key}")` : ''}`;
    return { code: 'invalid_frontmatter', reason, ...(key ? { key } : {}), ...(line !== undefined ? { line } : {}),
      message: `Invalid YAML frontmatter: ${detail}. ${HOLD_GUIDANCE[reason]}` };
  }
  const expected = ctx.expectedSlug;
  if (expected && parsed.slug !== expected && slugifyPath(parsed.slug) !== expected && !ctx.slugExempt?.(parsed.slug)) {
    return { code: 'frontmatter_slug_conflict', key: 'slug',
      message: ctx.slugConflictMessage?.(parsed.slug, expected) ?? `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expected}".` };
  }
  return null;
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
    /** What ingestion changed to read the block; empty when it could not be read. */
    recovered: ReadonlyArray<{ kind: RecoveryKind; key: string; line: number }>;
    recovery?: FrontmatterRecovery;
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
  if (!/^---(?:\s*(?:yaml|yml|json))?\s*$/i.test(lines[firstNonEmpty].trim())) {
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

  // #6157: parse the whole block once. The per-line NESTED_QUOTES heuristic
  // below only runs when the block fails to parse; a block-scalar
  // continuation line that looks like `Key: "a", "b"` is valid YAML. A block
  // over the alias limit counts as not parsing (the heuristics apply).
  const blockParseError = yamlBlockError(fmBody);
  const blockParses = blockParseError === null && yamlAliasesWithinLimit(fmBody);

  // 5. NESTED_QUOTES — common breakage pattern: `title: "Name "Nick" Last"`.
  //    The heuristic: a frontmatter `key: value` line with 3+ unescaped
  //    double-quote characters is suspicious. But raw quote-counting is
  //    too dumb: a YAML flow sequence like `tags: ["yc", "w2025"]` has
  //    4 unescaped `"` by design (valid), and a single-quoted scalar
  //    like `title: 'a: "b" "c"'` has literal inner `"` (also valid).
  //    Disambiguate by running js-yaml on just the value; only flag
  //    lines that genuinely fail to parse. The full-frontmatter YAML
  //    parse error is caught separately by check 6 (YAML_PARSE) below.
  for (let i = firstNonEmpty + 1; !blockParses && i < closeLine; i++) {
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
      yamlLoad(value);
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
  const detectedYamlParseError = looksLikeFrontmatter ? (ctx.yamlParseError ?? blockParseError) : null;
  if (detectedYamlParseError) {
    // #5988: location only. js-yaml's own message quotes the document, and
    // this text reaches receipts, sync results and remote callers.
    const located = yamlFailureLocation(lines.slice(firstNonEmpty + 1, closeLine).join('\n'), firstNonEmpty + 1);
    const recoverable = ctx.recovered.length > 0;
    const reason = detectedYamlParseError.name === 'FrontmatterLanguageError' ? detectedYamlParseError.message
      : yamlLocationMessage(located?.reason ?? 'malformed YAML', located?.line ?? ctx.recovery?.line, located?.column);
    errors.push({
      code: 'YAML_PARSE',
      message: `YAML parse failed: ${reason}`,
      line: ctx.recovery?.line ?? (recoverable ? ctx.recovered[0]!.line : located?.line) ?? firstNonEmpty + 1,
      recoverable,
      ...(recoverable ? { recovery: ctx.recovered.map(step => ({ kind: step.kind, key: step.key, line: step.line, recovery_version: RECOVERY_VERSION })) } : {}),
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

/**
 * Most YAML aliases (`*name`) a frontmatter block may hold before the #6157
 * whole-block checks treat it as not parsing. Frontmatter is untrusted: a few
 * hundred bytes of nested `&a [*b, *b]` anchors expand exponentially once the
 * parsed value is walked (compared, stringified). Real frontmatter rarely
 * uses aliases at all.
 */
export const MAX_FRONTMATTER_YAML_ALIASES = 16;

/** False when the text holds more than MAX_FRONTMATTER_YAML_ALIASES aliases outside quoted strings. */
export function yamlAliasesWithinLimit(text: string): boolean {
  const unquoted = text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'/g, '');
  let count = 0;
  for (const _ of unquoted.matchAll(/(?:^|[\s,[{])\*[^\s,[\]{}]/g)) if (++count > MAX_FRONTMATTER_YAML_ALIASES) return false;
  return true;
}

/** The js-yaml error for a frontmatter block, or null when the whole block parses. */
export function yamlBlockError(block: string): Error | null {
  try {
    yamlLoad(block);
    return null;
  } catch (e) {
    return e as Error;
  }
}

/** Where js-yaml refuses a raw block: its reason phrase and the file line and column. */
function yamlFailureLocation(block: string, lineOffset: number): { reason: string; line: number; column: number } | null {
  try {
    yamlLoad(block);
    return null;
  } catch (e) {
    const err = e as { reason?: string; mark?: { line?: number; column?: number } };
    if (typeof err.mark?.line !== 'number') return null;
    return { reason: err.reason ?? 'malformed YAML', line: lineOffset + err.mark.line + 1, column: (err.mark.column ?? 0) + 1 };
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
  // A sentinel quoted inside a fenced code block (a markdown example) is not
  // a separator. Mispaired fences (see MarkdownCodeMap) leave every candidate
  // live, as before.
  return findLineOutsideFencedCode(lines, (i) => isTimelineSentinelLine(lines, i));
}

function isTimelineSentinelLine(lines: string[], i: number): boolean {
  const trimmed = lines[i].trim();

  if (trimmed === '<!-- timeline -->' || trimmed === '<!--timeline-->') {
    return true;
  }

  if (trimmed === '--- timeline ---' || /^---\s+timeline\s+---$/i.test(trimmed)) {
    return true;
  }

  if (trimmed === '---') {
    const beforeContent = lines.slice(0, i).join('\n').trim();
    if (beforeContent.length === 0) return false;

    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (next.length === 0) continue;
      return /^##\s+(timeline|history)\s*$/i.test(next);
    }
  }
  return false;
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
    if (st.when.frontmatter_field !== undefined && frontmatter !== undefined) {
      const value = frontmatter[st.when.frontmatter_field];
      if (st.when.frontmatter_value !== undefined && value === st.when.frontmatter_value) {
        return { type: typeName, subtype: st.name };
      }
    }
  }
  for (const st of subtypes) {
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
  return filename.replace(/[-_]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()) || 'Untitled';
}

function inferSlug(filePath?: string): string {
  if (!filePath) return 'untitled';
  return slugifyPath(filePath);
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags;
  if (!tags) return [];
  // Only scalar items are tags: stringifying a nested array would expand a YAML alias bomb.
  if (Array.isArray(tags)) return tags.filter(t => t instanceof Date || (t !== null && typeof t !== 'object')).map(String);
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
 * Non-Git vaults and Git-root local paths keep the direct path. Under
 * `slugRootMode: 'source-root'` the stored path is already source-relative, so
 * the scope is removed only from the legacy Git-root form write-through minted
 * from the slug (its scope-stripped path names `pageSlug`, #5610). Historical
 * rows may carry a basename-relative `source_path`; when the direct path is
 * absent and the caller provides the page slug, resolve that spelling under
 * the slug's directory before reporting the file as missing.
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

function safeSlugDirSegments(rawSlug: string | null | undefined): string[] | null {
  if (!rawSlug) return null;
  const value = rawSlug.trim();
  if (!value || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const segments = splitLocalPathSegments(value);
  if (segments.length === 0 || segments.some(segment => segment === '..')) return null;
  return segments.slice(0, -1);
}

export function resolveSourceLocalFilePath(
  localPath: string,
  rawSourcePath: string | null | undefined,
  pageSlug?: string | null,
  slugRootMode?: 'git-root' | 'source-root',
): string | null {
  if (!rawSourcePath) return null;
  const value = rawSourcePath.trim();
  if (!value || value.includes('\0') || !/\.mdx?$/i.test(value)) return null;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const sourceSegments = splitLocalPathSegments(value);
  if (sourceSegments.length === 0 || sourceSegments.some(segment => segment === '..')) return null;

  const absoluteLocalPath = resolve(localPath);
  let sourceScopeSegments: string[] = [];
  let resolvedSegments = sourceSegments;
  let cursor = absoluteLocalPath;
  while (true) {
    if (existsSync(join(cursor, '.git'))) {
      const scope = splitLocalPathSegments(relative(cursor, absoluteLocalPath));
      sourceScopeSegments = scope;
      const scoped = scope.length > 0 && scope.every((segment, index) => segment === sourceSegments[index]);
      if (scoped && (slugRootMode !== 'source-root'
        || !!pageSlug && resolveSlugForPath(sourceSegments.slice(scope.length).join('/')) === pageSlug)) {
        resolvedSegments = sourceSegments.slice(scope.length);
      }
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const directPath = join(absoluteLocalPath, ...resolvedSegments);
  if (existsSync(directPath)) return directPath;

  const slugDirSegments = safeSlugDirSegments(pageSlug);
  if (sourceSegments.length === 1 && slugDirSegments && slugDirSegments.length > 0) {
    const scopedSlugDir =
      slugRootMode !== 'source-root' && sourceScopeSegments.length > 0 &&
      sourceScopeSegments.every((segment, index) => segment === slugDirSegments[index])
        ? slugDirSegments.slice(sourceScopeSegments.length)
        : slugDirSegments;
    const slugRelativePath = join(absoluteLocalPath, ...scopedSlugDir, ...sourceSegments);
    if (existsSync(slugRelativePath)) return slugRelativePath;
  }

  return directPath;
}

/**
 * A `file://` URI whose authority is neither empty, `localhost` nor a Windows
 * drive (`file://C:/...`): the relative path an older file capture stored
 * as typed (#5622), or a host-only alias. It names no local file, so readers treat it as absent.
 */
export function isRelativeFileUri(sourceUri: string | null | undefined): boolean {
  return typeof sourceUri === 'string' && /^file:\/\/(?!\/|localhost\/|[A-Za-z]:[\\/])/i.test(sourceUri);
}
