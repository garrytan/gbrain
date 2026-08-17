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
import { SOURCE_CONFIG_OBJECT_SQL } from './source-config-sql.ts';
import { isUndefinedColumnError, isUndefinedTableError } from './utils.ts';

// ── Types ───────────────────────────────────────────────────

export interface DestructiveImpact {
  sourceId: string;
  sourceName: string;
  pageCount: number;
  chunkCount: number;
  embeddingCount: number;
  fileCount: number;
  /**
   * PR6 D5b: count of ALL OAuth clients (live AND soft-deleted — the FK is
   * physical, ON DELETE RESTRICT ignores deleted_at) whose source_id
   * references this source. A hard delete with referents raises a raw FK
   * violation — the preview surfaces the block before the trigger is pulled.
   * Optional so hand-built impact literals (tests, older callers) stay valid.
   */
  oauthClientCount?: number;
  /**
   * cathedral-6: count of hot-memory facts in the source. Facts are the
   * primary agent write lane — a revoked agent's workspace can hold facts
   * with ZERO pages, so a pages-only preview would say "safe to remove"
   * while the delete cascades the agent's memory away. Optional so
   * hand-built impact literals (tests, older callers) stay valid; consumers
   * read it as `?? 0`.
   */
  factCount?: number;
  /** Human-readable summary line */
  summary: string;
}

/** An OAuth client row that references a source via oauth_clients.source_id.
 * `deleted` marks soft-deleted (revoked-but-retained) rows — the FK is
 * PHYSICAL (ON DELETE RESTRICT ignores deleted_at), so they block too. */
export interface SourceClientReferent {
  clientId: string;
  clientName: string;
  deleted: boolean;
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

// ── FK-RESTRICT lifecycle (PR6 D5b) ─────────────────────────

/**
 * ALL OAuth clients referencing a source via oauth_clients.source_id
 * (ON DELETE RESTRICT — these rows BLOCK a hard delete of the source).
 * PHYSICAL semantics: soft-deleted rows (admin revoke does UPDATE SET
 * deleted_at) still hold the FK, so they are returned too, tagged
 * `deleted: true`, and the guidance splits per row. Pre-migration brains
 * without the deleted_at column fall back to all referents (same
 * 42703-retry idiom as oauth-provider.ts) tagged live; brains without
 * the oauth_clients table — or without the source_id column (no column
 * ⇒ no FK ⇒ no referents) — have no referents by construction.
 */
export async function clientsReferencingSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<SourceClientReferent[]> {
  try {
    const rows = await engine.executeRaw<{ client_id: string; client_name: string; deleted: boolean }>(
      `SELECT client_id, client_name, (deleted_at IS NOT NULL) AS deleted
       FROM oauth_clients
       WHERE source_id = $1
       ORDER BY client_id`,
      [sourceId],
    );
    return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: r.deleted === true }));
  } catch (e) {
    if (isUndefinedTableError(e)) return [];
    // isUndefinedColumnError is code-first (any 42703 matches), and the
    // primary query references BOTH optional columns — disambiguate on the
    // message, which names the missing column.
    const msg = e instanceof Error ? e.message : String(e);
    if (isUndefinedColumnError(e, 'source_id') && msg.includes('source_id')) return [];
    if (!(isUndefinedColumnError(e, 'deleted_at') && msg.includes('deleted_at'))) throw e;
    try {
      const rows = await engine.executeRaw<{ client_id: string; client_name: string }>(
        `SELECT client_id, client_name FROM oauth_clients
         WHERE source_id = $1
         ORDER BY client_id`,
        [sourceId],
      );
      return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: false }));
    } catch (e2) {
      // The fallback's only optional column is source_id — no column ⇒ no FK.
      if (isUndefinedColumnError(e2, 'source_id')) return [];
      throw e2;
    }
  }
}

/**
 * Refusal message for `sources remove` / `sources purge <id>` when live OAuth
 * clients still reference the source. Built here (not in sources.ts — that
 * file is module-size-ratcheted) so both arms print identical guidance
 * instead of letting the raw FK violation surface.
 */
