/**
 * citation validator — every paragraph in compiled_truth carries
 * at least one citation marker.
 *
 * "Citation marker" is one of:
 *   - [Source: ...]                        (explicit gbrain citation form)
 *   - [text](https://...) or (http://...)  (inline URL link)
 *   - [Source: [label](url)]               (wrapped form)
 *
 * Paragraphs are separated by one or more blank lines. The validator skips:
 *   - Fenced code blocks (``` ... ``` or ~~~ ... ~~~)
 *   - Inline code (`...`)
 *   - HTML comments (<!-- ... -->)
 *   - Headings (lines starting with #)
 *   - Pure lists of links (e.g. "## See Also" sections)
 *   - Lines that are only bold/italic labels (e.g. "**Status:** Active")
 *   - Quoted blocks starting with > (they inherit the parent paragraph's
 *     citation context; validating each line would be noise)
 *
 * Paragraph-level, not sentence-level: "every factual sentence" is a
 * semantic judgment that blocks legit edits. Paragraph-level is
 * deterministic and still produces "no silent factual claims on brain
 * pages" as the downstream invariant.
 */

import type { PageValidator, PageValidationContext, ValidationFinding } from '../writer.ts';

// `[Source: ...]` must carry non-whitespace content — a bare `[Source:]`
// or `[Source:   ]` is decorative and does not satisfy the citation check.
// The URL form `](https://...)` already requires a non-empty scheme+host.
const CITATION_RE = /\[Source:\s*\S[^\]]*\]|\]\(\s*https?:\/\/[^)]+\)/i;

export const citationValidator: PageValidator = {
  id: 'citation',

  async validate(ctx: PageValidationContext): Promise<ValidationFinding[]> {
    const findings: ValidationFinding[] = [];
    const paragraphs = splitParagraphs(ctx.compiledTruth);

    for (const p of paragraphs) {
      if (!looksFactual(p.stripped)) continue;
      if (CITATION_RE.test(p.stripped)) continue;
      findings.push({
        slug: ctx.slug,
        validator: 'citation',
        severity: 'error',
        line: p.startLine,
        message: `Paragraph has no citation marker: "${truncate(p.stripped, 80)}"`,
      });
    }

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Paragraph {
  /** Text with code/comments/inline-code stripped out. */
  stripped: string;
  /** Original paragraph text (for diagnostic truncation). */
  raw: string;
  /** 1-based line number where paragraph starts. */
  startLine: number;
}

/**
 * Split compiled_truth into paragraphs, dropping content we don't validate.
 * Returns paragraphs with `stripped` = cleaned body (no fences/comments/code).
 */
export function splitParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  const lines = md.split('\n');

  let currentLines: string[] = [];
  let currentStartLine = 1;
  let insideFence = false;
  let fenceMarker = '';

  const flush = (endLine: number) => {
    if (currentLines.length === 0) return;
    const raw = currentLines.join('\n');
    const stripped = stripInlineNoise(raw).trim();
    if (stripped.length > 0) {
      out.push({ stripped, raw, startLine: currentStartLine });
    }
    currentLines = [];
    currentStartLine = endLine + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Fenced code blocks: the fence line itself goes to the paragraph so
    // structure is preserved, but its contents are dropped from validation.
    if (insideFence) {
      if (line.startsWith(fenceMarker)) {
        insideFence = false;
      }
      continue; // drop fenced lines entirely
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      insideFence = true;
      fenceMarker = line.startsWith('```') ? '```' : '~~~';
      // flush current paragraph if any; fences break paragraphs
      flush(i);
      currentStartLine = lineNum + 1;
      continue;
    }

    // Blank line → paragraph boundary
    if (/^\s*$/.test(line)) {
      flush(i);
      currentStartLine = lineNum + 1;
      continue;
    }

    // Accumulate
    if (currentLines.length === 0) currentStartLine = lineNum;
    currentLines.push(line);
  }
  flush(lines.length);

  return out;
}

/**
 * Strip markdown constructs that shouldn't satisfy or fail the citation check:
 *   - Inline code `...`
 *   - HTML comments <!-- ... -->
 */
function stripInlineNoise(s: string): string {
  return s
    // HTML comments (multiline safe via flag)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Inline code
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Heuristic: does this paragraph make a factual claim that should carry a
 * citation? Returns false for:
 *   - Headings (# ... through ###### ...)
 *   - Pure list of wikilinks (## See Also sections)
 *   - Key-value lines ("**Status:** Active")
 *   - Blockquotes (> ...)
 *   - Short labels
 *   - Frontmatter fragments that slipped through
 */
function looksFactual(stripped: string): boolean {
  if (stripped.length === 0) return false;

  // Heading
  if (/^#{1,6}\s/.test(stripped)) return false;

  // Blockquote
  if (/^>/.test(stripped)) return false;

  // Pure key-value line: "**Key:** value" or "Key: value" with no prose after
  if (/^[-*]?\s*\*\*[^*]+:\*\*\s*\S[^.]*$/.test(stripped) && !/\./.test(stripped)) return false;

  // Table rows (|...|)
  if (/^\s*\|.+\|\s*$/.test(stripped)) return false;

  // Bullet of only a wikilink / url: `- [text](path)` with nothing else
  if (/^[-*]\s*\[[^\]]+\]\([^)]+\)\s*$/.test(stripped)) return false;

  // Short labels without a verb-ish word (too noisy to require citations on)
  if (stripped.length < 40 && !/\b(is|was|were|has|have|had|will|would|built|raised|founded|said|wrote|attended|works|joined|left|shipped)\b/i.test(stripped)) return false;

  return true;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}
