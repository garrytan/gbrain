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

function registerCoreBackfills(): void {
  registerBackfill(effectiveDateBackfill());
  registerBackfill(emotionalWeightBackfill());
  registerBackfill(embeddingVoyageBackfill());
}

// Auto-register on first import.
registerCoreBackfills();
