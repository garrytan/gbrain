/**
 * Backfill registry — v0.30.1 (Fix 3).
 *
 * Three backfills shipping in v0.30.1:
 *   - effective_date     — v0.29.1 column; wraps existing computeEffectiveDate
 *   - emotional_weight   — v0.29 cycle phase, promoted to user-callable
 *   - embedding_voyage   — declared but no-op in v0.30.1 (multi-column
 *                          schema migration ships in v0.30.2 per the
 *                          Embedding Multi-Column scope boundary)
 *
 * The runtime registry lives in this module; new backfills register here
 * AND inside the spec list at the bottom. CLI dispatch reads `getRegistry()`.
 */

import type { BrainEngine } from './engine.ts';
import type { BackfillSpec } from './backfill-base.ts';
import { computeEffectiveDate } from './effective-date.ts';
import { computeEmotionalWeight } from './cycle/emotional-weight.ts';
import {
  DREAM_CYCLE_INDEX_SLUG_SQL_PATTERN,
  DREAM_INDEX_RAW_TRACE_EXEMPT_REASON,
  untracedSynthesizedPagesPredicate,
} from './raw-provenance.ts';

export interface RegisteredBackfill {
  spec: BackfillSpec<Record<string, unknown>>;
  /** One-line description for `gbrain backfill list`. */
  description: string;
  /** Whether this entry is fully implemented in v0.30.1. */
  v030_1_status: 'implemented' | 'declared-only';
}

const _registry = new Map<string, RegisteredBackfill>();

export function registerBackfill(entry: RegisteredBackfill): void {
  _registry.set(entry.spec.name, entry);
}

export function getBackfill(name: string): RegisteredBackfill | undefined {
  return _registry.get(name);
}

export function listBackfills(): RegisteredBackfill[] {
  return Array.from(_registry.values());
}

export function clearRegistryForTests(): void {
  _registry.clear();
  registerCoreBackfills();
}

// ---------------------------------------------------------------------------
// Core registrations
// ---------------------------------------------------------------------------

interface PageRow {
  id: number;
  slug: string;
  frontmatter: unknown;
  import_filename: string | null;
  effective_date: string | null;
  effective_date_source: string | null;
  created_at: string;
  updated_at: string;
}

function parseFrontmatter(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; }
    catch { return {}; }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

function effectiveDateBackfill(): RegisteredBackfill {
  return {
    description: 'Compute effective_date / effective_date_source for pages imported before v0.29.1',
    v030_1_status: 'implemented',
    spec: {
      name: 'effective_date',
      table: 'pages',
      idColumn: 'id',
      selectColumns: ['slug', 'frontmatter', 'import_filename', 'effective_date', 'effective_date_source', 'created_at', 'updated_at'],
      needsBackfill: 'effective_date IS NULL',
      compute: async (rows) => {
        const updates: Array<{ id: number; updates: Record<string, unknown> }> = [];
        for (const r of rows as unknown as PageRow[]) {
          const fm = parseFrontmatter(r.frontmatter);
          // Strip extension off import_filename (effective-date expects basename
          // without ext). Pre-v0.29.1 rows have NULL import_filename.
          const filenameStem = r.import_filename
            ? r.import_filename.replace(/\.[a-z0-9]+$/i, '')
            : null;
          const result = computeEffectiveDate({
            slug: r.slug,
            frontmatter: fm,
            filename: filenameStem,
            createdAt: new Date(r.created_at),
            updatedAt: new Date(r.updated_at),
          });
          if (result.date !== null && result.source !== null) {
            // result.date is Date; persist as ISO string (UTC midnight per
            // computeEffectiveDate's date-truncation contract).
            updates.push({
              id: r.id,
              updates: {
                effective_date: result.date.toISOString().slice(0, 10),
                effective_date_source: result.source,
              },
            });
          }
        }
        return updates;
      },
      estimateRowsPerSecond: 5000, // pure computation, very fast
    },
  };
}

interface EmotionalWeightRow {
  id: number;
  slug: string;
}

