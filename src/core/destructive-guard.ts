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

  // Count files in storage (if any)
  const fileRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM files WHERE source_id = $1`,
    [sourceId],
  );
  const fileCount = fileRows[0]?.n ?? 0;

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
 * Soft-delete a source: mark it as archived with a TTL. Pages remain in DB
 * but the source is hidden from search/list by default. After TTL expires,
 * a background job or manual `gbrain sources purge` permanently removes it.
 */
export async function softDeleteSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<SoftDeletedSource | null> {
  const sources = await engine.executeRaw<{ id: string; name: string }>(
    `SELECT id, name FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (sources.length === 0) return null;
  const src = sources[0];

  const pageRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [sourceId],
  );
  const pageCount = pageRows[0]?.n ?? 0;

  // Set archived metadata in config
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SOFT_DELETE_TTL_HOURS * 60 * 60 * 1000);

  await engine.executeRaw(
    `UPDATE sources
     SET config = COALESCE(config, '{}'::jsonb) || $1::jsonb
     WHERE id = $2`,
    [
      JSON.stringify({
        archived: true,
        archived_at: now.toISOString(),
        archive_expires_at: expiresAt.toISOString(),
        federated: false, // immediately remove from search
      }),
      sourceId,
    ],
  );

  return {
    id: sourceId,
    name: src.name,
    deletedAt: now,
    expiresAt,
    pageCount,
  };
}

/**
 * Restore a soft-deleted source (un-archive).
 */
export async function restoreSource(
  engine: BrainEngine,
  sourceId: string,
  refederate: boolean = true,
): Promise<boolean> {
  const sources = await engine.executeRaw<{ id: string; config: unknown }>(
    `SELECT id, config FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (sources.length === 0) return false;

  const config = typeof sources[0].config === 'string'
    ? JSON.parse(sources[0].config)
    : sources[0].config ?? {};

  if (!config.archived) {
    // Not archived — nothing to restore
    return false;
  }

  // Remove archive metadata, optionally re-federate
  delete config.archived;
  delete config.archived_at;
  delete config.archive_expires_at;
  if (refederate) config.federated = true;

  await engine.executeRaw(
    `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
    [JSON.stringify(config), sourceId],
  );

  return true;
}

/**
 * List all soft-deleted (archived) sources.
 */
export async function listArchivedSources(
  engine: BrainEngine,
): Promise<SoftDeletedSource[]> {
  const rows = await engine.executeRaw<{ id: string; name: string; config: unknown }>(
    `SELECT id, name, config FROM sources
     WHERE config::jsonb @> '{"archived": true}'::jsonb`,
  );

  const results: SoftDeletedSource[] = [];
  for (const row of rows) {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config ?? {};
    const pageRows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      [row.id],
    );
    results.push({
      id: row.id,
      name: row.name,
      deletedAt: new Date(config.archived_at),
      expiresAt: new Date(config.archive_expires_at),
      pageCount: pageRows[0]?.n ?? 0,
    });
  }

  return results;
}

/**
 * Permanently purge sources whose soft-delete TTL has expired.
 * Returns the ids of purged sources.
 */
export async function purgeExpiredSources(
  engine: BrainEngine,
): Promise<string[]> {
  const archived = await listArchivedSources(engine);
  const now = new Date();
  const purged: string[] = [];

  for (const src of archived) {
    if (src.expiresAt <= now) {
      await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [src.id]);
      purged.push(src.id);
    }
  }

  return purged;
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
