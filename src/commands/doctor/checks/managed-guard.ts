import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { GUARDED_TABLES, PAGE_CHILD_TABLES } from '../../../core/persistence/writer-guard-schema.ts';

const RUNBOOK = 'docs/guides/write-refusals.md#managed-guard-page-children';

/**
 * Every column gbrain's own schema creates on a managed-writer-guarded table.
 * test/doctor-managed-guard.test.ts pins this list to the union of the
 * committed catalog goldens: a migration that adds a column to one of these
 * tables regenerates the goldens and then updates this list.
 */
export const GUARDED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pages: ['chunker_version', 'compiled_truth', 'content_hash', 'contextual_retrieval_mode', 'corpus_generation', 'created_at', 'database_only_reason',
    'deleted_at', 'effective_date', 'effective_date_source', 'embedding_signature', 'emotional_weight', 'emotional_weight_recomputed_at', 'frontmatter',
    'generation', 'id', 'import_filename', 'ingested_at', 'ingested_via', 'knowledge_revision', 'last_retrieved_at', 'links_attendance_blocked_at',
    'links_attendance_blocked_revision', 'links_extracted_at', 'page_kind', 'revision_principal_id', 'revision_principal_kind', 'revision_write_request_id',
    'salience_touched_at', 'search_vector', 'slug', 'source_id', 'source_kind', 'source_path', 'source_uri', 'text_projection_revision', 'timeline',
    'title', 'trust_tier', 'type', 'updated_at', 'write_origin'],
  tags: ['id', 'page_id', 'tag', 'tag_source'],
  slug_aliases: ['alias_slug', 'canonical_slug', 'created_at', 'id', 'notes', 'source_id'],
  page_aliases: ['alias_norm', 'alias_text', 'case_sensitive', 'created_at', 'id', 'origin', 'slug', 'source_id'],
  facts: ['attributed_to', 'claim_metric', 'claim_period', 'claim_unit', 'claim_value', 'confidence', 'consolidated_at', 'consolidated_into', 'context', 'created_at',
    'dim_status', 'dimension', 'embedded_at', 'embedded_text_hash', 'embedding', 'embedding_model', 'entity_slug', 'event_type', 'expired_at', 'fact',
    'id', 'kind', 'last_write_principal_id', 'last_write_principal_kind', 'last_write_request_id', 'last_written_at', 'notability', 'row_num', 'source',
    'source_id', 'source_markdown_slug', 'source_session', 'superseded_by', 'trust_tier', 'valid_from', 'valid_until', 'value', 'value_hash', 'visibility',
    'write_origin', 'write_principal_id', 'write_principal_kind', 'write_request_id'],
  takes: ['active', 'claim', 'created_at', 'embedded_at', 'embedded_text_hash', 'embedding', 'embedding_model', 'holder', 'id', 'kind',
    'last_write_principal_id', 'last_write_principal_kind', 'last_write_request_id', 'last_written_at', 'page_id', 'resolved_at', 'resolved_by',
    'resolved_outcome', 'resolved_quality', 'resolved_source', 'resolved_unit', 'resolved_value', 'row_num', 'since_date', 'source', 'superseded_by',
    'trust_tier', 'until_date', 'updated_at', 'weight', 'write_origin', 'write_principal_id', 'write_principal_kind', 'write_request_id'],
  timeline_entries: ['created_at', 'date', 'detail', 'event_page_id', 'id', 'last_write_principal_id', 'last_write_principal_kind', 'last_write_request_id',
    'last_written_at', 'page_id', 'source', 'summary', 'trust_tier', 'write_origin', 'write_principal_id', 'write_principal_kind', 'write_request_id'],
  sources: ['archive_expires_at', 'archived', 'archived_at', 'chunker_version', 'config', 'contextual_retrieval_mode', 'created_at', 'id', 'incarnation',
    'last_commit', 'last_sync_at', 'local_path', 'name', 'newest_content_at', 'trust_frontmatter_overrides', 'upstream_behind', 'upstream_checked_at',
    'upstream_commit'],
};

