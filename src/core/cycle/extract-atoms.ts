// v0.41.2.1 — extract_atoms cycle phase, post-fix-wave rebuild.
//
// Sequencing per cycle:
//   1. Discover transcripts via discoverTranscripts() AND brain pages
//      via a single raw SQL query (NOT EXISTS subquery filters out
//      pages already extracted by content hash — see "Idempotency" below).
//   2. Dedup by content_hash; transcripts win on collision.
//   3. Per work-item, ask Haiku for 1-3 atoms.
//   4. Write each atom via engine.putPage(slug, page, {sourceId})
//      with sourceId threaded so federated brains route correctly.
//
// Idempotency (D1 from /plan-eng-review):
//   Each atom carries frontmatter.source_hash (16-char sha256 prefix).
//   Before processing a transcript/page, query "any atom with this
//   source_hash exists in this source?". If yes, skip. Closes both:
//     - PR #1414's primary concern (page-side re-extraction)
//     - Pre-existing v0.41.2.0 transcript-side date-stamp duplicate bug
//       (atom slugs are `atoms/YYYY-MM-DD/<title>`, so re-discovered
//       transcripts on day N+1 used to write second atoms; now skipped).
//
// Known limitation (D9 #2 — documented, not blocking):
//   If extraction writes atom 1 of 3 then atom 2 throws, source_hash
//   filter sees atom 1 exists and skips on next discovery. Atoms 2+3
//   stay missing until content_hash changes. Acceptable for v0.41.2.1:
//     - Haiku call failure is rare; network/budget failures rarer.
//     - Content edits trigger natural re-extract via new content_hash.
//     - The original incident (duplicate atoms) is fully closed.
//   Per-atom idempotency via deterministic slug is v0.42+ TODO
//   (see TODOS.md).
//
// Config:
//   Reads dream.synthesize.session_corpus_dir + meeting_transcripts_dir
//   via loadConfigWithEngine() (D9 #10: precedence is file > DB > defaults;
//   no GBRAIN_DREAM_* env vars exist). Closes PR #1416's silent-config bug
//   for this caller.
//
// Budget: $0.30/source/run, key `cycle.extract_atoms.budget_usd`.
// Exceeded budget halts with PhaseStatus='warn' + partial result.
//
// Source-scoped: opts.sourceId routes the per-source corpus dir lookup,
// the discovery SQL (source_id = $1), the NOT EXISTS idempotency
// subquery (atom.source_id = $1), AND every putPage write
// ({sourceId} third arg). Pre-fix the putPage call was missing the
// sourceId arg — atoms always wrote to 'default' regardless of source,
// which made the NOT EXISTS guard ineffective on federated brains.

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { GBrainConfig } from '../config.ts';
import type { ProgressReporter } from '../progress.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';

const DEFAULT_BUDGET_USD = 0.3;

// v0.42+ TODO: read atom_type enum from active pack manifest at runtime.
const ATOM_TYPES = [
  'insight', 'anecdote', 'quote', 'framework', 'statistic',
  'story_angle', 'strategy_angle', 'strategy', 'endorsement',
  'critique', 'collection',
] as const;

// v0.41.2.1 (D2): brain-page discovery constants. Hardcoded for now;
// future pack-aware refactor is a one-line change to pull from the
// active pack manifest (symmetric with the existing
// src/core/facts/eligibility.ts:49 TODO).
const EXTRACTABLE_PAGE_TYPES = [
  'meeting', 'source', 'article', 'video', 'book', 'original',
] as const;
const PAGE_DISCOVERY_BUDGET = 50;
const MIN_PAGE_CHARS_FOR_EXTRACTION = 500;

