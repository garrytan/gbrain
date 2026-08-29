/**
 * #3768 — .svelte/.astro script-region extraction.
 *
 * detectCodeLanguage maps .svelte/.astro to 'html' (the markup half really is
 * html), which used to send the WHOLE file through the recursive fallback
 * chunker: no symbol names, no code edges — code-def/code-callers blind to
 * every component. code.ts uses these helpers to parse the script regions
 * (<script> blocks and the Astro `---` frontmatter fence) with the TS/JS
 * grammar while the markup keeps its html chunks.
 *
 * The load-bearing trick is GEOMETRY-PRESERVING masking: instead of slicing a
 * script region out (which would shift every line number and byte offset), we
 * blank every non-newline character OUTSIDE the region to spaces. The masked
 * string has the same length and the same line structure as the original, so
 * tree-sitter's row numbers and the edge extractor's callSiteByteOffsets are
 * absolute in the real file — no post-hoc offset arithmetic to get wrong.
 */

export interface ComponentScriptRegion {
  /** Index into the original source where the script CODE starts. */
  start: number;
  /** Index one past the end of the script code. */
  end: number;
  /** 1-based line the script code starts on. */
  startLine: number;
  language: 'typescript' | 'javascript';
}

export function isComponentMarkupPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.svelte') || lower.endsWith('.astro');
}

const SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;
const SCRIPT_CLOSE = '</script>';
const LANG_TS_RE = /\blang\s*=\s*["']?(?:ts|typescript)["']?/i;

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/** Astro component script: the `---` fence pair at the very top of the file. */
function matchAstroFence(source: string): ComponentScriptRegion | null {
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) return null;
  const bodyStart = open[0].length;
  const close = /\n---[ \t]*(?:\r?\n|$)/.exec(source.slice(bodyStart));
  if (!close) return null;
  const end = bodyStart + close.index; // exclusive: stops before the \n preceding the closing ---
  if (!source.slice(bodyStart, end).trim()) return null;
  // Astro's component script is TypeScript by default.
  return { start: bodyStart, end, startLine: lineOfIndex(source, bodyStart), language: 'typescript' };
}

/**
 * Find every script region in a .svelte/.astro file, in document order:
 * the Astro fence (astro only) plus each <script ...>…</script> block
 * (svelte instance + module scripts, astro client scripts). Empty and
 * unterminated blocks are skipped.
 */
export function extractComponentScriptRegions(source: string, filePath: string): ComponentScriptRegion[] {
  const regions: ComponentScriptRegion[] = [];
  const lower = filePath.toLowerCase();
  const isAstro = lower.endsWith('.astro');
  if (isAstro) {
    const fence = matchAstroFence(source);
    if (fence) regions.push(fence);
  }
  SCRIPT_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_OPEN_RE.exec(source)) !== null) {
    const codeStart = m.index + m[0].length;
    const close = source.indexOf(SCRIPT_CLOSE, codeStart);
    if (close < 0) break;
    // Astro processes client <script> blocks as TypeScript by default;
    // svelte defaults to javascript unless lang="ts".
    const language = LANG_TS_RE.test(m[0]) || isAstro ? 'typescript' : 'javascript';
    if (source.slice(codeStart, close).trim()) {
      regions.push({ start: codeStart, end: close, startLine: lineOfIndex(source, codeStart), language });
    }
    SCRIPT_OPEN_RE.lastIndex = close + SCRIPT_CLOSE.length;
  }
  return regions;
}

/** Replace every non-newline character with a space (keeps length + lines). */
function blankSpan(text: string): string {
  return text.replace(/[^\n\r]/g, ' ');
}

/**
 * Keep ONE region's text at its original position; blank everything else.
 * Parsing the result with the region's grammar yields absolute line numbers
 * and absolute byte offsets for free.
 */
export function maskOutsideRegion(source: string, region: { start: number; end: number }): string {
  return (
    blankSpan(source.slice(0, region.start)) +
    source.slice(region.start, region.end) +
    blankSpan(source.slice(region.end))
  );
}

/**
 * Blank the given regions' interiors (script code) while keeping the markup —
 * the html half chunks without double-indexing the script text. The <script>
 * tags themselves stay (they sit outside the regions), so the markup remains
 * structurally valid html.
 */
export function maskRegions(source: string, regions: Array<{ start: number; end: number }>): string {
  let out = source;
  for (const r of regions) {
    out = out.slice(0, r.start) + blankSpan(out.slice(r.start, r.end)) + out.slice(r.end);
  }
  return out;
}
