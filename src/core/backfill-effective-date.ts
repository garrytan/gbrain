/**
 * v0.29.1 — Backfill effective_date / effective_date_source for existing
 * pages.
 *
 * Migration v38 added the columns; they're NULL for rows imported before
 * v0.29.1. This walks every page in keyset-paginated batches, runs the
 * `computeEffectiveDate` precedence chain, and UPDATEs in place.
 *
 * Resumable: stores `last_processed_id` in the `config` table after each
 * batch. A killed process can re-run and pick up where it left off without
 * re-doing rows. Idempotent: even a full re-walk produces the same writes.
 *
 * Postgres only sets `SET LOCAL statement_timeout = '600s'` per batch (does
 * NOT refuse the migration on low session settings — codex pass-2 #16).
 *
 * Pure library function — same code path used by the v0_29_1 orchestrator
 * AND the `gbrain reindex-frontmatter` CLI command (added in commit 4).
 *
 * Note: the `import_filename` column stays NULL on backfilled rows. We
 * don't have the original filename for pre-v0.29.1 imports (codex pass-1
 * finding #6). For `daily/`/`meetings/` slugs whose filename-derived date
 * IS in the slug tail, computeEffectiveDate falls through to the slug-tail
 * heuristic via `slug.split('/').pop()` in importFromContent's caller path
 * — but the orchestrator passes the slug-tail explicitly here so backfilled
 * rows behave the same as fresh imports for those prefixes.
 */

import type { BrainEngine } from './engine.ts';
import { computeEffectiveDate } from './effective-date.ts';
import type { EffectiveDateSource } from './types.ts';

const BATCH_SIZE = 1000;
const CHECKPOINT_KEY = 'backfill.effective_date.last_id';

export interface BackfillOpts {
  /** Limit total rows touched (testing). Undefined = no cap. */
  maxRows?: number;
  /** Restart from id=0 even if a checkpoint exists. */
  fresh?: boolean;
  /** Don't write; report what would happen. */
  dryRun?: boolean;
  /** Per-batch progress callback. */
  onBatch?: (info: { batch: number; lastId: number; rowsTouched: number; cumulative: number }) => void;
  /**
   * Optional slug-prefix filter (e.g. 'meetings/') so the CLI command can
   * scope to a subset. Undefined = no filter.
   */
  slugPrefix?: string;
  /**
   * When true, recompute even if existing effective_date matches what
   * the chain would produce. Default false (no-op-on-equal saves writes).
   */
  force?: boolean;
}

export interface BackfillResult {
  /** Total rows examined across all batches. */
  examined: number;
  /** Rows where effective_date was actually written (changed or newly computed). */
  updated: number;
  /** Rows that fell through the chain to 'fallback' (matches updated_at/created_at). */
  fallback: number;
  /** Final last_processed_id (for resume / debugging). */
  lastId: number;
  /** Total wall-clock seconds. */
  durationSec: number;
}

