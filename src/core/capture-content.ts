/**
 * Capture content helpers — moved from src/commands/capture.ts in the
 * CLI→MCP gap-closure wave so the `capture` MCP op and the CLI share slug
 * defaulting, dedupe hashing, the binary guard, and the frontmatter merge.
 * (capture.ts statically imports operations.ts, so operations-layer code must
 * never import capture.ts — this module breaks that cycle.) Pure functions;
 * no fs, no engine.
 */

import matter from 'gray-matter';
import { computeContentHash } from './ingestion/types.ts';

/** The subset of capture options the frontmatter/slug helpers consume. */
export interface CaptureFrontmatterOpts {
  type?: string;
  /** Ingestion channel override (CLI --source; ops never set it). */
  source?: string;
  /**
   * Channel label used as the `captured_via` DEFAULT when no user frontmatter
   * or CLI `--source` override is present. Lets a remote MCP caller record
   * `capture-mcp` provenance instead of the local-CLI-implying `capture-cli`.
   * Ordered below `source` so the explicit CLI flag still wins.
   */
  capturedVia?: string;
  // v0.42.x — Life Chronicle (#2390) `--type event` sugar.
  who?: string;
  what?: string;
  where?: string;
  kind?: string;
  depth?: string;
}

// v0.42.x — Life Chronicle (#2390): route the default slug prefix by type so
// `gbrain capture --type diary` lands under life/diary/ and `--type event`
// under life/events/ (matching the chronicle path-prefix inference). Everything
// else keeps the inbox/ default.
export function slugPrefixForType(type?: string): string {
  if (type === 'diary') return 'life/diary';
  if (type === 'event') return 'life/events';
  return 'inbox';
}

export function defaultSlug(content: string, now: Date = new Date(), type?: string): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = computeContentHash(content).slice(0, 8);
  return `${slugPrefixForType(type)}/${y}-${m}-${d}-${hashPrefix}`;
}

/**
 * v0.39.3.0 CV10 — binary file guard. Scans the first 8KB of `buf` for a
 * NUL byte (0x00). Real text files (including UTF-8 with multi-byte CJK,
 * emoji, BOM) never contain a NUL byte at any position — text encoding
 * uses non-zero continuation bytes. NUL appears in binary formats:
 * executables, archives, compressed images, PDFs (after the magic-byte
 * header), most office documents. Single-pass scan; constant memory.
 *
 * Returns the 0-indexed byte offset of the first NUL, or -1 if clean.
 * Caller decides the error shape (message vs JSON envelope).
 *
 * Known limit: a PNG-without-NUL-in-first-8KB slips through. v0.39
 * magic-byte allowlist (per CV10-B + TODOS.md) closes this hole. The
 * 8KB ceiling bounds the scan cost to ~microseconds even on huge files.
 */
export function detectBinaryNullByte(buf: Buffer): number {
  const limit = Math.min(buf.length, 8 * 1024);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return i;
  }
  return -1;
}

/**
 * v0.39.3.0 CV9 — normalize content for content_hash so identical text
 * produces identical hashes regardless of leading/trailing whitespace,
 * line-ending style (CRLF vs LF), or Unicode normalization form. The
 * STORED body is preserved as-is (CRLF stays CRLF, BOM stays BOM).
 *
 * Two concerns, two transforms — the hash gets aggressive normalization
 * for dedup correctness; the stored body keeps user bytes for round-trip
 * fidelity. CQ2's CRLF/BOM preservation tests rely on this split.
 */
export function normalizeForHash(s: string): string {
  // Strip BOM, normalize line endings to LF, trim, NFKC for Unicode-stable hash.
  return s.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim().normalize('NFKC');
}

/**
 * Derive a title from the first non-empty, non-`---` line of the body,
 * stripping leading markdown heading marks, capped at 80 chars. Truncation
 * is codepoint-aware (never splits an astral surrogate pair) and appends an
 * ellipsis so a cut title is visibly cut.
 * Falls back to 'Capture' when no usable line exists.
 */
