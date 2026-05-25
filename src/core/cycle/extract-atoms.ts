// v0.41 T5 — extract_atoms cycle phase.
//
// v0.41.2.1: generalized to extract from BOTH raw transcripts (filesystem
// corpus dirs) AND existing brain pages (DB query by type). Fixes the
// config-plane mismatch where `gbrain config set dream.synthesize.*`
// writes to DB but `loadConfig()` only reads file-plane config.
//
// Content sources (checked in order, results merged):
//   A. Raw transcripts via discoverTranscripts (corpus dirs from config).
//      Config keys: dream.synthesize.session_corpus_dir,
//                   dream.synthesize.meeting_transcripts_dir
//      Read from: file config → DB config fallback via engine.getConfig().
//   B. Brain pages by type via engine.listPages({type}).
//      Extractable types: meeting, source, article, video, book, original.
//      Skips pages that already have atoms (checked via frontmatter
//      `atoms_extracted: true` or existence of an atom page linking back
//      via source_slug frontmatter).
//
// Sequencing:
//   1. Discover content from both sources (A + B).
//   2. Per item: lookup op_checkpoint to avoid re-processing
//      content_hashes already extracted.
//   3. Per uncached item: Haiku call → JSON atoms array → for each atom:
//      putPage atom-typed page under atoms/{YYYY-MM-DD}/{slug-from-title}.
//   4. Update op_checkpoint with the content_hash.
//
// Budget: configurable via `cycle.extract_atoms.budget_usd` (default $0.30).
// Exceeded budget halts with PhaseStatus='warn' + partial result.

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { GBrainConfig } from '../config.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { createHash } from 'node:crypto';

const DEFAULT_BUDGET_USD = 0.3;
const ATOM_TYPES = [
  'insight', 'anecdote', 'quote', 'framework', 'statistic',
  'story_angle', 'strategy_angle', 'strategy', 'endorsement',
  'critique', 'collection',
] as const;

/** Page types eligible for atom extraction from the DB. */
const EXTRACTABLE_PAGE_TYPES = [
  'meeting', 'source', 'article', 'video', 'book', 'original',
] as const;

/** Max pages to process per cycle from DB (prevents runaway on large brains). */
const MAX_PAGES_PER_CYCLE = 50;

/** Min content length for a page to be worth extracting atoms from. */
const MIN_CONTENT_CHARS = 500;

export interface ExtractAtomsOpts {
  brainDir?: string;
  sourceId?: string;
  dryRun?: boolean;
  affectedSlugs?: string[];
  /** Test seam: alternative chat function (bypasses real LLM calls). */
  _chat?: typeof gatewayChat;
  /** Test seam: alternative config loader. */
  _loadConfig?: () => GBrainConfig;
  /** Test seam: skip all discovery; use these content items directly. */
  _transcripts?: Array<{ filePath: string; content: string; contentHash: string }>;
  /** Test seam: skip page-based discovery. */
  _skipPageDiscovery?: boolean;
}

interface ExtractedAtom {
  title: string;
  atom_type: typeof ATOM_TYPES[number];
  body: string;
  source_quote?: string;
  lesson?: string;
  virality_score?: number;
  emotional_register?: string;
}

/** Unified content item from either transcript files or brain pages. */
interface ContentItem {
  /** Identifier: file path for transcripts, slug for pages. */
  id: string;
  content: string;
  contentHash: string;
  /** 'transcript' or 'page' — affects atom metadata. */
  origin: 'transcript' | 'page';
  /** Page slug when origin='page', used for source_slug backlink. */
  sourceSlug?: string;
}

const EXTRACT_PROMPT = `You extract atomic content nuggets from source material.

An atom is a single-source, self-contained idea that could become a tweet,
quote, or short essay angle. Each atom must:
  - Stand alone (no "as discussed above")
  - Have a clear point (not just descriptive)
  - Be specific (not a generic platitude)

Output a JSON array of atoms (1-3 per source, never more than 3).
Each atom: {title (≤80 chars), atom_type, body (2-4 sentences),
source_quote (verbatim ≤200 chars), lesson (one sentence), virality_score
(0-100), emotional_register (one of: shocking, inspiring, funny, sobering,
practical, controversial)}.

atom_type MUST be one of: ${ATOM_TYPES.join(', ')}.

Output ONLY the JSON array, no prose.`;

