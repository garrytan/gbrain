/**
 * Destructive operation guard — v0.26.5
 *
 * Protects against accidental data loss in gbrain by requiring explicit
 * confirmation for operations that cascade-delete pages, chunks, or embeddings.
 *
 * Three layers:
 *   1. Impact preview — always shown before destructive actions
 *   2. Confirmation gate — requires --confirm-destructive or interactive "type source name"
 *   3. Soft-delete with TTL — sources are tombstoned for 72h before permanent deletion
 *
 * Design principle: the blast radius should be visible BEFORE you pull the trigger,
 * and recoverable AFTER you pull it (within a grace period).
 */

import type { BrainEngine } from './engine.ts';

// ── Types ───────────────────────────────────────────────────

export interface DestructiveImpact {
  sourceId: string;
  sourceName: string;
  pageCount: number;
  chunkCount: number;
  embeddingCount: number;
  fileCount: number;
  /** Human-readable summary line */
  summary: string;
}

export interface SoftDeletedSource {
  id: string;
  name: string;
  deletedAt: Date;
  expiresAt: Date;
  pageCount: number;
}

// ── Constants ───────────────────────────────────────────────

/** Hours before a soft-deleted source is permanently purged. */
export const SOFT_DELETE_TTL_HOURS = 72;

/** Threshold: operations affecting this many pages or more require confirmation. */
export const CONFIRM_THRESHOLD_PAGES = 1;

// ── Impact Assessment ───────────────────────────────────────

/**
 * Compute the blast radius of deleting a source.
 */