/**
 * #5983/#5974: a column gbrain never creates on a guarded table means another
 * tool or a manual migration changed the schema the managed-writer guard reads.
 * A `source_id` on tags, timeline_entries or takes made every coordinated write
 * to them fail before v0.60.38.0.
 */
export async function checkManagedGuardSchemaDrift(engine: BrainEngine): Promise<Check> {
  const name = 'managed_guard_schema_drift';
  try {
    const rows = await engine.executeRaw<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
       ORDER BY table_name,ordinal_position`, [[...GUARDED_TABLES]]);
    const extra = rows.filter(row => !GUARDED_TABLE_COLUMNS[row.table_name]?.includes(row.column_name)).map(row => `${row.table_name}.${row.column_name}`);
    const pageChildSource = extra.filter(column => PAGE_CHILD_TABLES.some(table => column === `${table}.source_id`));
    const details = { extra_columns: extra, page_child_source_columns: pageChildSource, runbook: RUNBOOK };
    if (!extra.length) return { name, status: 'ok', message: 'Guarded tables carry only the columns gbrain creates.', details };
    return { name, status: 'warn', details, message: `${extra.length} column(s) on managed-writer-guarded tables were not created by gbrain: ${extra.join(', ')}. `
      + (pageChildSource.length ? `${pageChildSource.join(', ')} made every coordinated tag, timeline or take write fail with writer_coordinator_required before v0.60.38.0; `
        + 'this release ignores it and resolves those rows through their page. ' : '')
      + 'Another tool or a manual migration changed this schema. Find out what added the columns before anything else writes there; '
      + `do not drop them without asking the user, because another tool may read them. Recovery after the fix: ${RUNBOOK}.` };
  } catch (error) {
    return { name, status: 'warn', message: `Guarded table columns could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown', runbook: RUNBOOK } };
  }
}

/** #5974: recent writes the database refused during preparation or publication. */
export async function checkPublicationRefusals(engine: BrainEngine): Promise<Check> {
  const name = 'publication_refusals';
  try {
    const [row] = await engine.executeRaw<{ guard: number; trigger: number; opaque: number }>(
      `SELECT COUNT(*) FILTER (WHERE error_code='writer_coordinator_required' AND error_detail->>'origin'='database_guard')::int AS guard,
              COUNT(*) FILTER (WHERE error_detail->>'origin'='database_trigger')::int AS trigger,
              COUNT(*) FILTER (WHERE error_detail IS NULL AND error_message LIKE 'Publication failed (P0001)%')::int AS opaque
       FROM persistence_requests WHERE state IN ('failed','conflict','recovering') AND COALESCE(completed_at,updated_at) > now()-interval '7 days'`);
    const details = { guard_refusals: row.guard, trigger_refusals: row.trigger, unclassified_p0001: row.opaque, window_days: 7, runbook: RUNBOOK };
    const total = row.guard + row.trigger + row.opaque;
    if (!total) return { name, status: 'ok', message: 'No write was refused by a database guard in the last 7 days.', details };
    return { name, status: 'warn', details, message: `${total} write(s) in the last 7 days were refused by the database and not committed `
      + `(${row.guard} by the managed-writer guard, ${row.trigger} by another trigger, ${row.opaque} recorded before refusals were classified). `
      + 'This is a gbrain defect, a schema change by another tool, or a version mismatch between gbrain processes, not a content conflict. '
      + 'Run gbrain sources writer status --probe --json and read recent_failures[].error_detail (table, operation, guard branch, executing build), '
      + `check managed_guard_schema_drift above, then follow ${RUNBOOK}. Retry each refused write with a new request ID after the cause is fixed.` };
  } catch (error) {
    return { name, status: 'warn', message: `Publication refusals could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown', runbook: RUNBOOK } };
  }
}
