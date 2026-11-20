/**
 * Core edit notices: the pending remote-edit notices of always-loaded core pages (core_edit_notices,
 * src/core/core-memory-schema.ts) that the core block, `gbrain core status` and doctor `core_memory` read. The statement
 * is the one `pendingCoreNotices` (src/core/core-memory.ts) ran through `executeRaw`, with its sort keys bytewise
 * (COLLATE "C", the PGLite order) so every engine lists the same 50 notices in the same order. The Rust engine keeps no
 * core edit notices and refuses the member by name (rust/docs/store/core-notices.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Doctor `core_memory` calls `listPendingCoreNotices` under its deadline-bound engine, so
 * src/core/statement-deadline.ts keeps the statement's bound on it (BOUNDED_TYPED_READS).
 */
export const CORE_NOTICE_MEMBERS: readonly string[] = ['listPendingCoreNotices'];

/** One pending notice: the newest unacknowledged remote edit of one core page. */
export interface PendingCoreNotice {
  source_id: string;
  slug: string;
  revision: string | null;
  actor: string;
  created_at: string;
}

/** Every source: one constant statement per shape, so no SQL is composed. */
const PENDING_ALL_SQL = `SELECT DISTINCT ON (source_id COLLATE "C", slug COLLATE "C") source_id, slug, revision, actor, created_at::text AS created_at
  FROM core_edit_notices WHERE acked_at IS NULL
 ORDER BY source_id COLLATE "C", slug COLLATE "C", id DESC LIMIT 50`;

const PENDING_IN_SOURCES_SQL = `SELECT DISTINCT ON (source_id COLLATE "C", slug COLLATE "C") source_id, slug, revision, actor, created_at::text AS created_at
  FROM core_edit_notices WHERE acked_at IS NULL AND source_id = ANY($1::text[])
 ORDER BY source_id COLLATE "C", slug COLLATE "C", id DESC LIMIT 50`;

/** The statement each shape runs, for the test that pins the text. */
export function pendingCoreNoticesSql(scoped: boolean): string {
  return scoped ? PENDING_IN_SOURCES_SQL : PENDING_ALL_SQL;
}

/**
 * The newest unacknowledged notice per core page (at most 50, by source then slug, bytewise); `sourceIds` narrows it to
 * those sources, and null or omitted reads every source.
 */
export async function listPendingCoreNotices(raw: EngineRawRead, sourceIds?: readonly string[] | null): Promise<PendingCoreNotice[]> {
  const rows = sourceIds
    ? await raw<PendingCoreNotice>(PENDING_IN_SOURCES_SQL, [[...sourceIds]])
    : await raw<PendingCoreNotice>(PENDING_ALL_SQL);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug, revision: r.revision ?? null, actor: r.actor, created_at: String(r.created_at) }));
}