export async function assessDestructiveImpact(
  engine: BrainEngine,
  sourceId: string,
): Promise<DestructiveImpact | null> {
  // Fetch source metadata
  const sources = await engine.executeRaw<{ id: string; name: string }>(
    `SELECT id, name FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (sources.length === 0) return null;

  const src = sources[0];

  // Count pages
  const pageRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [sourceId],
  );
  const pageCount = pageRows[0]?.n ?? 0;

  // Count chunks
  const chunkRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM content_chunks cc
     JOIN pages p ON cc.page_id = p.id
     WHERE p.source_id = $1`,
    [sourceId],
  );
  const chunkCount = chunkRows[0]?.n ?? 0;

  // Count embeddings (chunks with non-null embedding vectors)
  const embedRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM content_chunks cc
     JOIN pages p ON cc.page_id = p.id
     WHERE p.source_id = $1 AND cc.embedding IS NOT NULL`,
    [sourceId],
  );
  const embeddingCount = embedRows[0]?.n ?? 0;

  // Count files in storage (if any). PGLite has no `files` table — that
  // surface is Postgres-only (CLAUDE.md: "No files table" for PGLite). Probe
  // the table existence via information_schema so this works on both engines.
  let fileCount = 0;
  const filesTableRows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'files'
     ) AS exists`,
  );
  if (filesTableRows[0]?.exists) {
    const fileRows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM files WHERE source_id = $1`,
      [sourceId],
    );
    fileCount = fileRows[0]?.n ?? 0;
  }

  const parts: string[] = [];
  if (pageCount > 0) parts.push(`${pageCount.toLocaleString()} pages`);
  if (chunkCount > 0) parts.push(`${chunkCount.toLocaleString()} chunks`);
  if (embeddingCount > 0) parts.push(`${embeddingCount.toLocaleString()} embeddings`);
  if (fileCount > 0) parts.push(`${fileCount.toLocaleString()} files`);

  const summary = parts.length > 0
    ? `⚠️  This will permanently delete: ${parts.join(', ')}`
    : `Source "${sourceId}" has no data (safe to remove).`;

  return {
    sourceId,
    sourceName: src.name,
    pageCount,
    chunkCount,
    embeddingCount,
    fileCount,
    summary,
  };
}

// ── Confirmation Gate ───────────────────────────────────────

/**
 * Check whether the caller has provided sufficient confirmation for a
 * destructive operation. Returns an error message if blocked, or null if OK.
 */
export function checkDestructiveConfirmation(
  impact: DestructiveImpact,
  opts: {
    yes?: boolean;
    confirmDestructive?: boolean;
    dryRun?: boolean;
  },
): string | null {
  // Dry run always passes (no side effects)
  if (opts.dryRun) return null;

  // No data = no risk
  if (impact.pageCount === 0 && impact.chunkCount === 0 && impact.fileCount === 0) {
    return null;
  }

  // --confirm-destructive is the explicit "I know what I'm doing" flag
  if (opts.confirmDestructive) return null;

  // --yes alone is NOT sufficient for destructive operations with data.
  // This is the key behavior change: --yes used to be enough, now you
  // need --confirm-destructive when there's actual data at stake.
  if (opts.yes && impact.pageCount === 0) return null;

  return (
    `\n${impact.summary}\n\n` +
    `To proceed, pass --confirm-destructive (or use soft-delete: gbrain sources archive ${impact.sourceId}).\n` +
    `To preview without side effects: --dry-run`
  );
}

// ── Soft Delete ─────────────────────────────────────────────

/**
 * Soft-delete a source: mark `archived = true` with a 72h TTL. Pages remain
 * in DB; the source is hidden from search via `buildVisibilityClause` and
 * federation is disabled via the existing `config.federated` JSONB key. After
 * TTL expires, the autopilot purge phase or manual `gbrain sources purge`
 * permanently removes the row (cascade delete to pages + chunks).
 *
 * v0.26.5: archive state moved from `config` JSONB keys to real columns
 * (`archived`, `archived_at`, `archive_expires_at`). Migration v34 backfills
 * pre-v0.26.5 rows. Faster filter, no reserved-key footgun. The `federated`
 * key stays in JSONB because federation has its own toggle path.
 */
export async function softDeleteSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<SoftDeletedSource | null> {
  // Atomic: only flip rows that are currently active. Returns the metadata
  // we need without a follow-up SELECT. RETURNING projects the columns the
  // caller cares about; pageCount is a separate count.
  const expiresClause = `now() + (${SOFT_DELETE_TTL_HOURS} || ' hours')::interval`;
  const rows = await engine.executeRaw<{ id: string; name: string; archived_at: string; archive_expires_at: string }>(
    `UPDATE sources
     SET archived = true,
         archived_at = now(),
         archive_expires_at = ${expiresClause},
         config = COALESCE(config, '{}'::jsonb) || '{"federated": false}'::jsonb
     WHERE id = $1 AND archived = false
     RETURNING id, name, archived_at, archive_expires_at`,
    [sourceId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  const pageRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [sourceId],
  );
  const pageCount = pageRows[0]?.n ?? 0;

  return {
    id: sourceId,
    name: row.name,
    deletedAt: new Date(row.archived_at),
    expiresAt: new Date(row.archive_expires_at),
    pageCount,
  };
}

/**
 * Restore a soft-deleted source (un-archive). Returns true iff a row was
 * restored. Idempotent-as-false on "already active" or "not found".
 *
 * v0.26.5: clears the column-based archive state and (by default) flips
 * `config.federated = true` so the source re-enters federated search. The
 * `--no-federate` operator opt-out keeps federation disabled.
 */
export async function restoreSource(
  engine: BrainEngine,
  sourceId: string,
  refederate: boolean = true,
): Promise<boolean> {
  const federatedPatch = refederate ? '{"federated": true}' : '{"federated": false}';
  const rows = await engine.executeRaw<{ id: string }>(
    `UPDATE sources
     SET archived = false,
         archived_at = NULL,
         archive_expires_at = NULL,
         config = COALESCE(config, '{}'::jsonb) || $1::jsonb
     WHERE id = $2 AND archived = true
     RETURNING id`,
    [federatedPatch, sourceId],
  );
  return rows.length > 0;
}

/**
 * List all soft-deleted (archived) sources.
 *
 * v0.26.5: filters via the real `archived` column instead of JSONB
 * containment. Faster, indexable on demand, no JSONB reserved-key collision
 * with future config schemas.
 */
export async function listArchivedSources(
  engine: BrainEngine,
): Promise<SoftDeletedSource[]> {
  const rows = await engine.executeRaw<{
    id: string;
    name: string;
    archived_at: string;
    archive_expires_at: string;
    page_count: number;
  }>(
    `SELECT
        s.id, s.name, s.archived_at, s.archive_expires_at,
        COALESCE((SELECT COUNT(*)::int FROM pages p WHERE p.source_id = s.id), 0) AS page_count
     FROM sources s
     WHERE s.archived = true
     ORDER BY s.archived_at DESC`,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    deletedAt: new Date(row.archived_at),
    expiresAt: new Date(row.archive_expires_at),
    pageCount: row.page_count,
  }));
}

/**
 * Permanently purge sources whose 72h TTL has expired. Cascades to pages
 * (and content_chunks via existing FKs). Returns the ids of purged sources.
 *
 * v0.26.5: moved from JSONB-driven iteration to a single set-based DELETE
 * with `archived = true AND archive_expires_at <= now()`. Server-side
 * filter; one round-trip; cascade-friendly.
 */
export async function purgeExpiredSources(
  engine: BrainEngine,
): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string }>(
    `DELETE FROM sources
     WHERE archived = true
       AND archive_expires_at IS NOT NULL
       AND archive_expires_at <= now()
     RETURNING id`,
  );
  return rows.map((r) => r.id);
}

// ── Display Helpers ─────────────────────────────────────────

/**
 * Format an impact assessment for terminal display.
 */
export function formatImpact(impact: DestructiveImpact): string {
  const lines: string[] = [
    ``,
    `╔══════════════════════════════════════════════════════════╗`,
    `║  DESTRUCTIVE OPERATION — Impact Preview                 ║`,
    `╠══════════════════════════════════════════════════════════╣`,
    `║  Source:     ${impact.sourceName.padEnd(42)}║`,
    `║  Source ID:  ${impact.sourceId.padEnd(42)}║`,
    `║                                                          ║`,
    `║  Pages:      ${String(impact.pageCount.toLocaleString()).padEnd(42)}║`,
    `║  Chunks:     ${String(impact.chunkCount.toLocaleString()).padEnd(42)}║`,
    `║  Embeddings: ${String(impact.embeddingCount.toLocaleString()).padEnd(42)}║`,
    `║  Files:      ${String(impact.fileCount.toLocaleString()).padEnd(42)}║`,
    `╠══════════════════════════════════════════════════════════╣`,
    `║  ${impact.summary.padEnd(56)}║`,
    `╚══════════════════════════════════════════════════════════╝`,
    ``,
  ];
  return lines.join('\n');
}

export function formatSoftDelete(sd: SoftDeletedSource): string {
  const hours = Math.round((sd.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60));
  return [
    ``,
    `Source "${sd.id}" archived (soft-deleted).`,
    `  ${sd.pageCount.toLocaleString()} pages preserved for ${SOFT_DELETE_TTL_HOURS}h.`,
    `  Expires: ${sd.expiresAt.toISOString()} (~${hours}h from now)`,
    `  Removed from search. Data intact.`,
    ``,
    `  Restore:  gbrain sources restore ${sd.id}`,
    `  Purge now: gbrain sources purge ${sd.id} --confirm-destructive`,
    ``,
  ].join('\n');
}
