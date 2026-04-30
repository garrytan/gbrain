import { readFileSync, statSync, lstatSync } from 'fs';
import { basename } from 'path';
import { createHash } from 'crypto';
import { marked } from 'marked';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { chunkCodeText, chunkCodeTextFull, detectCodeLanguage, CHUNKER_VERSION } from './chunkers/code.ts';
import { findChunkForOffset } from './chunkers/edge-extractor.ts';
import { extractCodeRefs } from './link-extraction.ts';
import { embedBatch } from './embedding.ts';
import { slugifyPath, slugifyCodePath, isCodeFilePath } from './sync.ts';
import type { ChunkInput, PageType } from './types.ts';

/**
 * v0.20.0 Cathedral II Layer 8 D2 — markdown fence extraction helper.
 *
 * Roughly 40% of gbrain's brain is docs/guides/architecture notes with
 * substantial inline code. In v0.19.0 those fenced code blocks chunk as
 * prose, so querying "how do we import from engine" ranks paragraphs
 * ABOUT the import above the actual import example. D2 walks the marked
 * lexer tokens, extracts each `{type:'code', lang, text}` fence with a
 * known language tag, chunks the content via the code chunker (so TS
 * fence gets TS-aware chunking), and persists those as extra chunks on
 * the parent markdown page with `chunk_source='fenced_code'`.
 *
 * Fence tag → pseudo-extension map. We don't need a full file extension
 * because chunkCodeText only calls detectCodeLanguage to pick a grammar;
 * a recognized extension gets the right grammar loaded, that's all.
 * Unknown tags return null → fence is skipped (no synthetic chunk).
 */
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

/**
 * Maximum code fences we'll extract from a single markdown page. Fence-bomb
 * DOS defense — a malicious markdown file with 10K ```ts blocks could
 * generate 10K chunks × embedding API calls. Override per-page via the
 * `GBRAIN_MAX_FENCES_PER_PAGE` env var if docs-heavy brains legitimately
 * exceed 100 fences on a single page.
 */
const MAX_FENCES_PER_PAGE = Number.parseInt(process.env.GBRAIN_MAX_FENCES_PER_PAGE || '100', 10);

/**
 * Walk the marked lexer output and extract recognizable code fences.
 * Returns one ChunkInput per fence whose language tag maps to a grammar
 * the chunker understands. Unknown tags + empty fences are skipped.
 * Per-fence try/catch: one malformed fence doesn't abort the page import.
 */
