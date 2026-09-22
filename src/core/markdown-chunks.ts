import type { ChunkInput } from './types.ts';
import { chunkText } from './chunkers/recursive.ts';
import { chunkCodeText, detectCodeLanguage } from './chunkers/code.ts';
import { sanitizeRemoteBody } from './remote-body.ts';
import { scanFencedBlocks, MAX_FENCES_PER_PAGE } from './fence-scan.ts';
import { isEmbedSkipped } from './embed-skip.ts';
import { isQuarantined } from './quarantine.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';

/** Recognized fence tags select the existing code grammar; unknown tags stay prose. */
const FENCE_TAG_TO_PSEUDO_PATH: Record<string, string> = {
  ts: 'fence.ts', typescript: 'fence.ts',
  tsx: 'fence.tsx',
  js: 'fence.js', javascript: 'fence.js',
  jsx: 'fence.jsx',
  py: 'fence.py', python: 'fence.py',
  rb: 'fence.rb', ruby: 'fence.rb',
  go: 'fence.go', golang: 'fence.go',
  rs: 'fence.rs', rust: 'fence.rs',
  java: 'fence.java',
  'c#': 'fence.cs', cs: 'fence.cs', csharp: 'fence.cs',
  cpp: 'fence.cpp', 'c++': 'fence.cpp',
  c: 'fence.c',
  php: 'fence.php',
  swift: 'fence.swift',
  kt: 'fence.kt', kotlin: 'fence.kt',
  scala: 'fence.scala',
  lua: 'fence.lua',
  ex: 'fence.ex', elixir: 'fence.ex',
  elm: 'fence.elm',
  ml: 'fence.ml', ocaml: 'fence.ml',
  dart: 'fence.dart',
  zig: 'fence.zig',
  sol: 'fence.sol', solidity: 'fence.sol',
  sh: 'fence.sh', bash: 'fence.sh', shell: 'fence.sh', zsh: 'fence.sh',
  css: 'fence.css',
  html: 'fence.html',
  vue: 'fence.vue',
  json: 'fence.json',
  yaml: 'fence.yaml', yml: 'fence.yaml',
  toml: 'fence.toml',
};

function fenceTagToPseudoPath(lang: string | undefined): string | null {
  if (!lang) return null;
  return FENCE_TAG_TO_PSEUDO_PATH[lang.toLowerCase().trim()] ?? null;
}

/** Sanitize the complete body before scanning any fenced code. */
async function extractFencedChunks(
  markdown: string,
  startChunkIndex: number,
): Promise<ChunkInput[]> {
  markdown = sanitizeRemoteBody(markdown);
  const out: ChunkInput[] = [];
  // Fast path: most pages (prose, tables, converted docs) contain no code
  // fence at all, so there is nothing for this function to extract — skip
  // even the line split when no fence marker (``` or ~~~) is present.
  // The `\r` in the line-start class mirrors the scanner's `\r\n|\r → \n`
  // line splitting, so CR/CRLF-only documents don't lose a real fence.
  if (!/(^|[\r\n])[ \t]{0,3}(```|~~~)/.test(markdown)) return out;

  const { fences, capped } = scanFencedBlocks(markdown);
  if (capped) {
    console.warn(
      `[gbrain] markdown fence cap hit (${MAX_FENCES_PER_PAGE} fences/page); skipping additional fences. ` +
      `Override via GBRAIN_MAX_FENCES_PER_PAGE env var.`,
    );
  }

  let indexOffset = 0;
  for (const fence of fences) {
    const text = fence.text.trim();
    if (!text) continue;
    const pseudoPath = fenceTagToPseudoPath(fence.lang);
    if (!pseudoPath) continue; // unknown or missing lang tag → prose fallback
    const lang = detectCodeLanguage(pseudoPath);
    if (!lang) continue;
    try {
      const chunks = await chunkCodeText(text, pseudoPath);
      for (const c of chunks) {
        out.push({
          chunk_index: startChunkIndex + indexOffset++,
          chunk_text: c.text,
          chunk_source: 'fenced_code',
          language: c.metadata.language,
          symbol_name: c.metadata.symbolName || undefined,
          symbol_type: c.metadata.symbolType,
          start_line: c.metadata.startLine,
          end_line: c.metadata.endLine,
        });
      }
    } catch (e: unknown) {
      // One fence failing shouldn't sink the page. Log + continue.
      console.warn(
        `[gbrain] fence extraction failed for lang=${fence.lang}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}


/**
 * Provider-free Markdown projection shared by canonical imports and DB-only
 * rebuilds. The caller owns content/disposition policy and the token limit;
 * chunkers enforce the full-body privacy boundary before splitting. Order and
 * metadata match the importer: truth, timeline, then recognized truth fences.
 */
export async function prepareMarkdownChunks(page: {
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown> | null;
}, maxChunkTokens?: number): Promise<ChunkInput[]> {
  // Both dispositions intentionally have no live chunks, including code.
  if (isEmbedSkipped(page.frontmatter) || isQuarantined(page.frontmatter)) return [];
  const chunks: ChunkInput[] = [];
  const chunkOpts = { maxTokens: maxChunkTokens ?? resolveMaxChunkTokens() };
  if (page.compiled_truth.trim()) {
    for (const c of chunkText(page.compiled_truth, chunkOpts)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
    }
  }
  if (page.timeline?.trim()) {
    for (const c of chunkText(page.timeline, chunkOpts)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'timeline' });
    }
  }
  if (page.compiled_truth.trim()) {
    chunks.push(...await extractFencedChunks(page.compiled_truth, chunks.length));
  }
  return chunks;
}