interface PageRow {
  id: number;
  slug: string;
  frontmatter: unknown;
  import_filename: string | null;
  effective_date: string | null;
  effective_date_source: EffectiveDateSource | null;
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

async function getCheckpoint(engine: BrainEngine, fresh: boolean): Promise<number> {
  if (fresh) return 0;
  try {
    const rows = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = $1 LIMIT 1`,
      [CHECKPOINT_KEY],
    );
    if (rows.length === 0) return 0;
    const n = Number(rows[0].value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function setCheckpoint(engine: BrainEngine, lastId: number): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO config (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [CHECKPOINT_KEY, String(lastId)],
    );
  } catch {
    // Best effort. Failure to checkpoint just means re-walk on next run;
    // doesn't corrupt state.
  }
}

async function clearCheckpoint(engine: BrainEngine): Promise<void> {
  try {
    await engine.executeRaw(`DELETE FROM config WHERE key = $1`, [CHECKPOINT_KEY]);
  } catch {
    // Same — best effort.
  }
}

export async function backfillEffectiveDate(
  engine: BrainEngine,
  opts: BackfillOpts = {},
): Promise<BackfillResult> {
  const start = Date.now();
  const slugPrefix = opts.slugPrefix?.replace(/[\\%_]/g, (c) => '\\' + c) ?? null;

  let lastId = await getCheckpoint(engine, opts.fresh ?? false);
  let examined = 0;
  let updated = 0;
  let fallback = 0;
  let batchNum = 0;

  // Per-engine statement_timeout boost. Postgres can wedge on a slow
  // batch otherwise; PGLite ignores SET LOCAL outside transactions but
  // doesn't have the timeout problem in the first place (single writer).
  const isPostgres = engine.kind === 'postgres';

  while (true) {
    if (opts.maxRows && examined >= opts.maxRows) break;

    const limit = opts.maxRows
      ? Math.min(BATCH_SIZE, opts.maxRows - examined)
      : BATCH_SIZE;

    // Keyset pagination: WHERE id > last_id ORDER BY id LIMIT N. Single-direction
    // walk; safe under concurrent inserts (new rows show up at the tail).
    const slugFilter = slugPrefix
      ? `AND slug LIKE $2 ESCAPE '\\\\'`
      : '';
    const params: unknown[] = [lastId];
    if (slugPrefix) params.push(slugPrefix + '%');
    params.push(limit);
    const limitParam = `$${params.length}`;

    const rows = await engine.executeRaw<PageRow>(
      `SELECT id, slug, frontmatter, import_filename, effective_date, effective_date_source, created_at, updated_at
         FROM pages
         WHERE id > $1 ${slugFilter}
         ORDER BY id
         LIMIT ${limitParam}`,
      params,
    );

    if (rows.length === 0) break;

    examined += rows.length;
    let touched = 0;

    if (!opts.dryRun) {
      // Compute effective_date for each row, then UPDATE in a batch wrapped
      // in its own transaction (so SET LOCAL statement_timeout scopes to it).
      // postgres.js's `transaction` would be cleaner but we're using executeRaw
      // for engine portability; explicit BEGIN/COMMIT does the same on both.
      if (isPostgres) {
        await engine.executeRaw(`BEGIN`);
        await engine.executeRaw(`SET LOCAL statement_timeout = '600s'`);
      }

      try {
        for (const r of rows) {
          const fm = parseFrontmatter(r.frontmatter);
          const filename = r.import_filename
            || (r.slug.includes('/') ? r.slug.split('/').pop()! : r.slug);
          const computed = computeEffectiveDate({
            slug: r.slug,
            frontmatter: fm,
            filename,
            updatedAt: new Date(r.updated_at),
            createdAt: new Date(r.created_at),
          });

          // No-op-on-equal: skip the UPDATE if existing matches (saves write
          // amplification on re-runs). `force: true` bypasses.
          const existingMs = r.effective_date ? new Date(r.effective_date).getTime() : null;
          const computedMs = computed.date ? computed.date.getTime() : null;
          const datesMatch = existingMs === computedMs;
          const sourcesMatch = (r.effective_date_source ?? null) === (computed.source ?? null);

          if (!opts.force && datesMatch && sourcesMatch) continue;

          await engine.executeRaw(
            `UPDATE pages SET effective_date = $1::timestamptz, effective_date_source = $2 WHERE id = $3`,
            [computed.date ? computed.date.toISOString() : null, computed.source, r.id],
          );
          touched++;
          if (computed.source === 'fallback') fallback++;
        }

        if (isPostgres) await engine.executeRaw(`COMMIT`);
      } catch (e) {
        if (isPostgres) {
          try { await engine.executeRaw(`ROLLBACK`); } catch { /* ignore */ }
        }
        throw e;
      }
    } else {
      // Dry run: still count what WOULD change.
      for (const r of rows) {
        const fm = parseFrontmatter(r.frontmatter);
        const filename = r.import_filename
          || (r.slug.includes('/') ? r.slug.split('/').pop()! : r.slug);
        const computed = computeEffectiveDate({
          slug: r.slug,
          frontmatter: fm,
          filename,
          updatedAt: new Date(r.updated_at),
          createdAt: new Date(r.created_at),
        });
        const existingMs = r.effective_date ? new Date(r.effective_date).getTime() : null;
        const computedMs = computed.date ? computed.date.getTime() : null;
        if (existingMs !== computedMs || (r.effective_date_source ?? null) !== (computed.source ?? null)) {
          touched++;
        }
        if (computed.source === 'fallback') fallback++;
      }
    }

    updated += touched;
    lastId = rows[rows.length - 1].id;
    batchNum++;
    if (!opts.dryRun) await setCheckpoint(engine, lastId);
    opts.onBatch?.({ batch: batchNum, lastId, rowsTouched: touched, cumulative: examined });
  }

  // Walk done; clear the checkpoint so the next manual run starts fresh.
  if (!opts.dryRun) await clearCheckpoint(engine);

  return {
    examined,
    updated,
    fallback,
    lastId,
    durationSec: (Date.now() - start) / 1000,
  };
}
