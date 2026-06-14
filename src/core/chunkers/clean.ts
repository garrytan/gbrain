/**
 * Embedding text cleaner.
 *
 * Strips JSON/code/binary noise from chunk text before it is sent to the
 * embedding model. The stored chunk text is never modified — only the string
 * that goes over the wire to the embedding API is cleaned.
 *
 * Controlled by GBRAIN_EMBED_CLEAN (default: "1" = enabled).
 * Set GBRAIN_EMBED_CLEAN=0 to disable and send raw chunk text.
 *
 * What gets stripped:
 *   - Fenced code blocks  (``` ... ```)
 *   - Inline code spans   (`...`)
 *   - JSON object / array blobs (lines that are ≥60% punctuation)
 *   - Base64 / hex / UUID tokens (long runs of hex/alphanum with no spaces)
 *   - XML/HTML tag soup   (<tag ...>...</tag>)
 *   - Repeated symbol lines (lines that are purely punctuation / symbols)
 *   - ANSI escape sequences
 *   - Leading/trailing blank lines; excess internal blank lines collapsed to one
 */

const ENABLED = process.env.GBRAIN_EMBED_CLEAN !== '0';

/** Replace fenced code blocks with a single "[code]" marker. */
function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '[code]');
}

/** Strip inline code spans. */
function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]{1,200}`/g, '');
}

/** Strip XML/HTML tags and their content for known structural tags. */
function stripHtmlTags(text: string): string {
  // Remove structural tags + their content (tool call wrappers, parameter tags)
  let out = text.replace(/<(function_calls|invoke|parameter|antml:[a-z_]+)[\s\S]*?<\/\1>/gi, ' ');
  // Remove remaining self-closing or open/close tags (keep inner text for content tags)
  out = out.replace(/<\/?[a-zA-Z][^>]{0,200}>/g, ' ');
  return out;
}

/** Strip ANSI escape sequences. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Strip tokens that are purely hex, base64, or UUID-like (no whitespace,
 * ≥20 chars). These never contribute semantic meaning to embeddings.
 */
function stripBinaryTokens(text: string): string {
  return text.replace(/\b[a-fA-F0-9\-]{20,}\b/g, '');
}

/**
 * Remove lines that look like JSON structure or symbol noise.
 * A line is "noisy" if any of the following are true:
 *   - It starts/ends with JSON brackets ({ } [ ]) — structural JSON line
 *   - ≥ 55% of its non-space characters are JSON punctuation
 *   - It contains no alphabetic characters (pure symbols/digits)
 *   - It matches a separator pattern (---, ===, ___, ···)
 */
function filterNoisyLines(text: string): string {
  const lines = text.split('\n');
  const clean: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { clean.push(''); continue; }

    const nonSpace = trimmed.replace(/\s/g, '');
    if (nonSpace.length === 0) { clean.push(''); continue; }

    // JSON object/array line: starts with { or [ and ends with } or ]
    if (/^[\[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) continue;

    // Lines containing no alphabetic content
    if (!/[a-zA-Z]/.test(trimmed)) continue;

    // High JSON punctuation density
    const jsonPunct = (nonSpace.match(/[{}\[\]:,"'\\]/g) || []).length;
    const jsonRatio = jsonPunct / nonSpace.length;
    if (jsonRatio >= 0.55) continue;

    // Separator lines like "--- label ---", "=== foo ==="
    if (/^[-=_*~]{2,}\s*\w*\s*[-=_*~]{2,}$/.test(trimmed)) continue;

    clean.push(line);
  }

  return clean.join('\n');
}

/** Collapse 3+ consecutive blank lines to a single blank line. */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Clean chunk text for embedding. Returns the cleaned string.
 * If cleaning produces an empty string, returns the original trimmed text
 * so the embedding call at least has something to work with.
 */
export function cleanForEmbedding(text: string): string {
  if (!ENABLED) return text;

  let out = text;
  out = stripAnsi(out);
  out = stripFencedCode(out);
  out = stripHtmlTags(out);
  out = stripInlineCode(out);
  out = stripBinaryTokens(out);
  out = filterNoisyLines(out);
  out = collapseBlankLines(out);
  out = out.trim();

  // Fallback: never return empty — use original if cleaning wiped everything
  return out.length > 0 ? out : text.trim();
}