export function formatClientReferentsBlock(
  sourceId: string,
  referents: SourceClientReferent[],
): string {
  const live = referents.filter((r) => !r.deleted);
  const dead = referents.filter((r) => r.deleted);
  const lines: string[] = [
    ``,
    `Cannot delete source "${sourceId}": ${referents.length} OAuth client(s) reference this source`,
    `(oauth_clients.source_id is ON DELETE RESTRICT — the delete would fail at the database).`,
    ``,
  ];
  for (const r of referents) {
    lines.push(`  - ${r.clientName} (${r.clientId})${r.deleted ? '  [revoked, retained]' : ''}`);
  }
  if (live.length > 0) {
    lines.push(``);
    lines.push(`Revoke each live client first (hard delete), then retry:`);
    for (const r of live) {
      lines.push(`  gbrain auth revoke-client "${r.clientId}"`);
    }
  }
  if (dead.length > 0) {
    lines.push(``);
    lines.push(`Revoked-but-retained rows still block the FK — \`gbrain auth revoke-client "<id>"\` hard-deletes them:`);
    for (const r of dead) {
      lines.push(`  gbrain auth revoke-client "${r.clientId}"`);
    }
  }
  lines.push(``);
  return lines.join('\n');
}

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

  // cathedral-6: count hot-memory facts. A revoked agent's workspace can
  // hold facts with zero pages — those are data at risk, not "no data".
  // Tolerant of a pre-v0.31 brain without the facts table (same degrade
  // posture as clientsReferencingSource).
  let factCount = 0;
  try {
    const factRows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1`,
      [sourceId],
    );
    factCount = factRows[0]?.n ?? 0;
  } catch (e) {
    if (!isUndefinedTableError(e)) throw e;
  }

  // PR6 D5b: fold the FK-RESTRICT referent count into the preview so the
  // operator sees the block BEFORE pulling the trigger.
  const oauthClientCount = (await clientsReferencingSource(engine, sourceId)).length;

  const parts: string[] = [];
  if (pageCount > 0) parts.push(`${pageCount.toLocaleString()} pages`);
  if (chunkCount > 0) parts.push(`${chunkCount.toLocaleString()} chunks`);
  if (embeddingCount > 0) parts.push(`${embeddingCount.toLocaleString()} embeddings`);
  if (fileCount > 0) parts.push(`${fileCount.toLocaleString()} files`);
  if (factCount > 0) parts.push(`${factCount.toLocaleString()} facts`);

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
    factCount,
    oauthClientCount,
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

  // No data = no risk. Facts gate exactly like pages (cathedral-6): a
  // fact-only source (revoked agent workspace) is data at stake, not empty.
  if (impact.pageCount === 0 && impact.chunkCount === 0 && impact.fileCount === 0
    && (impact.factCount ?? 0) === 0) {
    return null;
  }

  // --confirm-destructive is the explicit "I know what I'm doing" flag
  if (opts.confirmDestructive) return null;

  // --yes alone is NOT sufficient for destructive operations with data.
  // This is the key behavior change: --yes used to be enough, now you
  // need --confirm-destructive when there's actual data at stake. Facts
  // mirror pages here too — --yes never bypasses a fact-holding source.
  if (opts.yes && impact.pageCount === 0 && (impact.factCount ?? 0) === 0) return null;

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
         config = ${SOURCE_CONFIG_OBJECT_SQL} || '{"federated": false}'::jsonb
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
         config = ${SOURCE_CONFIG_OBJECT_SQL} || $1::text::jsonb
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

/** Result of a purge sweep: what deleted, and what an FK deliberately held. */
export interface PurgeExpiredResult {
  /** Source ids permanently deleted this sweep. */
  purged: string[];
  /**
   * Sources past TTL that could NOT be deleted because a RESTRICT FK still
   * references them — today that is migration v64's oauth_clients.source_id
   * ON DELETE RESTRICT, which intentionally refuses source deletion until
   * every client is revoked-and-purged or re-scoped. Blocked is a policy
   * outcome, not an error: the sweep reports it and moves on.
   */
  blocked: Array<{ id: string; reason: string }>;
}

/**
 * Permanently purge sources whose 72h TTL has expired. Cascades to pages
 * (and content_chunks via existing FKs).
 *
 * v0.26.5 used a single set-based DELETE; gbrain#4115 showed one FK-blocked
 * source (a revoked-but-retained oauth_client under v64's ON DELETE RESTRICT)
 * aborted the whole statement, wedging the nightly purge forever. The sweep is
 * now per-source: each DELETE re-checks the expiry predicate (no
 * select-then-delete race with a concurrent restore), ONLY the FK-restriction
 * error class (SQLSTATE 23503) is treated as blocked-and-reported, and every
 * other error re-raises. (Supersedes #4238's set-based NOT-EXISTS variant at
 * merge: the 23503 catch covers ANY current or future RESTRICT FK — including
 * soft-deleted oauth_clients, since the FK is physical — not just the one
 * table an EXISTS prefilter names, and the structured {purged, blocked}
 * return is what every caller + test in this tree consumes.)
 */
export async function purgeExpiredSources(
  engine: BrainEngine,
): Promise<PurgeExpiredResult> {
  const candidates = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources
     WHERE archived = true
       AND archive_expires_at IS NOT NULL
       AND archive_expires_at <= now()
     ORDER BY id`,
  );
  const purged: string[] = [];
  const blocked: PurgeExpiredResult['blocked'] = [];
  for (const { id } of candidates) {
    try {
      const rows = await engine.executeRaw<{ id: string }>(
        `DELETE FROM sources
         WHERE id = $1
           AND archived = true
           AND archive_expires_at IS NOT NULL
           AND archive_expires_at <= now()
         RETURNING id`,
        [id],
      );
      if (rows.length > 0) purged.push(id);
      // 0 rows = restored/already gone between SELECT and DELETE; neither
      // purged nor blocked.
    } catch (err) {
      // SQLSTATE 23503 foreign_key_violation — same detection idiom as
      // oauth-provider.ts's delete path for this exact FK.
      if ((err as { code?: string })?.code === '23503') {
        blocked.push({
          id,
          reason:
            'still referenced by a RESTRICT foreign key (revoked oauth_client not yet purged? the FK is physical, so soft-deleted clients also block) — ' +
            'review with `gbrain auth clients`, revoke with `gbrain auth revoke-client "<client-id>"`, then retry',
        });
        continue;
      }
      throw err;
    }
  }
  return { purged, blocked };
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
    `║  Facts:      ${String((impact.factCount ?? 0).toLocaleString()).padEnd(42)}║`,
    `╠══════════════════════════════════════════════════════════╣`,
    `║  ${impact.summary.padEnd(56)}║`,
    `╚══════════════════════════════════════════════════════════╝`,
    ``,
  ];
  // PR6 D5b: surface the FK-RESTRICT block in the preview. Rendered outside
  // the box (variable-width padding inside would misalign the frame).
  if ((impact.oauthClientCount ?? 0) > 0) {
    lines.push(`⚠️  ${impact.oauthClientCount} OAuth client(s) reference this source — a hard delete is`);
    lines.push(`   blocked (FK RESTRICT) until they are revoked: gbrain auth revoke-client "<client-id>"`);
    lines.push(``);
  }
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