export function deriveTitle(rawBody: string): string {
  const firstLine = rawBody
    .split('\n')
    .find((l) => l.trim().length > 0 && l.trim() !== '---') ?? '';
  const stripped = firstLine.replace(/^#+\s*/, '');
  const cps = [...stripped];
  return (cps.length > 80 ? cps.slice(0, 79).join('') + '…' : stripped) || 'Capture';
}

// v0.42.x — Life Chronicle (#2390): assemble the `event:` frontmatter block
// from the --who/--what/--where/--kind/--depth flags (only for --type event).
// Returns undefined when no event flags are set so non-event captures are
// untouched.
export function buildEventBlock(opts: CaptureFrontmatterOpts): Record<string, unknown> | undefined {
  if (opts.type !== 'event') return undefined;
  const who = opts.who ? opts.who.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const block: Record<string, unknown> = {};
  if (opts.what) block.what = opts.what;
  if (who.length) block.who = who;
  if (opts.where) block.where = opts.where;
  if (opts.kind) block.kind = opts.kind;
  if (opts.depth) block.depth = opts.depth;
  return Object.keys(block).length ? block : undefined;
}

/**
 * v0.39.3.0 (BUG-1): merge capture's auto-stamped fields with any existing
 * frontmatter in `rawBody`, rather than always prepending a second
 * frontmatter block. The pre-fix code stamped its own `---` block on top
 * of files that already had frontmatter, producing `title: '---'` (the
 * file's opening delimiter became the outer title) and two consecutive
 * frontmatter blocks the parser interpreted as the outer block + a body
 * starting with a horizontal rule.
 *
 * Precedence rules (user-wins by default):
 *   - `type`:         opts.type (CLI flag) > userFm.type > 'note'
 *   - `title`:        userFm.title > derived-from-body
 *   - `captured_via`: userFm.captured_via > opts.source > opts.capturedVia > 'capture-cli'
 *                     (opts.capturedVia is the per-channel default — remote MCP
 *                     captures pass 'capture-mcp' so provenance isn't misreported
 *                     as local CLI; the explicit CLI --source override still wins)
 *   - `captured_at`:  userFm.captured_at > now (user can pre-stamp for retroactive
 *                     captures; see CQ2 test case 4)
 *   - Any other user-declared keys (description, tags, slug, etc.) pass through verbatim.
 *
 * For files WITHOUT existing frontmatter, preserves the original behavior:
 * stamps a fresh frontmatter block, and if the body doesn't already look
 * like markdown (no `#` heading), wraps it under a `# {title}` heading.
 */
export function mergeCaptureFrontmatter(rawBody: string, opts: CaptureFrontmatterOpts): string {
  const nowIso = new Date().toISOString();
  // Detect frontmatter: leading `---\n` or `---\r\n`, tolerating leading BOM/whitespace.
  // We do NOT use the more permissive `startsWith('---')` because a body that opens
  // with a horizontal-rule like `--- separator ---` would false-positive.
  const trimmedStart = rawBody.replace(/^﻿/, '');
  const hasFrontmatter = /^---\r?\n/.test(trimmedStart);

  if (!hasFrontmatter) {
    // No existing frontmatter: stamp a fresh block and (if body lacks markdown
    // structure) wrap under a derived heading.
    const title = deriveTitle(rawBody);
    const fm: Record<string, unknown> = {
      type: opts.type ?? 'note',
      title,
      captured_via: opts.source ?? opts.capturedVia ?? 'capture-cli',
      captured_at: nowIso,
    };
    const ev = buildEventBlock(opts);
    if (ev) fm.event = ev;
    const looksMarkdown = /^#{1,6}\s/.test(rawBody.trimStart());
    const body = looksMarkdown ? rawBody : `# ${title}\n\n${rawBody}`;
    return matter.stringify(body, fm);
  }

  // Existing frontmatter: parse, merge user-wins, re-emit as a SINGLE block.
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawBody);
  } catch (e) {
    throw new Error(
      `malformed frontmatter in capture input: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const userFm = (parsed.data ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    // Spread user's declared keys first so 'description', 'tags', etc. pass through.
    ...userFm,
    // Then apply auto-fields with the precedence rules above. The explicit
    // assignment AFTER the spread is intentional: it lets us implement the
    // mixed precedence (CLI flag wins for `type`; user wins for `title`/
    // `captured_via`/`captured_at`) in one expression per key.
    type: opts.type ?? userFm.type ?? 'note',
    title: userFm.title ?? deriveTitle(parsed.content),
    captured_via: userFm.captured_via ?? opts.source ?? opts.capturedVia ?? 'capture-cli',
    captured_at: userFm.captured_at ?? nowIso,
  };
  // v0.42.x — merge the event block (user-declared keys win per-key).
  const ev = buildEventBlock(opts);
  if (ev || userFm.event) {
    merged.event = { ...(ev ?? {}), ...((userFm.event as Record<string, unknown>) ?? {}) };
  }
  return matter.stringify(parsed.content, merged);
}