async function extractFencedChunks(
  markdown: string,
  startChunkIndex: number,
): Promise<ChunkInput[]> {
  const out: ChunkInput[] = [];
  let tokens: ReturnType<typeof marked.lexer>;
  try {
    tokens = marked.lexer(markdown);
  } catch {
    // marked's lexer errors on truly malformed input — bail, keep the
    // markdown-level chunks that came from compiled_truth.
    return out;
  }

  let fencesSeen = 0;
  let indexOffset = 0;
  for (const tok of tokens) {
    if (tok.type !== 'code') continue;
    const code = tok as { type: 'code'; lang?: string; text?: string };
    const text = (code.text ?? '').trim();
    if (!text) continue;
    if (fencesSeen >= MAX_FENCES_PER_PAGE) {
      console.warn(
        `[gbrain] markdown fence cap hit (${MAX_FENCES_PER_PAGE} fences/page); skipping additional fences. ` +
        `Override via GBRAIN_MAX_FENCES_PER_PAGE env var.`,
      );
      break;
    }
    fencesSeen++;
    const pseudoPath = fenceTagToPseudoPath(code.lang);
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
        `[gbrain] fence extraction failed for lang=${code.lang}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}

/**
 * The parsed page metadata returned by importFromContent. Callers (specifically
 * the put_page operation handler running auto-link post-hook) can reuse this to
 * avoid re-parsing the same content.
 */
export interface ParsedPage {
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}

export interface ImportResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  error?: string;
  /**
   * Parsed page content. Present for status='imported' AND status='skipped'
   * (skip happens when content is identical to existing page; auto-link still
   * needs to run for reconciliation in case links table drifted from page text).
   * Absent only on status='error' (early payload-size rejection).
   */
  parsedPage?: ParsedPage;
}

const MAX_FILE_SIZE = 5_000_000; // 5MB

/**
 * Import content from a string. Core pipeline:
 * parse -> hash -> embed (external) -> transaction(version + putPage + tags + chunks)
 *
 * Used by put_page operation and importFromFile.
 *
 * Size guard: content is rejected if its UTF-8 byte length exceeds MAX_FILE_SIZE.
 * importFromFile already enforces this against disk size before calling here, but
 * the remote MCP put_page operation passes caller-supplied content straight in,
 * so the guard has to live on this function — otherwise an authenticated caller
 * can spend the owner's OpenAI budget at will by shipping a megabyte-sized page.
 */
export async function importFromContent(
  engine: BrainEngine,
  slug: string,
  content: string,
  opts: { noEmbed?: boolean; sourceId?: string } = {},
): Promise<ImportResult> {
  // Reject oversized payloads before any parsing, chunking, or embedding happens.
  // Uses Buffer.byteLength to count UTF-8 bytes the same way disk size would,
  // so the network path behaves identically to the file path.
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_FILE_SIZE) {
    return {
      slug,
      status: 'skipped',
      chunks: 0,
      error: `Content too large (${byteLength} bytes, max ${MAX_FILE_SIZE}). Split the content into smaller files or remove large embedded assets.`,
    };
  }

  const parsed = parseMarkdown(content, slug + '.md');

  // Hash includes ALL fields for idempotency (not just compiled_truth + timeline)
  const hash = createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags.sort(),
    }))
    .digest('hex');

  const parsedPage: ParsedPage = {
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline || '',
    frontmatter: parsed.frontmatter,
    tags: parsed.tags,
  };

  const existing = await engine.getPage(slug, opts.sourceId);
  if (existing?.content_hash === hash) {
    return { slug, status: 'skipped', chunks: 0, parsedPage };
  }

  // Chunk compiled_truth and timeline
  const chunks: ChunkInput[] = [];
  if (parsed.compiled_truth.trim()) {
    for (const c of chunkText(parsed.compiled_truth)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
    }
  }
  if (parsed.timeline?.trim()) {
    for (const c of chunkText(parsed.timeline)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'timeline' });
    }
  }

  // v0.20.0 Cathedral II Layer 8 D2 — extract fenced code blocks from
  // compiled_truth as first-class code chunks.
  if (parsed.compiled_truth.trim()) {
    const fenceChunks = await extractFencedChunks(parsed.compiled_truth, chunks.length);
    chunks.push(...fenceChunks);
  }

  // Embed BEFORE the transaction (external API call).
  // v0.14+ (Codex C2): embedding failure PROPAGATES. Silent drop accumulates
  // unembedded pages invisibly. Caller can pass opts.noEmbed=true to skip.
  if (!opts.noEmbed && chunks.length > 0) {
    const embeddings = await embedBatch(chunks.map(c => c.chunk_text));
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = embeddings[i];
      chunks[i].token_count = Math.ceil(chunks[i].chunk_text.length / 4);
    }
  }

  // Transaction wraps all DB writes
  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(slug, opts.sourceId);

    await tx.putPage(slug, {
      type: parsed.type,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline || '',
      frontmatter: parsed.frontmatter,
      content_hash: hash,
      source_id: opts.sourceId,
    });

    // Tag reconciliation: remove stale, add current
    const existingTags = await tx.getTags(slug, opts.sourceId);
    const newTags = new Set(parsed.tags);
    for (const old of existingTags) {
      if (!newTags.has(old)) await tx.removeTag(slug, old, opts.sourceId);
    }
    for (const tag of parsed.tags) {
      await tx.addTag(slug, tag, opts.sourceId);
    }

    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks, opts.sourceId);
    } else {
      // Content is empty — delete stale chunks so they don't ghost in search results
      await tx.deleteChunks(slug, opts.sourceId);
    }

    // v0.19.0 E1 — doc↔impl linking: if this markdown page cites code paths
    // (e.g. 'src/core/sync.ts:42'), create bidirectional edges to the code
    // page. addLink throws when either endpoint is missing (master tightened
    // this in v0.18.x), so we wrap each pair in try/catch — guides imported
    // before their code repo syncs are common, and the missing edges land
    // later via `gbrain reconcile-links` (Layer 8 D3, v0.21.0).
    const codeRefs = extractCodeRefs(parsed.compiled_truth + '\n' + (parsed.timeline || ''));
    for (const ref of codeRefs) {
      const codeSlug = slugifyCodePath(ref.path);
      // Forward: markdown guide → code page (this guide documents that code)
      try {
        await tx.addLink(
          slug, codeSlug,
          ref.line ? `cited at ${ref.path}:${ref.line}` : ref.path,
          'documents', 'markdown', slug, 'compiled_truth',
        );
      } catch { /* code page not yet imported — reconcile-links will catch it */ }
      // Reverse: code page → markdown guide (this code is documented by the guide)
      try {
        await tx.addLink(
          codeSlug, slug,
          ref.path, 'documented_by', 'markdown', slug, 'compiled_truth',
        );
      } catch { /* same reason — silent skip */ }
    }
  });

  return { slug, status: 'imported', chunks: chunks.length, parsedPage };
}

/**
 * Import from a file path. Validates size, reads content, delegates to importFromContent.
 *
 * Slug authority: the path on disk is the source of truth. `frontmatter.slug`
 * is only accepted when it matches `slugifyPath(relativePath)`. A mismatch is
 * rejected rather than silently honored — otherwise a file at `notes/random.md`
 * could declare `slug: people/elon` in frontmatter and overwrite the legitimate
 * `people/elon` page on the next `gbrain sync` or `gbrain import`. In shared
 * brains where PRs are mergeable, this is a silent page-hijack primitive.
 */
export async function importFromFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: { noEmbed?: boolean; sourceId?: string } = {},
): Promise<ImportResult> {
  // Defense-in-depth: reject symlinks before reading content.
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }

  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `File too large (${stat.size} bytes)` };
  }

  const content = readFileSync(filePath, 'utf-8');

  // Route code files through the code import path
  if (isCodeFilePath(relativePath)) {
    return importCodeFile(engine, relativePath, content, opts);
  }

  const parsed = parseMarkdown(content, relativePath);

  // Enforce path-authoritative slug. parseMarkdown prefers frontmatter.slug over
  // the path-derived slug, so a mismatch here means the frontmatter is trying
  // to rewrite a page whose filesystem location says something different.
  const expectedSlug = slugifyPath(relativePath);
  if (parsed.slug !== expectedSlug) {
    return {
      slug: expectedSlug,
      status: 'skipped',
      chunks: 0,
      error:
        `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" ` +
        `(from ${relativePath}). Remove the frontmatter "slug:" line or move the file.`,
    };
  }

  // Pass the path-derived slug explicitly so that any future change to
  // parseMarkdown's precedence rules cannot re-introduce this bug.
  return importFromContent(engine, expectedSlug, content, opts);
}

