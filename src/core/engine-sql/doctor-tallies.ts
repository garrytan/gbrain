/**
 * Doctor tallies: counts `gbrain doctor` checks ran through `executeRaw` inside a catch that turned a Rust capability
 * refusal into a quiet zero (docs/research/rust-refusal-swallow-triage.tsv, lane 14 swap blockers), moved here with the
 * same text. PGLite and Postgres run these exact statements; the Rust engine answers the same members from its store
 * records (rust/crates/gbrain-store/src/cli_reads/doctor_tallies.rs, rust/docs/store/cli-reads-doctor-tallies.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them.
 */
export const DOCTOR_TALLY_MEMBERS: readonly string[] = ['countLiveSegmentedPages', 'countValidityLapsedFacts', 'countOrphanEventProjections'];

const SEGMENTED_LIVE_SQL = `SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.body_storage = 'segmented'`;
const SEGMENTED_PROJECTION_PENDING_SQL = `SELECT count(*)::int AS n FROM pages
    WHERE deleted_at IS NULL AND body_storage='segmented' AND text_projection_revision IS DISTINCT FROM knowledge_revision`;
const VALIDITY_LAPSED_FACTS_SQL = `SELECT count(*)::int AS n FROM facts WHERE valid_until <= now() AND expired_at IS NULL`;

/**
 * Live pages that keep their body in segments (doctor oversized_pages: the size scans pass them by). With
 * `projectionPending`, only those whose text projection is behind their knowledge revision (doctor
 * text_projection_readiness: not searchable yet).
 */
export async function countLiveSegmentedPages(raw: EngineRawRead, opts?: { projectionPending?: boolean }): Promise<number> {
  const [row] = await raw<{ n: number | string }>(opts?.projectionPending === true ? SEGMENTED_PROJECTION_PENDING_SQL : SEGMENTED_LIVE_SQL);
  return Number(row?.n ?? 0);
}

/** Facts whose validity window ended and that nothing expired yet (doctor memory_writeback: the read-time TTL count). */
export async function countValidityLapsedFacts(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ n: number | string }>(VALIDITY_LAPSED_FACTS_SQL);
  return Number(row?.n ?? 0);
}

/**
 * Timeline projections whose event page is soft-deleted (doctor chronicle_projection_health), counted over the event
 * pages of `sourceIds` (null: every source).
 */
export async function countOrphanEventProjections(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<number> {
  const inSources = sourceIds ? sqlFragment`AND ep.source_id = ANY(${[...sourceIds]}::text[])` : trustedSql('');
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM timeline_entries te
       JOIN pages ep ON ep.id = te.event_page_id
       WHERE te.event_page_id IS NOT NULL AND ep.deleted_at IS NOT NULL
         ${inSources}`);
  const [row] = await raw<{ n: number | string }>(text, params);
  return Number(row?.n ?? 0);
}
