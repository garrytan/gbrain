/**
 * #5812 — Claude Code paste blocks. When a user pastes a block into the
 * Claude Code prompt, the harness records the expanded text in the session
 * transcript wrapped as
 *
 *   <pasted_content id="2830">
 *   …pasted text…
 *   </pasted_content id="2830">
 *
 * (observed on Claude Code 2.1.287; the closing tag repeats the id). This
 * module depends on that harness tag format: if Claude Code changes it, the
 * fixtures in test/transcripts/pasted-content.test.ts stop matching.
 *
 * Pasted text is usually someone else's words (an email, an article, a log),
 * so it must never become a fact about the user. The ONE detector lives here:
 * the writeback gate strips pastes from the banked turn, the transcript
 * parser uses it only to decide whether a user turn is genuine (turn text is
 * never rewritten — recall, the session corpus and transcript ingest keep the
 * paste with its tags), and the fact-extraction lanes strip pastes per user
 * turn before the extractor sees the text. Engine-free, node builtins only:
 * the Stop hook child imports it.
 */

const OPEN = '<pasted_content';
const CLOSE = '</pasted_content';
/** An unclosed paste is stripped to the end of its turn only when the
 * opening tag has the harness's exact attribute shape. */
const HARNESS_OPEN_RE = /^<pasted_content id="[^"<>\r\n]*">$/;
const MAX_TAG_CHARS = 256;

/** Index just past the `>` of a tag whose name ends at `from`, or -1 when the
 * text at `from` does not continue a tag (name boundary, single line). */
function tagEnd(text: string, from: number): number {
  const first = text[from];
  if (first !== '>' && first !== ' ' && first !== '\t') return -1;
  const limit = Math.min(text.length, from + MAX_TAG_CHARS);
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === '>') return i + 1;
    if (c === '<' || c === '\n' || c === '\r') return -1;
  }
  return -1;
}

function findClose(text: string, from: number): number {
  for (let at = text.indexOf(CLOSE, from); at >= 0; at = text.indexOf(CLOSE, at + CLOSE.length)) {
    const end = tagEnd(text, at + CLOSE.length);
    if (end >= 0) return end;
  }
  return -1;
}

/**
 * Remove every paste block (`<pasted_content …>…</pasted_content …>`) from
 * one turn's text, plus an unclosed harness-shaped tail. Each removed block
 * leaves one space so the words around it never merge. `stripped` counts the
 * removed blocks; a malformed tag is left as text.
 */
export function stripPastedContent(text: string): { text: string; stripped: number } {
  if (!text.includes(OPEN)) return { text, stripped: 0 };
  let out = '';
  let pos = 0;
  let stripped = 0;
  let at = text.indexOf(OPEN, pos);
  while (at >= 0) {
    const openEnd = tagEnd(text, at + OPEN.length);
    if (openEnd < 0) {
      at = text.indexOf(OPEN, at + OPEN.length);
      continue;
    }
    const closeEnd = findClose(text, openEnd);
    if (closeEnd >= 0) {
      out += text.slice(pos, at) + ' ';
      pos = closeEnd;
      stripped++;
      at = text.indexOf(OPEN, pos);
      continue;
    }
    if (HARNESS_OPEN_RE.test(text.slice(at, openEnd))) {
      out += text.slice(pos, at) + ' ';
      pos = text.length;
      stripped++;
      break;
    }
    at = text.indexOf(OPEN, openEnd);
  }
  return { text: out + text.slice(pos), stripped };
}

/** True when the text held at least one paste block and nothing else. */
export function isPasteOnly(text: string): boolean {
  const r = stripPastedContent(text);
  return r.stripped > 0 && r.text.trim().length === 0;
}

const CORPUS_BLOCK_RE = /(?:^|\n\n)(?=\[(?:user|assistant)\]\n)/;

/**
 * Strip pastes from session-corpus text (`toCorpusText`'s `[role]\n<text>`
 * blocks) inside each `[user]` block, never across the flattened corpus: an
 * unclosed paste in one turn ends with that turn, so later turns survive.
 * Assistant blocks are unchanged.
 */
export function stripPastedContentFromCorpus(corpus: string): string {
  if (!corpus.includes(OPEN)) return corpus;
  return corpus
    .split(CORPUS_BLOCK_RE)
    .map((block) => {
      if (!block.startsWith('[user]\n') || !block.includes(OPEN)) return block;
      const body = block.slice('[user]\n'.length);
      const trailing = body.endsWith('\n') ? '\n' : '';
      return `[user]\n${stripPastedContent(body).text.trim()}${trailing}`;
    })
    .join('\n\n');
}