export interface ExtractAtomsOpts {
  brainDir?: string;
  sourceId?: string;
  dryRun?: boolean;
  affectedSlugs?: string[];
  /** Test seam: alternative chat function (bypasses real LLM calls). */
  _chat?: typeof gatewayChat;
  /**
   * Test seam: alternative config loader. Sync OR async — extended in
   * v0.41.2.1 to allow loadConfigWithEngine() (async) to be the default.
   */
  _loadConfig?: () => GBrainConfig | Promise<GBrainConfig | null> | null;
  /** Test seam: skip transcript discovery; use these transcripts directly. */
  _transcripts?: Array<{ filePath: string; content: string; contentHash: string }>;
  /**
   * Test seam (v0.41.2.1): skip page discovery; use these pages directly.
   * Mirrors _transcripts shape. `undefined` triggers discovery; `[]`
   * explicitly suppresses page discovery (for transcript-only tests).
   */
  _pages?: Array<{ slug: string; content: string; contentHash: string }>;
  /**
   * v0.41.19.0 (T3): cooperative yield hook fired from inside the work
   * loop on a 30s throttle AND immediately after every `await chat()`
   * LLM call. Cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
   * each fire refreshes the cycle DB lock + the existing external hook
   * (Minion job-lock renewal). Without it a long phase loses the lock
   * after the v0.41.19.0 TTL drop 30→5min.
   */
  yieldDuringPhase?: () => Promise<void>;
  /**
   * v0.41.19.0 (T4): progress reporter for in-phase ticks. Cycle.ts
   * passes the SAME reporter (not a child — codex caught the path-
   * collision bug where `progress.child('extract_atoms')` under parent
   * state `cycle.extract_atoms` would produce
   * `cycle.extract_atoms.extract_atoms.work`). Cycle.ts owns the
   * phase-level start/finish; phases only call `tick()` and
   * `heartbeat()` on the passed reporter.
   */
  progress?: ProgressReporter;
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

const EXTRACT_PROMPT = `You extract atomic content nuggets from a transcript.

An atom is a single-source, self-contained idea that could become a tweet,
quote, or short essay angle. Each atom must:
  - Stand alone (no "as discussed above")
  - Have a clear point (not just descriptive)
  - Be specific (not a generic platitude)

Output a JSON array of atoms (1-3 per transcript, never more than 3).
Each atom: {title (≤80 chars), atom_type, body (2-4 sentences),
source_quote (verbatim ≤200 chars), lesson (one sentence), virality_score
(0-100), emotional_register (one of: shocking, inspiring, funny, sobering,
practical, controversial)}.

atom_type MUST be one of: ${ATOM_TYPES.join(', ')}.

Output ONLY the JSON array, no prose.`;

interface DiscoveredPage {
  slug: string;
  content: string;
  contentHash: string;
}

/**
 * v0.41.2.1 (D2) — single-SQL discovery + idempotency filter for brain
 * pages. Discovers extractable pages whose content_hash has no
 * corresponding atom row yet. One round-trip; replaces the
 * 6-listPages + per-candidate atom-existence-check pattern from PR #1414.
 *
 * Fails soft: any executeRaw error is logged to stderr and returns [].
 * The transcript path still proceeds.
 *
 * D9 fixes incorporated:
 *   #1 sourceId threading on putPage — happens at the caller (this
 *      function returns DiscoveredPage; caller does the writes).
 *   #3 content_hash IS NOT NULL filter — pages without a hash can't
 *      participate in the NOT EXISTS check anyway.
 *   #4 dream_generated exclusion — prevents the phase from chewing
 *      its own output (e.g. dream-generated originals).
 */
export async function discoverExtractablePages(
  engine: BrainEngine,
  sourceId: string,
  affectedSlugs?: string[],
): Promise<DiscoveredPage[]> {
  const hasFilter = Array.isArray(affectedSlugs) && affectedSlugs.length > 0;
  const sql = `
    SELECT p.slug,
           p.compiled_truth,
           p.content_hash
    FROM pages p
    WHERE p.source_id = $1
      AND p.type = ANY($2::text[])
      AND p.deleted_at IS NULL
      AND p.content_hash IS NOT NULL
      AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
      AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
      AND length(COALESCE(p.compiled_truth, '')) >= $3
      ${hasFilter ? "AND p.slug = ANY($5::text[])" : ''}
      AND NOT EXISTS (
        SELECT 1
        FROM pages atom
        WHERE atom.type = 'atom'
          AND atom.source_id = $1
          AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
          AND atom.deleted_at IS NULL
      )
    ORDER BY p.updated_at DESC
    LIMIT $4
  `;
  const params: unknown[] = [
    sourceId,
    EXTRACTABLE_PAGE_TYPES as unknown as string[],
    MIN_PAGE_CHARS_FOR_EXTRACTION,
    PAGE_DISCOVERY_BUDGET,
  ];
  if (hasFilter) params.push(affectedSlugs);

  try {
    const rows = await engine.executeRaw<{
      slug: string;
      compiled_truth: string;
      content_hash: string;
    }>(sql, params);
    return rows.map((r) => ({
      slug: r.slug,
      content: r.compiled_truth,
      contentHash: r.content_hash,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract_atoms] page-discovery query failed: ${msg}`);
    return []; // fail-soft: transcript path still proceeds
  }
}

/**
 * Batch source-hash idempotency check. Returns the set of contentHash16
 * values that already have an atom row for this source. One SQL
 * roundtrip; migration v104 adds the partial expression index that
 * keeps this O(log n) on big brains.
 *
 * Replaces the prior per-hash helper (`atomsExistForHash`) — for ~7K
 * conversation transcripts the per-hash loop was 7K round trips before
 * extraction began (~5-10 min of pure overhead on a 322K-page brain).
 *
 * Empty input short-circuits without a query. Fail-open on error so
 * extraction proceeds (same posture as the prior per-hash helper).
 *
 * Exported so the unit test can drive it directly without orchestrating
 * the full phase.
 */
export async function atomsExistingForHashes(
  engine: BrainEngine,
  sourceId: string,
  contentHash16s: string[],
): Promise<Set<string>> {
  if (contentHash16s.length === 0) return new Set();
  try {
    const rows = await engine.executeRaw<{ h: string }>(
      `SELECT frontmatter->>'source_hash' AS h
         FROM pages
        WHERE type = 'atom'
          AND source_id = $1
          AND deleted_at IS NULL
          AND frontmatter->>'source_hash' = ANY($2::text[])`,
      [sourceId, contentHash16s],
    );
    return new Set(rows.map(r => r.h));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract_atoms] batch idempotency check failed (assuming none extracted): ${msg}`);
    return new Set();
  }
}

/**
 * v0.41 minimal extract_atoms body, rebuilt for v0.41.2.1.
 *
 * Test-driven minimum: takes _transcripts AND _pages directly when set,
 * skipping filesystem + DB discovery. Production path uses
 * discoverTranscripts + discoverExtractablePages (both lazy-imported
 * to avoid circular module loads and to keep PGLite-only tests fast).
 */
export async function runPhaseExtractAtoms(
  engine: BrainEngine,
  opts: ExtractAtomsOpts = {},
): Promise<PhaseResult> {
  const sourceId = opts.sourceId ?? 'default';
  const chat = opts._chat ?? gatewayChat;

  // 1a. Get transcripts (test seam OR production discovery).
  //     v0.41.2.1: config loader switched to loadConfigWithEngine() so the
  //     dream.* DB-plane merge from Phase 1 reaches this phase.
  let transcripts: Array<{ filePath: string; content: string; contentHash: string }> = opts._transcripts ?? [];
  if (transcripts.length === 0 && opts.brainDir !== undefined && opts._transcripts === undefined) {
    try {
      const { discoverTranscripts } = await import('./transcript-discovery.ts');
      const { loadConfigWithEngine } = await import('../config.ts');
      const cfgRaw = opts._loadConfig
        ? await opts._loadConfig()
        : await loadConfigWithEngine(engine);
      const cfg = (cfgRaw ?? {}) as unknown as Record<string, unknown>;
      const dream = cfg.dream as
        | { synthesize?: { session_corpus_dir?: string; meeting_transcripts_dir?: string } }
        | undefined;
      const corpusDir = dream?.synthesize?.session_corpus_dir;
      const meetingDir = dream?.synthesize?.meeting_transcripts_dir;
      if (corpusDir !== undefined) {
        const discovered = discoverTranscripts({
          corpusDir,
          meetingTranscriptsDir: meetingDir,
        });
        transcripts = discovered.map((d) => ({
          filePath: d.filePath,
          content: d.content,
          contentHash: d.contentHash,
        }));
      }
    } catch {
      // No transcripts available — phase no-ops cleanly.
    }
  }

  // 1b. Get pages (test seam OR production discovery).
  //     _pages === undefined triggers discovery; _pages: [] suppresses it
  //     deliberately (transcript-only regression tests).
  let pages: Array<{ slug: string; content: string; contentHash: string }>;
  if (opts._pages !== undefined) {
    pages = opts._pages;
  } else {
    pages = await discoverExtractablePages(engine, sourceId, opts.affectedSlugs);
  }

  // 2. Apply transcript-side source-hash idempotency in ONE batch query
  //    instead of N per-hash round trips. Page-side idempotency lives in
  //    the discovery SQL's NOT EXISTS subquery (already batched).
  const transcriptsLive: typeof transcripts = [];
  let duplicatesSkipped = 0;
  const allHashes16 = transcripts.map(t => t.contentHash.slice(0, 16));
  // Surface a heartbeat before the batch query so even an instant
  // short-circuit shows a sign of life (closes Issue 2 silent-phase pain).
  opts.progress?.heartbeat(`checking existing atoms for ${allHashes16.length} transcripts`);
  const existingHashes = await atomsExistingForHashes(engine, sourceId, allHashes16);
  for (const t of transcripts) {
    if (existingHashes.has(t.contentHash.slice(0, 16))) {
      duplicatesSkipped++;
      continue;
    }
    transcriptsLive.push(t);
  }

  // 3. Dual-source merge: transcripts + pages, dedup by contentHash.
  //    Transcripts win on collision (origin attribution stays with the
  //    raw transcript file even if the same content was later imported
  //    as a brain page).
  type WorkItem =
    | { kind: 'transcript'; filePath: string; content: string; contentHash: string }
    | { kind: 'page'; slug: string; content: string; contentHash: string };

  const seenHashes = new Set<string>();
  const work: WorkItem[] = [];
  for (const t of transcriptsLive) {
    if (seenHashes.has(t.contentHash)) { duplicatesSkipped++; continue; }
    seenHashes.add(t.contentHash);
    work.push({ kind: 'transcript', ...t });
  }
  for (const p of pages) {
    if (seenHashes.has(p.contentHash)) { duplicatesSkipped++; continue; }
    seenHashes.add(p.contentHash);
    work.push({ kind: 'page', ...p });
  }

  // Phase-level no-op: nothing to extract today.
  if (work.length === 0 && transcripts.length === 0 && pages.length === 0) {
    return {
      phase: 'extract_atoms',
      status: 'skipped',
      duration_ms: 0,
      summary: 'extract_atoms: no transcripts or pages to process',
      details: {
        reason: 'no_work',
        source_id: sourceId,
        atoms_extracted: 0,
        transcripts_processed: 0,
        transcripts_total: 0,
        transcripts_skipped_budget: 0,
        pages_processed: 0,
        pages_total: 0,
        duplicates_skipped: 0,
        failures: [],
        estimated_spend_usd: 0,
        budget_usd: DEFAULT_BUDGET_USD,
        dry_run: opts.dryRun ?? false,
      },
    };
  }

  // 4. Per work-item: extract atoms via Haiku
  let totalAtomsExtracted = 0;
  let transcriptsProcessed = 0;
  let pagesProcessed = 0;
  let transcriptsSkipped = 0;
  let pagesSkipped = 0;
  const failures: Array<{ source: string; error: string }> = [];
  let estimatedSpendUsd = 0;
  const budgetCap = DEFAULT_BUDGET_USD;

  // v0.41.19.0 (T3): throttled yield helper. Fires `opts.yieldDuringPhase`
  // every 30s. Cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
  // each fire refreshes the cycle DB lock. Combined with TTL=5min: a
  // healthy long phase keeps the lock alive (10× refresh budget before
  // TTL expires); a crash releases the lock within 5min instead of 30.
  //
  // Called both inside the work loop (cheap iterations) AND immediately
  // after every `await chat()` (long LLM await is the main TTL hazard
  // codex flagged).
  let lastYieldMs = Date.now();
  async function maybeYield(): Promise<void> {
    if (!opts.yieldDuringPhase) return;
    const now = Date.now();
    if (now - lastYieldMs < 30_000) return;
    lastYieldMs = now;
    try {
      await opts.yieldDuringPhase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[extract_atoms] yieldDuringPhase failed (non-fatal): ${msg}`);
    }
  }

  for (const item of work) {
    await maybeYield();
    if (estimatedSpendUsd >= budgetCap) {
      if (item.kind === 'transcript') transcriptsSkipped++;
      else pagesSkipped++;
      continue;
    }

    const originLabel = item.kind === 'transcript' ? item.filePath : item.slug;
    try {
      const result = await chat({
        system: EXTRACT_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Source: ${originLabel}\n\n---\n\n${item.content.slice(0, 50_000)}`,
          },
        ],
        maxTokens: 2000,
      });
      // Post-await yield: closes the "long LLM call past TTL" hazard
      // codex flagged. The 30s throttle inside maybeYield bounds the
      // actual refresh rate so this is cheap when calls are fast.
      await maybeYield();

