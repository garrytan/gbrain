/**
 * The entity and mention reads the CLI ran through `executeRaw` before they had typed members. Each function keeps the
 * statement text its call site ran, byte for byte (scripts/sql-move-check.mjs holds it to that). The reads that splice a
 * retirement, privacy or due predicate into their text stay at their call sites.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** The newest mention pass time (ISO, UTC, whole seconds) over every source or one source; null when no pass ran. */
export async function readMentionLastPass(exec: LegacyUnscopedRead, sourceId?: string | null): Promise<string | null> {
  const [row] = await exec.executeRaw<{ last: string | null }>(
    `SELECT to_char(max(last_pass_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last FROM mention_index_status
        WHERE ($1::text IS NULL OR source_id = $1)`, [sourceId ?? null]);
  return row?.last ?? null;
}

/**
 * At most two of `slugs` that hold a live page of the source, in no stated order (entities/resolve.ts
 * `findExactBasenameCandidates`: the `<dir>/<basename>` slugs of a reference).
 */
export async function findExactBasenameCandidates(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<string[]> {
  const rows = await exec.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`,
    [sourceId, [...slugs]],
  );
  return rows.map(r => r.slug);
}