/**
 * Import a code file. Bypasses markdown parsing entirely.
 * Uses tree-sitter code chunker for semantic splitting.
 * Page type is 'code', slug includes file extension.
 */
export async function importCodeFile(
  engine: BrainEngine,
  relativePath: string,
  content: string,
  opts: { noEmbed?: boolean; force?: boolean; sourceId?: string } = {},
): Promise<ImportResult> {
  const slug = slugifyCodePath(relativePath);
  const lang = detectCodeLanguage(relativePath) || 'unknown';
  const title = `${relativePath} (${lang})`;

  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_FILE_SIZE) {
    return { slug, status: 'skipped', chunks: 0, error: `Code file too large (${byteLength} bytes)` };
  }

  // Hash for idempotency. CHUNKER_VERSION is folded in so chunker shape
  // changes across releases force clean re-chunks without sync --force.
  const hash = createHash('sha256')
    .update(JSON.stringify({ title, type: 'code', content, lang, chunker_version: CHUNKER_VERSION }))
    .digest('hex');

  const existing = await engine.getPage(slug, opts.sourceId);
  if (!opts.force && existing?.content_hash === hash) {
    return { slug, status: 'skipped', chunks: 0 };
  }

  // Chunk via tree-sitter code chunker. The chunker returns per-chunk
  // metadata (symbol_name, symbol_type, language, start_line, end_line)
  // which we persist as columns so the v0.19.0 query --lang + code-def +
  // code-refs surfaces can filter without parsing chunk_text.
  // v0.20.0 Cathedral II Layer 6 (A3): parent_symbol_path flows through
  // from the chunker (nested methods carry ['ClassName'] etc.) so the
  // chunk-grain FTS trigger picks up scope for ranking and downstream
  // Layer 5 edge resolution can use scope-qualified identity.
  const { chunks: codeChunks, edges: extractedEdges } = await chunkCodeTextFull(content, relativePath);
  const chunks: ChunkInput[] = codeChunks.map((c, i) => ({
    chunk_index: i,
    chunk_text: c.text,
    chunk_source: 'compiled_truth' as const,
    language: c.metadata.language,
    symbol_name: c.metadata.symbolName || undefined,
    symbol_type: c.metadata.symbolType,
    start_line: c.metadata.startLine,
    end_line: c.metadata.endLine,
    parent_symbol_path:
      c.metadata.parentSymbolPath && c.metadata.parentSymbolPath.length > 0
        ? c.metadata.parentSymbolPath
        : undefined,
    symbol_name_qualified: c.metadata.symbolNameQualified || undefined,
  }));

  // v0.19.0 E2 — incremental chunking. Embedding calls dominate the cost
  // of a sync; re-embedding unchanged chunks wastes money without
  // improving retrieval. Look up existing chunks by slug and, for any
  // whose chunk_text exactly matches the new chunk at the same index,
  // reuse the existing embedding. Only truly new/changed chunks hit the
  // OpenAI API. Order matters: our chunk_index is semantic (tree-sitter
  // order), so a matching (chunk_index, text_hash) means a verbatim
  // preserved symbol.
  const existingChunks = existing ? await engine.getChunks(slug, opts.sourceId) : [];
  const existingByKey = new Map<string, typeof existingChunks[number]>();
  for (const ec of existingChunks) {
    existingByKey.set(`${ec.chunk_index}:${ec.chunk_text}`, ec);
  }
  const needsEmbedIndexes: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const key = `${chunks[i]!.chunk_index}:${chunks[i]!.chunk_text}`;
    const matched = existingByKey.get(key);
    if (matched && matched.embedding) {
      // Reuse the existing embedding verbatim. No API call, no cost.
      chunks[i]!.embedding = matched.embedding as Float32Array;
      chunks[i]!.token_count = matched.token_count ?? undefined;
    } else {
      needsEmbedIndexes.push(i);
    }
  }

  // Embed only the new/changed chunks.
  if (!opts.noEmbed && needsEmbedIndexes.length > 0) {
    try {
      const textsToEmbed = needsEmbedIndexes.map((i) => chunks[i]!.chunk_text);
      const embeddings = await embedBatch(textsToEmbed);
      for (let j = 0; j < needsEmbedIndexes.length; j++) {
        const i = needsEmbedIndexes[j]!;
        chunks[i]!.embedding = embeddings[j]!;
        chunks[i]!.token_count = Math.ceil(chunks[i]!.chunk_text.length / 4);
      }
    } catch (e: unknown) {
      console.warn(`[gbrain] embedding failed for code file ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Store
  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(slug, opts.sourceId);

    await tx.putPage(slug, {
      type: 'code' as PageType,
      page_kind: 'code',
      title,
      compiled_truth: content,
      timeline: '',
      frontmatter: { language: lang, file: relativePath },
      content_hash: hash,
      source_id: opts.sourceId,
    });

    await tx.addTag(slug, 'code', opts.sourceId);
    await tx.addTag(slug, lang, opts.sourceId);

    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks, opts.sourceId);
    } else {
      await tx.deleteChunks(slug, opts.sourceId);
    }
  });

  // v0.20.0 Cathedral II Layer 5 (A1): extracted call-site edges persist
  // in code_edges_symbol (unresolved — we don't attempt within-file target
  // resolution here; getCallersOf / getCalleesOf match on to_symbol_qualified
  // which is the callee's short name). Edges land AFTER chunks upsert so
  // chunk IDs are stable.
  if (extractedEdges.length > 0 && chunks.length > 0) {
    try {
      const persistedChunks = await engine.getChunks(slug, opts.sourceId);
      const byIndex = new Map<number, { id?: number; symbol_name_qualified?: string | null; start_line?: number | null; end_line?: number | null }>();
      for (const pc of persistedChunks) {
        byIndex.set(pc.chunk_index, pc);
      }
      // Per-chunk invalidation (codex SP-2): wipe old edges involving
      // chunks whose IDs we know, so re-import doesn't leave stale
      // edges pointing at old symbol names.
      const chunkIds = persistedChunks
        .map(c => c.id)
        .filter((id): id is number => typeof id === 'number');
      if (chunkIds.length > 0) {
        await engine.deleteCodeEdgesForChunks(chunkIds);
      }

      // Build the chunk-range table for offset → chunk-id resolution.
      const rangeList = chunks.map((ch, i) => {
        const persisted = byIndex.get(i);
        return {
          id: persisted?.id as number | undefined,
          startLine: ch.start_line ?? 1,
          endLine: ch.end_line ?? 1,
          symbol_name_qualified: ch.symbol_name_qualified ?? null,
        };
      });

      const edgeInputs: import('./types.ts').CodeEdgeInput[] = [];
      for (const e of extractedEdges) {
        const idx = findChunkForOffset(e.callSiteByteOffset, content, rangeList);
        if (idx == null) continue;
        const from = rangeList[idx]!;
        if (!from.id || !from.symbol_name_qualified) continue;
        edgeInputs.push({
          from_chunk_id: from.id,
          to_chunk_id: null,
          from_symbol_qualified: from.symbol_name_qualified,
          to_symbol_qualified: e.toSymbol,
          edge_type: e.edgeType,
        });
      }

      if (edgeInputs.length > 0) {
        await engine.addCodeEdges(edgeInputs);
      }
    } catch (edgeErr) {
      // Edge persistence is best-effort. A failed addCodeEdges must not
      // fail the overall import — the chunks + embeddings already
      // landed, which is the primary value.
      console.warn(`[gbrain] edge extraction failed for ${slug}: ${edgeErr instanceof Error ? edgeErr.message : String(edgeErr)}`);
    }
  }

  return { slug, status: 'imported', chunks: chunks.length };
}

// Backward compat
export const importFile = importFromFile;
export type ImportFileResult = ImportResult;