function emotionalWeightBackfill(): RegisteredBackfill {
  return {
    description: 'Recompute emotional_weight for pages with stale recompute timestamp',
    v030_1_status: 'implemented',
    spec: {
      name: 'emotional_weight',
      table: 'pages',
      idColumn: 'id',
      selectColumns: ['slug'],
      needsBackfill: 'emotional_weight_recomputed_at IS NULL',
      // X4 / P2 corrected predicate: backlog rows are those that were never
      // recomputed (NULL) — NOT rows with weight=0 (legitimately steady).
      // Migration v44 adds the column.
      requiredIndex: {
        name: 'idx_pages_emotional_weight_pending',
        sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_emotional_weight_pending ON pages (id) WHERE emotional_weight_recomputed_at IS NULL`,
      },
      compute: async (rows, engine) => {
        const updates: Array<{ id: number; updates: Record<string, unknown> }> = [];
        // batchLoadEmotionalInputs is cheap and shape-aware. Fall back to
        // per-row read if the engine doesn't expose it (older brains).
        const slugs = (rows as unknown as EmotionalWeightRow[]).map(r => r.slug);
        const inputs = await engine.batchLoadEmotionalInputs(slugs).catch(() => []);
        const inputBySlug = new Map(inputs.map(i => [i.slug, i]));
        for (const r of rows as unknown as EmotionalWeightRow[]) {
          const input = inputBySlug.get(r.slug);
          if (!input) {
            // No tags or takes — score is 0 but we still stamp recomputed_at.
            updates.push({
              id: r.id,
              updates: {
                emotional_weight: 0,
                emotional_weight_recomputed_at: new Date().toISOString(),
              },
            });
            continue;
          }
          const score = computeEmotionalWeight({ tags: input.tags, takes: input.takes });
          updates.push({
            id: r.id,
            updates: {
              emotional_weight: score,
              emotional_weight_recomputed_at: new Date().toISOString(),
            },
          });
        }
        return updates;
      },
      estimateRowsPerSecond: 2000,
    },
  };
}

function embeddingVoyageBackfill(): RegisteredBackfill {
  return {
    description: 'Declared-only in v0.30.1 (multi-column embedding schema lands in v0.30.2)',
    v030_1_status: 'declared-only',
    spec: {
      name: 'embedding_voyage',
      table: 'content_chunks',
      idColumn: 'id',
      selectColumns: ['chunk_text'],
      // The column doesn't exist yet; this predicate matches no rows
      // until the v0.30.2 schema migration lands.
      needsBackfill: '1 = 0',
      compute: async () => [],
      estimateRowsPerSecond: 100,
    },
  };
}

interface ModalityBackfillRow {
  id: number;
  chunk_source: string | null;
  modality: string | null;
}

/**
 * v0.36 cross-modal wave: modality column cleanup.
 *
 * Historical brains that imported image assets BEFORE v0.27.1's
 * `modality='image'` default-set may have image chunks where
 * `embedding_image IS NOT NULL` but `modality != 'image'`. This backfill
 * flips them. D22-7 hardening: requires `chunk_source='image_asset'` so
 * we never tag a non-image chunk that happens to have an embedding_image
 * value (defensive against hypothetical future code paths populating
 * embedding_image on text chunks).
 *
 * Idempotent — second run finds no rows to update.
 */
function modalityBackfill(): RegisteredBackfill {
  return {
    description: 'Flip modality to "image" on image-asset chunks where it was missed by pre-v0.27.1 ingest',
    v030_1_status: 'implemented',
    spec: {
      name: 'modality',
      table: 'content_chunks',
      idColumn: 'id',
      selectColumns: ['chunk_source', 'modality'],
      needsBackfill:
        // D22-7: belt-and-suspenders. Both predicates must hold for the row
        // to be a real image chunk that lost its modality tag.
        "embedding_image IS NOT NULL AND chunk_source = 'image_asset' AND (modality IS NULL OR modality != 'image')",
      compute: async (rows) => {
        const updates: Array<{ id: number; updates: Record<string, unknown> }> = [];
        for (const r of rows as unknown as ModalityBackfillRow[]) {
          updates.push({ id: r.id, updates: { modality: 'image' } });
        }
        return updates;
      },
      estimateRowsPerSecond: 8000, // pure metadata flip, very fast
    },
  };
}

interface DreamCycleIndexRow {
  id: number;
  slug: string;
}

/**
 * #1978 follow-up: stamp the raw-trace exemption on dream-cycle index pages
 * written BEFORE synthesize.ts started stamping it prospectively.
 *
 * `writeSummaryPage` in core/cycle/synthesize.ts now stamps every new
 * `dream-cycle-summaries/<date>` page with `raw_trace_exempt: true` plus a
 * reason — the index is deterministic, it has no source document of its own,
 * and the raw traces live on the pages it lists. Index pages written before
 * that code landed carry no stamp, so `doctor`'s `raw_provenance` check warns
 * about them forever with no way to clear it. This backfill applies the
 * writer's own stamp to those rows.
 *
 * Scope is deliberately just the index pages. Other pre-existing synthesized
 * pages (wiki/*, extracts/*) want a `raw_source` pointing at the transcript
 * they were derived from, and that mapping cannot be reconstructed after the
 * fact — blanket-exempting them would silence the check rather than satisfy
 * it, so they are left alone.
 *
 * Predicate = doctor's own `raw_provenance` predicate (shared, so the two
 * cannot drift) AND the dream-cycle index slug shape AND the writer's
 * `dream_generated` marker. Idempotent: the stamp adds `raw_trace_exempt`,
 * which the shared predicate excludes, so a second run matches no rows.
 *
 * Content is untouched — only `frontmatter` moves, so `content_hash` /
 * `compiled_truth` are unchanged and nothing re-chunks or re-embeds.
 *
 * Known limitation: this repairs the DB row, not the historical markdown
 * file the dream cycle dual-wrote. If such a file is later edited and
 * re-imported, the import replaces frontmatter wholesale and the exemption
 * is lost again. `resumable: false` below is what makes that recoverable —
 * re-running the backfill re-stamps the row instead of skipping it because
 * a checkpoint says the id was already visited.
 */
function dreamCycleIndexProvenanceBackfill(): RegisteredBackfill {
  return {
    description: 'Stamp raw_trace_exempt on dream-cycle index pages written before synthesize.ts stamped it (#1978)',
    v030_1_status: 'implemented',
    spec: {
      name: 'dream_cycle_index_provenance',
      table: 'pages',
      idColumn: 'id',
      selectColumns: ['slug'],
      // The predicate is self-clearing (the stamp it writes is one of the
      // keys the shared predicate excludes), so a checkpoint buys nothing
      // and actively harms the re-import repair path described above.
      resumable: false,
      needsBackfill: `
        ${untracedSynthesizedPagesPredicate('pages')}
    AND pages.slug ~ '${DREAM_CYCLE_INDEX_SLUG_SQL_PATTERN}'
    AND COALESCE(pages.frontmatter->>'dream_generated', '') = 'true'
    AND pages.frontmatter->>'dream_cycle_date' = right(pages.slug, 10)`,
      // Merge in SQL against the CURRENT row (not a JS-side snapshot) and
      // bind the delta as a raw object at an explicit ::jsonb position —
      // mirrors stampDreamProvenance's write in core/cycle/synthesize.ts.
      columnUpdateSql: {
        frontmatter: v => `COALESCE(frontmatter, '{}'::jsonb) || ${v}::jsonb`,
      },
      compute: async (rows) => {
        return (rows as unknown as DreamCycleIndexRow[]).map(r => ({
          id: r.id,
          updates: {
            frontmatter: {
              raw_trace_exempt: true,
              raw_trace_exempt_reason: DREAM_INDEX_RAW_TRACE_EXEMPT_REASON,
            },
          },
        }));
      },
      estimateRowsPerSecond: 5000, // metadata-only merge
    },
  };
}

function registerCoreBackfills(): void {
  registerBackfill(effectiveDateBackfill());
  registerBackfill(emotionalWeightBackfill());
  registerBackfill(embeddingVoyageBackfill());
  registerBackfill(modalityBackfill());
  registerBackfill(dreamCycleIndexProvenanceBackfill());
}

// Auto-register on first import.
registerCoreBackfills();