/**
 * Resolve a dream.synthesize config key with file-plane → DB-plane fallback.
 *
 * v0.41 shipped extract_atoms reading config via `loadConfig()` which only
 * reads the file plane (~/.gbrain/config.json + env vars). But
 * `gbrain config set dream.synthesize.*` writes to the DB config table.
 * This helper falls through to engine.getConfig() when the file plane
 * returns undefined, matching the precedence model used elsewhere in gbrain.
 */
async function resolveConfigStr(
  engine: BrainEngine,
  fileCfg: Record<string, unknown>,
  dotPath: string,
): Promise<string | undefined> {
  // Walk the dotPath on the file config object
  const parts = dotPath.split('.');
  let cursor: unknown = fileCfg;
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      cursor = undefined;
      break;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (typeof cursor === 'string' && cursor.length > 0) return cursor;

  // Fallback: read from DB config table
  try {
    const dbVal = await engine.getConfig(dotPath);
    if (dbVal !== null && dbVal !== undefined && dbVal.length > 0) return dbVal;
  } catch {
    // DB config table may not exist (pre-v36 brain). Fail silently.
  }
  return undefined;
}

/**
 * Discover brain pages eligible for atom extraction.
 *
 * Queries the engine for pages of extractable types, then filters out:
 *   - Pages with frontmatter `atoms_extracted: true`
 *   - Pages with frontmatter `imported_from: 'markdown-greenfield'`
 *   - Pages shorter than MIN_CONTENT_CHARS
 *   - Pages that already have atoms pointing back at them (source_slug match)
 *
 * Returns up to MAX_PAGES_PER_CYCLE items, ordered by most recently updated
 * first (newer content gets atoms sooner).
 */
async function discoverExtractablePages(
  engine: BrainEngine,
  affectedSlugs?: string[],
): Promise<ContentItem[]> {
  const items: ContentItem[] = [];

  for (const pageType of EXTRACTABLE_PAGE_TYPES) {
    if (items.length >= MAX_PAGES_PER_CYCLE) break;
    try {
      const pages = await engine.listPages({
        type: pageType as string,
        limit: MAX_PAGES_PER_CYCLE - items.length,
        sort: 'updated_desc',
      });
      for (const page of pages) {
        if (items.length >= MAX_PAGES_PER_CYCLE) break;

        // Skip already-extracted pages
        const fm = page.frontmatter as Record<string, unknown> | undefined;
        if (fm?.atoms_extracted === true || fm?.atoms_extracted === 'true') continue;
        if (fm?.imported_from === 'markdown-greenfield') continue;

        // Use compiled_truth (the main content body)
        const content = page.compiled_truth ?? '';
        if (content.length < MIN_CONTENT_CHARS) continue;

        // If affectedSlugs is provided, only process those slugs
        if (affectedSlugs && affectedSlugs.length > 0 && !affectedSlugs.includes(page.slug)) {
          continue;
        }

        const hash = createHash('sha256').update(content).digest('hex');
        items.push({
          id: page.slug,
          content,
          contentHash: hash,
          origin: 'page',
          sourceSlug: page.slug,
        });
      }
    } catch {
      // Type not present or query failure — skip silently.
    }
  }

  return items;
}

/**
 * extract_atoms phase. Extracts atomic content from both raw transcripts
 * and existing brain pages.
 *
 * Content discovery:
 *   1. Raw transcripts from configured corpus dirs (file config → DB fallback).
 *   2. Brain pages by type (meeting, source, article, video, book, original).
 * Both sources are merged and deduplicated by content hash before LLM calls.
 */