      // Rough cost estimate — Haiku at ~$0.80/M input + $4/M output
      estimatedSpendUsd +=
        (result.usage.input_tokens * 0.8 + result.usage.output_tokens * 4.0) / 1_000_000;

      const atoms = parseAtomsResponse(result.text);
      if (atoms.length === 0) {
        if (item.kind === 'transcript') transcriptsProcessed++;
        else pagesProcessed++;
        continue;
      }

      if (!opts.dryRun) {
        for (const atom of atoms) {
          const slug = `atoms/${todayDate()}/${slugify(atom.title)}`;
          const originFrontmatter =
            item.kind === 'transcript'
              ? { source_path: item.filePath }
              : { source_slug: item.slug };
          // v0.41.2.1 D9 #1 — thread sourceId through every putPage so
          // atoms land in the source we discovered them from. Pre-fix
          // the third arg was missing and atoms always wrote to 'default'.
          await engine.putPage(
            slug,
            {
              title: atom.title,
              type: 'atom',
              compiled_truth: atom.body,
              frontmatter: {
                type: 'atom',
                atom_type: atom.atom_type,
                ...originFrontmatter,
                source_hash: item.contentHash.slice(0, 16),
                ...(atom.source_quote && { source_quote: atom.source_quote }),
                ...(atom.lesson && { lesson: atom.lesson }),
                ...(atom.virality_score !== undefined && { virality_score: atom.virality_score }),
                ...(atom.emotional_register && { emotional_register: atom.emotional_register }),
                extracted_at: new Date().toISOString(),
                extracted_by: 'extract_atoms-v0.41.2.1',
              },
              timeline: '',
            },
            { sourceId },
          );
          totalAtomsExtracted++;
        }
      } else {
        totalAtomsExtracted += atoms.length; // count for dry-run reporting
      }
      if (item.kind === 'transcript') transcriptsProcessed++;
      else pagesProcessed++;
      // v0.41.19.0 (T4): one tick per processed item, with a count note.
      // Reporter rate-limits to ~1 line/sec; safe to tick every iter.
      opts.progress?.tick(1, `${totalAtomsExtracted} atoms / ${duplicatesSkipped} skipped`);
    } catch (err) {
      failures.push({
        source: originLabel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // v0.42 Wave B2: write extract receipt + rollup row when the phase
  // actually extracted atoms. Both are best-effort per F-OUT-19 —
  // audit-trail / search-visibility surfaces don't block the phase result.
  if (!opts.dryRun && totalAtomsExtracted > 0) {
    const runId = `atoms-${Date.now().toString(36)}-${sourceId.slice(0, 4)}`;
    try {
      await writeReceipt(engine, {
        kind: 'atoms',
        source_id: sourceId,
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: totalAtomsExtracted,
        cost_usd: estimatedSpendUsd,
        summary:
          `Extracted ${totalAtomsExtracted} atoms from ` +
          `${transcriptsProcessed} transcripts + ${pagesProcessed} pages.`,
      });
    } catch (err) {
      console.error(`[extract_atoms] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    await upsertExtractRollup(engine, {
      kind: 'atoms',
      source_id: sourceId,
      cost_delta: estimatedSpendUsd,
      round_completed_delta: failures.length === 0 ? 1 : 0,
      halt_delta: failures.length > 0 ? 1 : 0,
    });
  }

  return {
    phase: 'extract_atoms',
    status: failures.length > 0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `extract_atoms: ${totalAtomsExtracted} atoms from ` +
      `${transcriptsProcessed}/${transcripts.length} transcripts + ` +
      `${pagesProcessed}/${pages.length} pages` +
      (failures.length > 0 ? ` (${failures.length} failed)` : '') +
      (transcriptsSkipped + pagesSkipped > 0
        ? ` (${transcriptsSkipped + pagesSkipped} budget-skipped)`
        : ''),
    details: {
      atoms_extracted: totalAtomsExtracted,
      transcripts_processed: transcriptsProcessed,
      transcripts_total: transcripts.length,
      transcripts_skipped_budget: transcriptsSkipped,
      pages_processed: pagesProcessed,
      pages_total: pages.length,
      pages_skipped_budget: pagesSkipped,
      duplicates_skipped: duplicatesSkipped,
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
  // Strip markdown code fences if the LLM wrapped JSON in them.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find the first JSON array bracket.
  const arrayStart = cleaned.indexOf('[');
  if (arrayStart === -1) return [];
  cleaned = cleaned.slice(arrayStart);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try trimming back from the end to recover from trailing prose.
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
