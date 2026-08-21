/**
 * Linear (O(lines)) fenced-code-block scanner — the #2862 replacement for the
 * `marked.lexer` full-body walk in import-file.ts. marked's lexer is
 * quadratic on autolink/inline-dense text under bun (a single fence in a
 * 418KB autolink body cost ~50s of lexing; bigger bodies are an OOM class),
 * and fence extraction only ever consumed its top-level `code` tokens. The
 * scanner implements just the CommonMark fence grammar those tokens covered:
 *   - opener: up to 3 spaces of indent, then ``` or ~~~ (3+ chars) + info
 *     string. A backtick opener whose info string contains a backtick is
 *     inline code, not a fence (CommonMark).
 *   - closer: same fence char, at least as long as the opener, nothing but
 *     trailing whitespace. The OTHER fence char never closes it.
 *   - unclosed fence runs to EOF.
 *   - lang = first whitespace-delimited info-string word (```ts title=x → ts).
 *   - opener indentation is stripped from body lines (up to opener depth),
 *     matching CommonMark/marked.
 * Lines are split on /\r\n|\r|\n/ mirroring marked's CR/CRLF normalization.
 */

/**
 * Maximum code fences extracted from a single markdown page. Fence-bomb DOS
 * defense — a malicious markdown file with 10K ```ts blocks could generate
 * 10K chunks × embedding API calls. Override per-page via the
 * `GBRAIN_MAX_FENCES_PER_PAGE` env var if docs-heavy brains legitimately
 * exceed 100 fences on a single page.
 */
export const MAX_FENCES_PER_PAGE = Number.parseInt(
  process.env.GBRAIN_MAX_FENCES_PER_PAGE || '100',
  10,
);

/** A code fence found by the linear scanner: first info-string word + body. */
export interface ScannedFence {
  lang: string | undefined;
  text: string;
}

/** Scan `markdown` for fenced code blocks. Empty-bodied fences are dropped;
 *  collection stops (capped: true) once `maxFences` non-empty fences exist. */
export function scanFencedBlocks(
  markdown: string,
  maxFences: number = MAX_FENCES_PER_PAGE,
): { fences: ScannedFence[]; capped: boolean } {
  const lines = markdown.split(/\r\n|\r|\n/);
  const fences: ScannedFence[] = [];
  const OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const m = OPEN_RE.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const indent = m[1]!.length;
    const marker = m[2]!;
    const fenceChar = marker[0]!;
    const info = m[3]!.trim();
    if (fenceChar === '`' && info.includes('`')) {
      i++; // ```foo`bar``` is inline code, not a fence opener
      continue;
    }
    const bodyLines: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (cm && cm[1]![0] === fenceChar && cm[1]!.length >= marker.length) {
        closed = true;
        break;
      }
      // Strip up to the opener's indentation from body lines (CommonMark).
      if (indent > 0) {
        // CommonMark: strip up to the opener's indentation. `indent` is a
        // bounded number (0-3), so a plain count-and-slice replaces the
        // dynamic RegExp this used to build.
        let strip = 0;
        while (strip < indent && strip < line.length && line[strip] === ' ') strip++;
        bodyLines.push(line.slice(strip));
      } else {
        bodyLines.push(line);
      }
    }
    const text = bodyLines.join('\n');
    if (text.trim()) {
      if (fences.length >= maxFences) {
        return { fences, capped: true };
      }
      fences.push({ lang: info ? info.split(/\s+/)[0] : undefined, text });
    }
    i = closed ? j + 1 : j; // unclosed → j === lines.length → loop exits
  }
  return { fences, capped: false };
}
