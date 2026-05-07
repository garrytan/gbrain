import { readFileSync, statSync, lstatSync } from 'fs';
import { basename, extname } from 'path';
import { createHash } from 'crypto';
import { marked } from 'marked';
import type { BrainEngine, FileSpec } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { chunkCodeText, chunkCodeTextFull, detectCodeLanguage, CHUNKER_VERSION } from './chunkers/code.ts';
import { findChunkForOffset } from './chunkers/edge-extractor.ts';
import { extractCodeRefs, imageOfCandidates } from './link-extraction.ts';
import { embedBatch, embedMultimodal } from './embedding.ts';
import { slugifyPath, slugifyCodePath, isCodeFilePath } from './sync.ts';
import type { ChunkInput, PageInput, PageType } from './types.ts';
import { computeEffectiveDate } from './effective-date.ts';

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
  opts: {
    noEmbed?: boolean;
    sourceId?: string;
    /**
     * v0.29.1: basename without extension for filename-date precedence on
     * `daily/`, `meetings/` slugs. importFromFile threads this from the
     * disk path; the put_page MCP op derives it from the slug tail.
     */
    filename?: string;
  } = {},
): Promise<ImportResult> {
  // v0.18.0+ multi-source: when caller is syncing under a non-default source,
  // every per-page tx call must carry `sourceId` so writes target the right
  // (source_id, slug) row. Pre-fix, putPage relied on the schema DEFAULT and
  // silently fabricated a duplicate at (default, slug) — causing later
  // bare-slug subqueries (getTags, deleteChunks, etc.) to crash with 21000.
  const sourceId = opts.sourceId;
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

  const existing = await engine.getPage(slug, sourceId ? { sourceId } : undefined);
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

  // Transaction wraps all DB writes. Every per-page tx call carries the
  // caller's sourceId so writes target (sourceId, slug) rather than the
  // schema DEFAULT — required for multi-source brains; harmless ('default')
  // for single-source callers.
  const txOpts = sourceId ? { sourceId } : undefined;
  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(slug, txOpts);

    // v0.29.1 — compute effective_date from frontmatter precedence chain.
    // Filename comes from importFromFile path (basename) or the slug tail
    // (put_page MCP op fallback). updatedAt/createdAt use the existing
    // page's timestamps when present; otherwise NOW() (the row about to
    // be created). The result drives the recency boost and since/until
    // filters when callers opt in; nothing in the default search path
    // consults it.
    const filenameForChain = opts.filename ?? slug.split('/').pop() ?? slug;
    const nowDate = new Date();
    const { date: effectiveDate, source: effectiveDateSource } = computeEffectiveDate({
      slug,
      frontmatter: parsed.frontmatter,
      filename: filenameForChain,
      updatedAt: existing?.updated_at ?? nowDate,
      createdAt: existing?.created_at ?? nowDate,
    });

    await tx.putPage(slug, {
      type: parsed.type,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline || '',
      frontmatter: parsed.frontmatter,
      content_hash: hash,
      effective_date: effectiveDate,
      effective_date_source: effectiveDateSource,
      import_filename: filenameForChain,
    }, txOpts);

    // Tag reconciliation: remove stale, add current
    const existingTags = await tx.getTags(slug, txOpts);
    const newTags = new Set(parsed.tags);
    for (const old of existingTags) {
      if (!newTags.has(old)) await tx.removeTag(slug, old, txOpts);
    }
    for (const tag of parsed.tags) {
      await tx.addTag(slug, tag, txOpts);
    }

    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks, txOpts);
    } else {
      // Content is empty — delete stale chunks so they don't ghost in search results
      await tx.deleteChunks(slug, txOpts);
    }

    // v0.19.0 E1 — doc↔impl linking: if this markdown page cites code paths
    // (e.g. 'src/core/sync.ts:42'), create bidirectional edges to the code
    // page. addLink throws when either endpoint is missing (master tightened
    // this in v0.18.x), so we wrap each pair in try/catch — guides imported
    // before their code repo syncs are common, and the missing edges land
    // later via `gbrain reconcile-links` (Layer 8 D3, v0.21.0).
    const codeRefs = extractCodeRefs(parsed.compiled_truth + '\n' + (parsed.timeline || ''));
    // For doc↔impl edges, both endpoints are within the same source as the
    // markdown page being imported. Cross-source edges (markdown in one
    // source, code in another) currently fail with "page not found" — a
    // faster failure mode than the pre-fix cross-product fan-out, which
    // silently wired edges to whichever same-slug page Postgres returned
    // first across sources.
    const linkOpts = sourceId
      ? { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId }
      : undefined;
    for (const ref of codeRefs) {
      const codeSlug = slugifyCodePath(ref.path);
      // Forward: markdown guide → code page (this guide documents that code)
      try {
        await tx.addLink(
          slug, codeSlug,
          ref.line ? `cited at ${ref.path}:${ref.line}` : ref.path,
          'documents', 'markdown', slug, 'compiled_truth',
          linkOpts,
        );
      } catch { /* code page not yet imported — reconcile-links will catch it */ }
      // Reverse: code page → markdown guide (this code is documented by the guide)
      try {
        await tx.addLink(
          codeSlug, slug,
          ref.path, 'documented_by', 'markdown', slug, 'compiled_truth',
          linkOpts,
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
  opts: { noEmbed?: boolean; inferFrontmatter?: boolean; sourceId?: string } = {},
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

  let content = readFileSync(filePath, 'utf-8');

  // Route code files through the code import path
  if (isCodeFilePath(relativePath)) {
    return importCodeFile(engine, relativePath, content, {
      noEmbed: opts.noEmbed,
      sourceId: opts.sourceId,
    });
  }

  // v0.22.8 — Frontmatter inference: if the file has no frontmatter and
  // inference is enabled, synthesize it from the filesystem path + content.
  // This turns bare markdown files into fully-typed, dated, tagged pages
  // without requiring the user to manually add YAML headers.
  // The inference is applied to the in-memory content only; the file on disk
  // is not modified. Use `gbrain frontmatter generate --fix` to write back.
  if (opts.inferFrontmatter !== false) {
    const { applyInference } = await import('./frontmatter-inference.ts');
    const { content: inferred, inferred: meta } = applyInference(relativePath, content);
    if (!meta.skipped) {
      content = inferred;
    }
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
  // v0.29.1: thread the basename (without extension) for filename-date
  // precedence in computeEffectiveDate. e.g. `daily/2024-03-15.md` →
  // filename `2024-03-15`.
  const fileBasename = basename(relativePath, '.md');
  return importFromContent(engine, expectedSlug, content, { ...opts, filename: fileBasename });
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
  const sourceId = opts.sourceId;
  const txOpts = sourceId ? { sourceId } : undefined;

  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_FILE_SIZE) {
    return { slug, status: 'skipped', chunks: 0, error: `Code file too large (${byteLength} bytes)` };
  }

  // Hash for idempotency. CHUNKER_VERSION is folded in so chunker shape
  // changes across releases force clean re-chunks without sync --force.
  const hash = createHash('sha256')
    .update(JSON.stringify({ title, type: 'code', content, lang, chunker_version: CHUNKER_VERSION }))
    .digest('hex');

  const existing = await engine.getPage(slug, sourceId ? { sourceId } : undefined);
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
  const existingChunks = existing ? await engine.getChunks(slug, sourceId ? { sourceId } : undefined) : [];
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

  // Store. Every per-page tx call carries `txOpts.sourceId` so multi-source
  // brains write to the correct (source_id, slug) row instead of duplicating
  // under the schema DEFAULT.
  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(slug, txOpts);

    await tx.putPage(slug, {
      type: 'code' as PageType,
      page_kind: 'code',
      title,
      compiled_truth: content,
      timeline: '',
      frontmatter: { language: lang, file: relativePath },
      content_hash: hash,
    }, txOpts);

    await tx.addTag(slug, 'code', txOpts);
    await tx.addTag(slug, lang, txOpts);

    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks, txOpts);
    } else {
      await tx.deleteChunks(slug, txOpts);
    }
  });

  // v0.20.0 Cathedral II Layer 5 (A1): extracted call-site edges persist
  // in code_edges_symbol (unresolved — we don't attempt within-file target
  // resolution here; getCallersOf / getCalleesOf match on to_symbol_qualified
  // which is the callee's short name). Edges land AFTER chunks upsert so
  // chunk IDs are stable.
  if (extractedEdges.length > 0 && chunks.length > 0) {
    try {
      const persistedChunks = await engine.getChunks(slug, sourceId ? { sourceId } : undefined);
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

// ============================================================
// v0.27.1 multimodal: image-file ingestion (Phase 8 / Sec5 / F2 / Eng-1C)
// ============================================================

/**
 * v0.27.1: image extension allow-list. PNG/JPG/JPEG/GIF/WEBP are universal
 * codecs that don't need decoding before embedding (we send raw bytes).
 * HEIC/HEIF/AVIF need WASM decode to JPEG before Voyage will accept them.
 *
 * Other variants (BMP, TIFF, etc.) intentionally left out — they're rare in
 * the kinds of brains gbrain serves and adding them would expand the WASM
 * decode surface meaningfully.
 */
export const SUPPORTED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif'] as const;

/** Voyage caps each multimodal input at 20MB. We honor that as the size limit. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Extensions that need WASM decode before Voyage embedding. */
const NEEDS_DECODE = new Set(['.heic', '.heif', '.avif']);

/**
 * Phase 8 / Sec5 (DRY refactor): shared transaction wrapper for the markdown
 * + image import paths. Idempotent on content_hash (the caller skips when
 * existing.content_hash === hash, before calling here).
 *
 * Does NOT include type-specific work (tag reconciliation for markdown,
 * code-ref edges, EXIF auto-link for images). Callers compose those on top
 * via the optional `after` callback, which runs INSIDE the same transaction.
 */
export interface ImportTransactionSpec {
  slug: string;
  hadExisting: boolean;
  page: PageInput;
  /** When undefined, no chunk write happens. When [], deletes any prior chunks. */
  chunks?: ChunkInput[];
  /** Optional file-row insert (image ingest). Page link injected automatically. */
  file?: FileSpec;
  /** Inside-transaction hook for type-specific work (tags, links). */
  after?: (tx: BrainEngine) => Promise<void>;
}

export async function withImportTransaction(
  engine: BrainEngine,
  spec: ImportTransactionSpec,
): Promise<void> {
  await engine.transaction(async (tx) => {
    if (spec.hadExisting) await tx.createVersion(spec.slug);
    await tx.putPage(spec.slug, spec.page);
    if (spec.file) {
      // page_id resolution after putPage so the new row's id is available.
      const stored = await tx.getPage(spec.slug);
      await tx.upsertFile({
        ...spec.file,
        page_slug: spec.slug,
        page_id: stored?.id ?? null,
      });
    }
    if (spec.chunks !== undefined) {
      if (spec.chunks.length > 0) {
        await tx.upsertChunks(spec.slug, spec.chunks);
      } else {
        await tx.deleteChunks(spec.slug);
      }
    }
    if (spec.after) await spec.after(tx);
  });
}

/**
 * Eng-1C: pure-JS p-limit semaphore so OCR calls run with bounded
 * concurrency without pulling in a new dep. Returns a function that, when
 * called, returns a Promise that resolves when the wrapped function resolves
 * AND the semaphore slot has been released.
 *
 * Used by importImageFile to parallelize OCR (typically ~2s/image) at
 * concurrency 8. Without this, 100 images = 200s wall time of sequential OCR.
 * With this, 100 images = ~25s.
 */
export function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function next() {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/**
 * Decode HEIC/AVIF bytes to a re-encoded JPEG buffer that Voyage accepts.
 * Pre-loads the WASM via the bun-compile-safe pattern proven in Phase 1's
 * scripts/check-image-decoders-embedded.sh. PNG/JPG/JPEG/GIF/WEBP pass
 * through unchanged.
 */
async function decodeIfNeeded(ext: string, buf: Buffer): Promise<{ buf: Buffer; mime: string }> {
  if (ext === '.heic' || ext === '.heif') {
    // heic-decode bundles libheif via base64 — works in bun --compile
    // out of the box. Returns RGBA pixel buffer + dims.
    const heicDecode = (await import('heic-decode')).default;
    const decoded = await heicDecode({ buffer: buf });
    const encodePng = (await import('@jsquash/png/encode.js')).default;
    const pngBytes = await encodePng({
      data: new Uint8ClampedArray(decoded.data),
      width: decoded.width,
      height: decoded.height,
    });
    return { buf: Buffer.from(pngBytes), mime: 'image/png' };
  }
  if (ext === '.avif') {
    // @jsquash/avif loads its WASM relative to its own JS file, which fails
    // inside a bun --compile VFS. Pre-init via the path imported with
    // `with { type: 'file' }` (proven in scripts/check-image-decoders-embedded.sh).
    const avifWasmModule = await import('@jsquash/avif/codec/dec/avif_dec.wasm', { with: { type: 'file' } });
    const avifMod = await import('@jsquash/avif/decode.js');
    const wasmBytes = readFileSync((avifWasmModule as { default: string }).default);
    // WebAssembly.compile expects ArrayBuffer; Buffer.buffer is ArrayBufferLike
    // (Bun typing). Slice gives a fresh ArrayBuffer view.
    const wasmAB = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) as ArrayBuffer;
    const wasmModule = await WebAssembly.compile(wasmAB);
    await avifMod.init(wasmModule);
    // @jsquash/avif's decode is typed against ArrayBuffer.
    const inputAB = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const decoded = await avifMod.default(inputAB);
    if (!decoded) {
      throw new Error('avif decode returned null');
    }
    const encodePng = (await import('@jsquash/png/encode.js')).default;
    const pngBytes = await encodePng({
      data: new Uint8ClampedArray(decoded.data),
      width: decoded.width,
      height: decoded.height,
    });
    return { buf: Buffer.from(pngBytes), mime: 'image/png' };
  }
  // Universal codecs: pass-through.
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return { buf, mime: mimeMap[ext] ?? 'application/octet-stream' };
}

/** EXIF metadata stamped onto image-page frontmatter (cherry-2). */
async function readExifSafe(buf: Buffer): Promise<Record<string, unknown>> {
  try {
    const exifr = (await import('exifr')).default;
    const data = (await exifr.parse(buf)) as Record<string, unknown> | undefined;
    if (!data) return {};
    const out: Record<string, unknown> = {};
    if (data.DateTimeOriginal instanceof Date) {
      out.captured_at = data.DateTimeOriginal.toISOString();
    } else if (typeof data.CreateDate === 'string') {
      out.captured_at = data.CreateDate;
    }
    if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
      out.gps = { lat: data.latitude, lon: data.longitude };
    }
    if (typeof data.Make === 'string' || typeof data.Model === 'string') {
      out.camera = `${data.Make ?? ''} ${data.Model ?? ''}`.trim();
    }
    if (typeof data.ExifImageWidth === 'number' && typeof data.ExifImageHeight === 'number') {
      out.dims = { w: data.ExifImageWidth, h: data.ExifImageHeight };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Cherry-1 OCR: optional gpt-4o-mini pass extracting visible text from an
 * image. Returns '' when:
 * - the embedding_image_ocr config flag is off (default)
 * - the configured expansion model is unavailable (no API key)
 * - the OCR call itself fails (logged once per session)
 *
 * Eng-1B: per-call result is reflected in counters the doctor `ocr_health`
 * check reads. Counter writes are best-effort; never fail the import.
 *
 * The system prompt explicitly tells the model not to follow instructions
 * embedded in the image (mitigation for the OCR-as-prompt-injection vector).
 */
let _ocrWarnedThisSession = false;
async function maybeOcr(
  engine: BrainEngine,
  imgBuf: Buffer,
  mime: string,
): Promise<string> {
  const opt = process.env.GBRAIN_EMBEDDING_IMAGE_OCR;
  if (opt !== 'true') return '';

  // Counter helpers — quiet failure if config table is unavailable.
  async function bump(key: string) {
    try {
      const cur = parseInt((await engine.getConfig(key)) ?? '0', 10);
      await engine.setConfig(key, String((Number.isFinite(cur) ? cur : 0) + 1));
    } catch { /* non-fatal */ }
  }

  await bump('ocr_attempted');
  try {
    const { isAvailable, generateOcrText } = await import('./ai/gateway.ts');
    if (!isAvailable('expansion')) {
      if (!_ocrWarnedThisSession) {
        console.warn('[gbrain] OCR opt-in is true but expansion model is unavailable; skipping OCR for this session');
        _ocrWarnedThisSession = true;
      }
      await bump('ocr_failed_no_key');
      return '';
    }
    const text = await generateOcrText(imgBuf, mime);
    await bump('ocr_succeeded');
    return text;
  } catch (err) {
    if (!_ocrWarnedThisSession) {
      console.warn(`[gbrain] OCR call failed (continuing without OCR text): ${err instanceof Error ? err.message : String(err)}`);
      _ocrWarnedThisSession = true;
    }
    await bump('ocr_failed_other');
    return '';
  }
}

export interface ImportImageOptions {
  /** Override default OCR concurrency for tests. */
  ocrConcurrency?: number;
  /** Skip the embed call (for tests that want fast metadata-only inserts). */
  noEmbed?: boolean;
}

/** Module-level limiter so concurrent imports across files share the budget. */
const _ocrLimiter = pLimit(8);

/**
 * Phase 8 (cherry-1+2+3 in scope, F2 walker hook): import a single image file
 * by path. Lives alongside importFromFile + importCodeFile in the dispatcher
 * (extended in import.ts to recognize image extensions when
 * embedding_multimodal is on).
 */
export async function importImageFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: ImportImageOptions = {},
): Promise<ImportResult> {
  // Defense-in-depth: reject symlinks before reading bytes.
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: slugifyPath(relativePath), status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }
  const stat = statSync(filePath);
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `Image too large (${stat.size} bytes, max ${MAX_IMAGE_BYTES}). Voyage multimodal caps at 20MB per input.`,
    };
  }

  const ext = extname(relativePath).toLowerCase();
  const slug = slugifyPath(relativePath); // strips .md/.mdx; for images ext stays in path
  // Image slug includes the extension (otherwise foo.png and foo.jpg collide
  // and slugifyPath would already preserve it). Recompute with the file
  // extension preserved so the page slug is stable + collision-free.
  const imageSlug = relativePath.replace(/[\\\/]/g, '/').toLowerCase();
  const buf = readFileSync(filePath);
  const hash = createHash('sha256').update(buf).digest('hex');

  const existing = await engine.getPage(imageSlug);
  if (existing?.content_hash === hash) {
    return { slug: imageSlug, status: 'skipped', chunks: 0 };
  }

  // Decode HEIC/AVIF; pass-through for universal codecs.
  let decoded: { buf: Buffer; mime: string };
  try {
    decoded = await decodeIfNeeded(ext, buf);
  } catch (err) {
    return {
      slug: imageSlug,
      status: 'error',
      chunks: 0,
      error: `Decode failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // EXIF metadata (cherry-2). Pure JS, sub-ms; no concurrency knob needed.
  const exif = await readExifSafe(buf);

  // OCR opt-in (cherry-1). Runs through the per-process limiter so 100
  // images first-import doesn't serialize into 200s of OCR latency.
  const ocrText: string = opts.noEmbed
    ? ''
    : await _ocrLimiter(() => maybeOcr(engine, decoded.buf, decoded.mime));

  // Multimodal embed.
  let embedding: Float32Array | null = null;
  if (!opts.noEmbed) {
    try {
      const [vec] = await embedMultimodal([
        { kind: 'image_base64', data: decoded.buf.toString('base64'), mime: decoded.mime },
      ]);
      embedding = vec;
    } catch (err) {
      return {
        slug: imageSlug,
        status: 'error',
        chunks: 0,
        error: `embedMultimodal failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const filename = basename(relativePath);
  const frontmatter: Record<string, unknown> = {
    type: 'image',
    title: filename,
    mime_type: decoded.mime,
    bytes: stat.size,
    ...exif,
  };

  // Single chunk per image. chunk_text holds OCR text or filename so
  // searchKeyword has something useful to match when image rows are opted in.
  // chunk_source='image_asset' joins the v0.20 chunk_source allowlist.
  const chunk: ChunkInput & { modality?: string; embedding_image?: Float32Array } = {
    chunk_index: 0,
    chunk_text: ocrText || filename,
    chunk_source: 'image_asset',
    modality: 'image',
    ...(embedding ? { embedding_image: embedding } : {}),
  };

  const fileSpec: FileSpec = {
    filename,
    storage_path: relativePath.replace(/[\\\/]/g, '/'),
    mime_type: decoded.mime,
    size_bytes: stat.size,
    content_hash: hash,
  };

  await withImportTransaction(engine, {
    slug: imageSlug,
    hadExisting: !!existing,
    page: {
      type: 'image',
      page_kind: 'image',
      title: filename,
      compiled_truth: ocrText || '',
      timeline: '',
      frontmatter,
      content_hash: hash,
    },
    chunks: [chunk],
    file: fileSpec,
    after: async (tx) => {
      // Cherry-3: path-proximity auto-link to a sibling text page. The first
      // matching candidate gets an image_of edge. Best-effort — addLink
      // throws when the target doesn't exist; we silently skip for now and
      // let `gbrain reconcile-links` pick up later additions.
      for (const candidate of imageOfCandidates(imageSlug)) {
        const sibling = await tx.getPage(candidate);
        if (sibling) {
          try {
            await tx.addLink(
              imageSlug, candidate,
              filename,
              'image_of', 'manual', imageSlug, 'frontmatter',
            );
          } catch { /* sibling vanished mid-tx; skip */ }
          break; // one canonical link per image
        }
      }
    },
  });

  return { slug: imageSlug, status: 'imported', chunks: 1 };
}

/** Used by sync.isSyncable + import.ts walker. */
export function isImageFilePath(relativePath: string): boolean {
  const ext = extname(relativePath).toLowerCase();
  return (SUPPORTED_IMAGE_EXTS as readonly string[]).includes(ext);
}
// Re-export for sync.ts consumers (import-file is the single source of truth).
void NEEDS_DECODE;