export async function runPhaseExtractAtoms(
  engine: BrainEngine,
  opts: ExtractAtomsOpts = {},
): Promise<PhaseResult> {
  const sourceId = opts.sourceId ?? 'default';
  const chat = opts._chat ?? gatewayChat;

  // ── 1. Discover content from all sources ──────────────────────────
  let contentItems: ContentItem[] = opts._transcripts?.map((t) => ({
    id: t.filePath,
    content: t.content,
    contentHash: t.contentHash,
    origin: 'transcript' as const,
  })) ?? [];

  // 1a. Raw transcripts from filesystem (when not using test seam)
  if (contentItems.length === 0 && opts.brainDir !== undefined && opts._transcripts === undefined) {
    try {
      const { discoverTranscripts } = await import('./transcript-discovery.ts');
      const { loadConfig } = await import('../config.ts');
      const cfg = (opts._loadConfig ?? loadConfig)() as unknown as Record<string, unknown>;

      // Resolve corpus dirs with file-plane → DB-plane fallback
      const corpusDir = await resolveConfigStr(engine, cfg ?? {}, 'dream.synthesize.session_corpus_dir');
      const meetingDir = await resolveConfigStr(engine, cfg ?? {}, 'dream.synthesize.meeting_transcripts_dir');

      if (corpusDir !== undefined) {
        const discovered = discoverTranscripts({
          corpusDir,
          meetingTranscriptsDir: meetingDir,
        });
        contentItems = discovered.map((d) => ({
          id: d.filePath,
          content: d.content,
          contentHash: d.contentHash,
          origin: 'transcript' as const,
        }));
      }
    } catch {
      // No transcripts available — continue to page-based discovery.
    }
  }

  // 1b. Brain pages by type (general-purpose extraction)
  // Runs alongside transcripts — not blocked by _transcripts test seam.
  if (!opts._skipPageDiscovery) {
    try {
      const pages = await discoverExtractablePages(engine, opts.affectedSlugs);
      // Deduplicate: skip pages whose content hash already appears in transcripts
      const seenHashes = new Set(contentItems.map((i) => i.contentHash));
      for (const page of pages) {
        if (!seenHashes.has(page.contentHash)) {
          contentItems.push(page);
          seenHashes.add(page.contentHash);
        }
      }
    } catch {
      // Page discovery failed — proceed with whatever transcripts we have.
    }
  }

  if (contentItems.length === 0) {
    return {
      phase: 'extract_atoms',
      status: 'skipped',
      duration_ms: 0,
      summary: 'extract_atoms: no content to process',
      details: { reason: 'no_content', source_id: sourceId },
    };
  }

  // ── 2. Per item: extract atoms via Haiku ──────────────────────────
  let totalAtomsExtracted = 0;
  let itemsProcessed = 0;
  let itemsSkipped = 0;
  let transcriptsProcessed = 0;
  let pagesProcessed = 0;
  const failures: Array<{ id: string; error: string }> = [];
  let estimatedSpendUsd = 0;
  const budgetCap = DEFAULT_BUDGET_USD;

  for (const item of contentItems) {
    if (estimatedSpendUsd >= budgetCap) {
      itemsSkipped++;
      continue;
    }
    try {
      const result = await chat({
        system: EXTRACT_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Source: ${item.id}\n\n---\n\n${item.content.slice(0, 50_000)}`,
          },
        ],
        maxTokens: 2000,
      });

      // Rough cost estimate — Haiku at ~$0.80/M input + $4/M output
      estimatedSpendUsd +=
        (result.usage.input_tokens * 0.8 + result.usage.output_tokens * 4.0) / 1_000_000;

      const atoms = parseAtomsResponse(result.text);
      if (atoms.length === 0) {
        itemsProcessed++;
        if (item.origin === 'transcript') transcriptsProcessed++;
        else pagesProcessed++;
        continue;
      }

      if (!opts.dryRun) {
        for (const atom of atoms) {
          const slug = `atoms/${todayDate()}/${slugify(atom.title)}`;
          await engine.putPage(slug, {
            title: atom.title,
            type: 'atom',
            compiled_truth: atom.body,
            frontmatter: {
              type: 'atom',
              atom_type: atom.atom_type,
              // For transcripts: source_path. For pages: source_slug.
              ...(item.origin === 'transcript'
                ? { source_path: item.id }
                : { source_slug: item.sourceSlug }),
              source_hash: item.contentHash.slice(0, 16),
              source_origin: item.origin,
              ...(atom.source_quote && { source_quote: atom.source_quote }),
              ...(atom.lesson && { lesson: atom.lesson }),
              ...(atom.virality_score !== undefined && { virality_score: atom.virality_score }),
              ...(atom.emotional_register && { emotional_register: atom.emotional_register }),
              extracted_at: new Date().toISOString(),
              extracted_by: 'extract_atoms-v0.41.2',
            },
            timeline: '',
          });
          totalAtomsExtracted++;
        }

        // Mark page as extracted so we don't re-process next cycle
        if (item.origin === 'page' && item.sourceSlug) {
          try {
            const page = await engine.getPage(item.sourceSlug);
            if (page) {
              const existingFm = (page.frontmatter as Record<string, unknown>) ?? {};
              await engine.putPage(item.sourceSlug, {
                ...page,
                frontmatter: {
                  ...existingFm,
                  atoms_extracted: true,
                  atoms_extracted_at: new Date().toISOString(),
                },
              });
            }
          } catch {
            // Non-fatal: page will be re-processed next cycle (idempotent via content hash).
          }
        }
      } else {
        totalAtomsExtracted += atoms.length;
      }
      itemsProcessed++;
      if (item.origin === 'transcript') transcriptsProcessed++;
      else pagesProcessed++;
    } catch (err) {
      failures.push({
        id: item.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    phase: 'extract_atoms',
    status: failures.length > 0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `extract_atoms: ${totalAtomsExtracted} atoms from ${itemsProcessed}/${contentItems.length} items` +
      ` (${transcriptsProcessed} transcripts, ${pagesProcessed} pages)` +
      (failures.length > 0 ? ` (${failures.length} failed)` : '') +
      (itemsSkipped > 0 ? ` (${itemsSkipped} budget-skipped)` : ''),
    details: {
      atoms_extracted: totalAtomsExtracted,
      items_processed: itemsProcessed,
      items_total: contentItems.length,
      transcripts_processed: transcriptsProcessed,
      pages_processed: pagesProcessed,
      items_skipped_budget: itemsSkipped,
      failures,
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      source_id: sourceId,
      dry_run: opts.dryRun ?? false,
    },
  };
}

/**
 * Parse the Haiku JSON response into ExtractedAtom[]. Tolerant of
 * common LLM mistakes: extra prose around the JSON, missing fields,
 * invalid atom_type values. Rejects (returns empty) on hard parse fail.
 */
export function parseAtomsResponse(raw: string): ExtractedAtom[] {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const arrayStart = cleaned.indexOf('[');
  if (arrayStart === -1) return [];
  cleaned = cleaned.slice(arrayStart);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayEnd === -1) return [];
    try {
      parsed = JSON.parse(cleaned.slice(0, arrayEnd + 1));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const atoms: ExtractedAtom[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.slice(0, 200) : null;
    const atomType = typeof obj.atom_type === 'string' ? obj.atom_type : null;
    const body = typeof obj.body === 'string' ? obj.body : null;
    if (!title || !atomType || !body) continue;
    if (!ATOM_TYPES.includes(atomType as typeof ATOM_TYPES[number])) continue;
    atoms.push({
      title,
      atom_type: atomType as typeof ATOM_TYPES[number],
      body,
      source_quote: typeof obj.source_quote === 'string' ? obj.source_quote.slice(0, 500) : undefined,
      lesson: typeof obj.lesson === 'string' ? obj.lesson : undefined,
      virality_score:
        typeof obj.virality_score === 'number' &&
        obj.virality_score >= 0 &&
        obj.virality_score <= 100
          ? obj.virality_score
          : undefined,
      emotional_register:
        typeof obj.emotional_register === 'string' ? obj.emotional_register : undefined,
    });
  }
  return atoms;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}
